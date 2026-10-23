// Proxy failover list parsing (shared by config + host proxy rotation).
//
// A single proxyUrl is enough while exactly one hop exists. It stops being
// enough the moment the hop changes shape: a local client that is only running
// part of the day, a router-level proxy on the same machine, a VPN that drops.
// `proxyUrls` is that ordered list; an empty entry ("") means DIRECT, which is
// how "local client when it runs, plain routing when it does not" is written:
//
//   proxyUrls: ["http://127.0.0.1:20122", ""]
//
// Parsing lives in common/ so the config layer can normalize a list without
// importing the host-side rotation (which probes sockets).

/** The literal spellings people use for "no proxy here". */
const DIRECT_ALIASES: ReadonlySet<string> = new Set(['', 'direct', 'none', 'off'])

/**
 * Split a raw list into ordered, de-duplicated entries.
 *
 * Separators are comma, semicolon and newline (env vars and JSON strings both
 * arrive that way). "direct"/"none"/"off" normalize to the empty entry. A list
 * that contains nothing but blank entries means "not configured" and returns
 * an empty array, so a stray trailing comma cannot silently disable the proxy.
 */
export function parseProxyList(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[\n\r,;]+/)) {
    const trimmed = part.trim()
    const entry = DIRECT_ALIASES.has(trimmed.toLowerCase()) ? '' : trimmed
    if (out.includes(entry)) continue
    out.push(entry)
  }
  return out.every((entry) => entry === '') ? [] : out
}

/** True for the DIRECT sentinel (an empty hop). */
export function isDirectProxy(entry: string | undefined | null): boolean {
  return entry === undefined || entry === null || entry.trim() === ''
}
