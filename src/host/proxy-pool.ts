// Ordered proxy failover for agy spawns.
//
// agy is a Go binary: it honours HTTP(S)_PROXY / ALL_PROXY and nothing else, and
// a GUI host (DSH Desktop) does not inherit shell proxy env, so the plugin has
// to inject the hop itself. One fixed hop breaks the moment that hop stops
// existing — local client switched off, router-level proxy instead, VPN down —
// and the turn then dies on a dead port after the print-mode timeout.
//
// `proxyUrls` gives the spawn path an ordered candidate list: the first hop that
// answers a TCP probe wins, and a transport failure advances the cursor so the
// automatic retry runs on the next hop instead of dialling the same dead one.
// An empty entry ("") is DIRECT and always answers.
import { connect, type Socket } from 'node:net'
import type { PluginConfig } from '../common/types.ts'
import { isDirectProxy } from '../common/proxy-list.ts'
import { detectSystemProxy } from './wincred.ts'

/** Default TCP probe budget per hop. Local loopback answers in microseconds. */
export const DEFAULT_PROXY_PROBE_MS = 1_200

/** How long a successful probe is trusted before it is re-checked. */
const PROBE_TRUST_MS = 60_000

/** Parse `scheme://host:port` into a TCP target. Returns null for unusable entries. */
export function proxyTarget(url: string): { host: string; port: number } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'socks5:' && scheme !== 'socks5h:') {
    return null
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return null
  const port = parsed.port !== '' ? Number(parsed.port) : scheme === 'https:' ? 443 : 80
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null
  return { host, port }
}

/**
 * TCP-reachability probe for one hop.
 *
 * DIRECT ("") is always reachable. A malformed entry is never reachable, so it
 * cannot wedge every spawn behind a probe timeout. The probe only answers "is
 * something listening there" — it does not speak HTTP or SOCKS, which keeps it
 * protocol-agnostic and cheap enough to run before a spawn.
 */
export function probeProxy(url: string, timeoutMs: number): Promise<boolean> {
  if (isDirectProxy(url)) return Promise.resolve(true)
  const target = proxyTarget(url)
  if (target === null) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let socket: Socket | null = null
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        // already gone
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), Math.max(200, timeoutMs))
    timer.unref?.()
    try {
      socket = connect({ host: target.host, port: target.port })
    } catch {
      finish(false)
      return
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Cursor over an ordered hop list.
 *
 * `pick()` is what a spawn calls: it returns the first hop that answers, starting
 * from the cursor, and remembers the cursor so the next spawn starts there.
 * `advance()` is what a transport failure calls: it drops the failed hop's probe
 * trust and moves on, so the retry probes the next candidate first.
 */
export class ProxyRotation {
  private index = 0
  private readonly verified = new Map<string, number>()

  constructor(private readonly candidates: readonly string[]) {}

  get list(): readonly string[] {
    return this.candidates
  }

  /** Current hop as a proxy URL, or undefined for DIRECT / unconfigured. */
  current(): string | undefined {
    const entry = this.candidates[this.index]
    return isDirectProxy(entry) ? undefined : entry
  }

  /** Human-readable current hop, for logs (`direct` when there is none). */
  describe(): string {
    return this.current() ?? 'direct'
  }

  /** Move to the next hop (wrapping) and return it. */
  advance(): string | undefined {
    const size = this.candidates.length
    if (size === 0) return undefined
    const failed = this.candidates[this.index]
    if (failed !== undefined) this.verified.delete(failed)
    this.index = (this.index + 1) % size
    return this.current()
  }

  /**
   * First reachable hop from the cursor. Recently verified hops skip the probe.
   * When nothing answers, the current hop is returned anyway: agy then reports
   * the real transport error instead of the plugin inventing one.
   */
  async pick(probeMs: number = DEFAULT_PROXY_PROBE_MS, trustMs: number = PROBE_TRUST_MS): Promise<string | undefined> {
    const size = this.candidates.length
    if (size === 0) return undefined
    const now = Date.now()
    for (let step = 0; step < size; step++) {
      const index = (this.index + step) % size
      const entry = this.candidates[index] as string
      const seen = this.verified.get(entry)
      if (seen !== undefined && now - seen < trustMs) {
        this.index = index
        return isDirectProxy(entry) ? undefined : entry
      }
      if (await probeProxy(entry, probeMs)) {
        this.verified.set(entry, Date.now())
        this.index = index
        return isDirectProxy(entry) ? undefined : entry
      }
      this.verified.delete(entry)
    }
    return this.current()
  }
}

const rotations = new Map<string, ProxyRotation>()

/** One rotation per candidate list, so its cursor survives across spawns. */
export function proxyRotationFor(candidates: readonly string[]): ProxyRotation {
  const signature = candidates.join('\n')
  let rotation = rotations.get(signature)
  if (rotation === undefined) {
    if (rotations.size >= 16) rotations.clear()
    rotation = new ProxyRotation(candidates)
    rotations.set(signature, rotation)
  }
  return rotation
}

/** Drop every cached rotation (tests, or a config change that rewrites the list). */
export function resetProxyRotations(): void {
  rotations.clear()
}

/**
 * Effective hop list for one spawn.
 *
 * Precedence is unchanged from the single-URL era — a dedicated account proxy
 * wins, then the configured list, then the single `proxyUrl`, then the detected
 * system proxy — so an existing install behaves exactly as before until
 * `proxyUrls` is set.
 */
export function proxyCandidates(cfg: PluginConfig, accountProxy?: string): string[] {
  const dedicated = (accountProxy ?? '').trim()
  if (dedicated !== '') return [dedicated]
  const configured = (cfg.proxyUrls ?? []).filter((entry) => typeof entry === 'string')
  if (configured.length > 0) return [...configured]
  const single = (cfg.proxyUrl ?? '').trim()
  if (single !== '') return [single]
  const system = detectSystemProxy()
  return system !== undefined && system.trim() !== '' ? [system.trim()] : []
}
