// Ordered proxy failover for agy spawns — self-contained on purpose.
//
// This file is the whole feature: it reads its own configuration, probes the
// hops and hands back the URL to spawn with. Nothing upstream had to grow a
// config key for it, which keeps `git merge upstream/main` cheap — the only
// edit outside this module is the single `pickProxy(...)` call site.
//
// Why it exists: agy is a Go binary that honours HTTP(S)_PROXY / ALL_PROXY and
// nothing else, and a GUI host (DSH Desktop) inherits no shell proxy env, so
// the plugin has to inject the hop itself. One fixed hop breaks the moment that
// hop is only intermittent — local client switched off, router-level proxy
// instead, VPN dropped — and the turn then dies on a dead port after the
// print-mode timeout, with the only remedy being a hand-edited config.
//
// Configuration (first match wins, no upstream config key involved):
//   1. env `DSH_AGY_PROXY_URLS`  — "http://127.0.0.1:20122,"
//   2. env `DSH_AGY_PROXY_PROBE_MS`
//   3. `<stateDir>/proxy-pool.json` — { "urls": ["http://127.0.0.1:20122", ""], "probeMs": 1200 }
// An empty entry ("") is DIRECT and always answers, so
// `["http://127.0.0.1:20122", ""]` reads as "local client when it runs, plain
// routing when it does not".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { stateDir } from '../common/config.ts'
import { isDirectProxy, parseProxyList } from '../common/proxy-list.ts'
import { detectSystemProxy } from './wincred.ts'

/** Default TCP probe budget per hop. Local loopback answers in microseconds. */
export const DEFAULT_PROXY_PROBE_MS = 1_200

export interface ProxySettings {
  /** Ordered hops; an empty string entry means DIRECT. */
  readonly urls: readonly string[]
  /** TCP probe budget per hop (ms). */
  readonly probeMs: number
}

/** `<stateDir>/proxy-pool.json` — the file form of the same two settings. */
export function proxySettingsPath(): string {
  return join(stateDir(), 'proxy-pool.json')
}

function readSettingsFile(): Partial<ProxySettings> {
  try {
    const raw = JSON.parse(readFileSync(proxySettingsPath(), 'utf8')) as {
      urls?: unknown
      probeMs?: unknown
    }
    const urls = Array.isArray(raw.urls)
      ? parseProxyList(raw.urls.filter((x): x is string => typeof x === 'string').join(','))
      : undefined
    const probeMs =
      typeof raw.probeMs === 'number' && Number.isFinite(raw.probeMs) && raw.probeMs > 0
        ? raw.probeMs
        : undefined
    return { urls, probeMs }
  } catch {
    return {}
  }
}

/**
 * Resolve the failover configuration. Read on every call (cheap: one env lookup,
 * and a file read only when the env is silent), so editing either source takes
 * effect on the next spawn without a plugin reload.
 */
export function readProxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings {
  const file = readSettingsFile()
  const envList = env.DSH_AGY_PROXY_URLS
  const urls = envList !== undefined && envList.trim() !== ''
    ? parseProxyList(envList)
    : file.urls ?? []
  const envProbe = env.DSH_AGY_PROXY_PROBE_MS
  const parsedProbe = envProbe !== undefined && envProbe.trim() !== '' ? Number(envProbe) : Number.NaN
  const probeMs = Number.isFinite(parsedProbe) && parsedProbe > 0
    ? parsedProbe
    : file.probeMs ?? DEFAULT_PROXY_PROBE_MS
  return { urls, probeMs }
}

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
 * protocol-agnostic and cheap enough to run before every spawn.
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
 * `pick()` is what a spawn calls: it returns the first hop that answers,
 * starting from the cursor, and remembers the cursor so the next spawn starts
 * there. Because every spawn re-probes, a hop that disappeared (local client
 * switched off) is skipped on the very next turn without any config edit.
 */
export class ProxyRotation {
  private index = 0

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
    this.index = (this.index + 1) % size
    return this.current()
  }

  /**
   * First reachable hop from the cursor. When nothing answers, the current hop
   * is returned anyway: agy then reports the real transport error instead of
   * the plugin inventing one.
   */
  async pick(probeMs: number = DEFAULT_PROXY_PROBE_MS): Promise<string | undefined> {
    const size = this.candidates.length
    if (size === 0) return undefined
    for (let step = 0; step < size; step++) {
      const index = (this.index + step) % size
      const entry = this.candidates[index] as string
      if (await probeProxy(entry, probeMs)) {
        this.index = index
        return isDirectProxy(entry) ? undefined : entry
      }
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

/** Drop every cached rotation (tests, or a deliberate reset). */
export function resetProxyRotations(): void {
  rotations.clear()
}

/**
 * Effective hop list for one spawn.
 *
 * Precedence is unchanged from the single-URL era — a dedicated account proxy
 * wins, then the failover list, then the single configured `proxyUrl`, then the
 * detected system proxy — so an existing install behaves exactly as before
 * until a list is configured.
 */
export function proxyCandidates(
  settings: ProxySettings,
  accountProxy?: string,
  singleProxy?: string,
): string[] {
  const dedicated = (accountProxy ?? '').trim()
  if (dedicated !== '') return [dedicated]
  if (settings.urls.length > 0) return [...settings.urls]
  const single = (singleProxy ?? '').trim()
  if (single !== '') return [single]
  const system = detectSystemProxy()
  return system !== undefined && system.trim() !== '' ? [system.trim()] : []
}

/**
 * The one call site the adapter needs: resolve the list, probe it, and return
 * the hop to spawn with (`undefined` = no proxy env at all).
 */
export async function pickProxy(
  accountProxy?: string,
  singleProxy?: string,
  settings: ProxySettings = readProxySettings(),
): Promise<string | undefined> {
  const rotation = proxyRotationFor(proxyCandidates(settings, accountProxy, singleProxy))
  return rotation.pick(settings.probeMs)
}
