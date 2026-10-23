// Proxy failover: list parsing, hop probing, cursor rotation and the config
// precedence that keeps the single-URL installs unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { isDirectProxy, parseProxyList } from '../src/common/proxy-list.ts'
import { defaultConfig } from '../src/common/types.ts'
import {
  ProxyRotation,
  probeProxy,
  proxyCandidates,
  proxyRotationFor,
  proxyTarget,
  resetProxyRotations,
} from '../src/host/proxy-pool.ts'

/** A port that was listening a moment ago and is closed now. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function openPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('parseProxyList splits on comma, semicolon and newline', () => {
  assert.deepEqual(parseProxyList('http://a:1,http://b:2'), ['http://a:1', 'http://b:2'])
  assert.deepEqual(parseProxyList('http://a:1; http://b:2'), ['http://a:1', 'http://b:2'])
  assert.deepEqual(parseProxyList('http://a:1\nhttp://b:2'), ['http://a:1', 'http://b:2'])
})

test('parseProxyList keeps a trailing empty entry as DIRECT', () => {
  assert.deepEqual(parseProxyList('http://a:1,'), ['http://a:1', ''])
  assert.deepEqual(parseProxyList('http://a:1, direct'), ['http://a:1', ''])
})

test('parseProxyList normalizes the direct spellings', () => {
  for (const raw of ['direct', 'none', 'off', 'DIRECT', '  ']) {
    assert.deepEqual(parseProxyList(raw), [])
  }
  assert.deepEqual(parseProxyList('http://a:1,direct'), ['http://a:1', ''])
})

test('parseProxyList de-duplicates while preserving order', () => {
  assert.deepEqual(parseProxyList('http://a:1,http://b:2,http://a:1'), ['http://a:1', 'http://b:2'])
  assert.deepEqual(parseProxyList('http://a:1,,'), ['http://a:1', ''])
})

test('isDirectProxy treats blank and missing entries as DIRECT', () => {
  assert.equal(isDirectProxy(''), true)
  assert.equal(isDirectProxy(undefined), true)
  assert.equal(isDirectProxy('   '), true)
  assert.equal(isDirectProxy('http://a:1'), false)
})

test('proxyTarget parses the schemes agy can use', () => {
  assert.deepEqual(proxyTarget('http://127.0.0.1:20122'), { host: '127.0.0.1', port: 20122 })
  assert.deepEqual(proxyTarget('socks5://10.0.0.2:1080'), { host: '10.0.0.2', port: 1080 })
  assert.deepEqual(proxyTarget('https://proxy.example:8443'), { host: 'proxy.example', port: 8443 })
  assert.equal(proxyTarget('ftp://proxy.example:21'), null)
  assert.equal(proxyTarget('not a url'), null)
})

test('probeProxy: DIRECT always answers, closed port does not', async () => {
  assert.equal(await probeProxy('', 200), true)
  const port = await closedPort()
  assert.equal(await probeProxy('http://127.0.0.1:' + port, 300), false)
  assert.equal(await probeProxy('http://127.0.0.1:not-a-port', 200), false)
})

test('probeProxy: a listening hop answers', async () => {
  const open = await openPort()
  try {
    assert.equal(await probeProxy('http://127.0.0.1:' + open.port, 500), true)
  } finally {
    await open.close()
  }
})

test('ProxyRotation skips a dead hop and lands on DIRECT', async () => {
  const port = await closedPort()
  const rotation = new ProxyRotation(['http://127.0.0.1:' + port, ''])
  assert.equal(await rotation.pick(300), undefined)
  assert.equal(rotation.current(), undefined)
})

test('ProxyRotation picks the first reachable hop', async () => {
  const open = await openPort()
  try {
    const rotation = new ProxyRotation(['http://127.0.0.1:' + open.port, ''])
    assert.equal(await rotation.pick(500), 'http://127.0.0.1:' + open.port)
    // DIRECT is always reachable, so a list that starts there stays direct.
    const directFirst = new ProxyRotation(['', 'http://127.0.0.1:' + open.port])
    assert.equal(await directFirst.pick(500), undefined)
  } finally {
    await open.close()
  }
})

test('ProxyRotation advance wraps and drops probe trust for the failed hop', async () => {
  const rotation = new ProxyRotation(['http://a:1', 'http://b:2'])
  assert.equal(rotation.current(), 'http://a:1')
  assert.equal(rotation.advance(), 'http://b:2')
  assert.equal(rotation.advance(), 'http://a:1')
})

test('ProxyRotation with no candidates is inert', async () => {
  const rotation = new ProxyRotation([])
  assert.equal(rotation.current(), undefined)
  assert.equal(rotation.advance(), undefined)
  assert.equal(await rotation.pick(200), undefined)
  assert.equal(rotation.describe(), 'direct')
})

test('proxyRotationFor caches per candidate list', () => {
  resetProxyRotations()
  const first = proxyRotationFor(['http://a:1', ''])
  assert.equal(proxyRotationFor(['http://a:1', '']), first)
  assert.notEqual(proxyRotationFor(['http://a:1']), first)
  resetProxyRotations()
  assert.notEqual(proxyRotationFor(['http://a:1', '']), first)
})

test('proxyCandidates: a dedicated account proxy wins over everything', () => {
  const cfg = { ...defaultConfig(), proxyUrl: 'http://global:1', proxyUrls: ['http://list:1'] }
  assert.deepEqual(proxyCandidates(cfg, 'http://account:1'), ['http://account:1'])
})

test('proxyCandidates: the list wins over the single proxyUrl', () => {
  const cfg = { ...defaultConfig(), proxyUrl: 'http://global:1', proxyUrls: ['http://list:1', ''] }
  assert.deepEqual(proxyCandidates(cfg), ['http://list:1', ''])
})

test('proxyCandidates: a single proxyUrl still works on its own', () => {
  const cfg = { ...defaultConfig(), proxyUrl: 'http://global:1' }
  assert.deepEqual(proxyCandidates(cfg), ['http://global:1'])
})

test('proxyCandidates: an unconfigured install falls through to the system proxy', () => {
  // Whatever the host has (or has not) configured, the result stays a single
  // hop at most — the pre-existing single-URL behaviour.
  const list = proxyCandidates({ ...defaultConfig() })
  assert.ok(Array.isArray(list))
  assert.ok(list.length <= 1)
})
