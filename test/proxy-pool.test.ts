// Proxy failover: list parsing, hop probing, cursor rotation, settings
// resolution and the precedence that keeps single-URL installs unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { isDirectProxy, parseProxyList } from '../src/common/proxy-list.ts'
import {
  DEFAULT_PROXY_PROBE_MS,
  ProxyRotation,
  pickProxy,
  probeProxy,
  proxyCandidates,
  proxyRotationFor,
  proxyTarget,
  readProxySettings,
  resetProxyRotations,
  type ProxySettings,
} from '../src/host/proxy-pool.ts'

const SETTINGS: ProxySettings = { urls: [], probeMs: 200 }

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

test('ProxyRotation advance wraps around', () => {
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

test('readProxySettings: the env list wins and keeps the DIRECT sentinel', () => {
  const settings = readProxySettings({ DSH_AGY_PROXY_URLS: 'http://127.0.0.1:20122,' } as NodeJS.ProcessEnv)
  assert.deepEqual(settings.urls, ['http://127.0.0.1:20122', ''])
})

test('readProxySettings: probe budget comes from the env', () => {
  const settings = readProxySettings({ DSH_AGY_PROXY_PROBE_MS: '2500' } as NodeJS.ProcessEnv)
  assert.equal(settings.probeMs, 2_500)
})

test('readProxySettings: unusable values fall back to the default budget', () => {
  for (const raw of ['', '   ', 'abc', '0', '-5']) {
    const settings = readProxySettings({ DSH_AGY_PROXY_PROBE_MS: raw } as NodeJS.ProcessEnv)
    assert.equal(settings.probeMs, DEFAULT_PROXY_PROBE_MS)
  }
})

test('proxyCandidates: a dedicated account proxy wins over everything', () => {
  const settings: ProxySettings = { urls: ['http://list:1'], probeMs: 200 }
  assert.deepEqual(proxyCandidates(settings, 'http://account:1', 'http://single:1'), ['http://account:1'])
})

test('proxyCandidates: the failover list wins over the single proxyUrl', () => {
  const settings: ProxySettings = { urls: ['http://list:1', ''], probeMs: 200 }
  assert.deepEqual(proxyCandidates(settings, undefined, 'http://single:1'), ['http://list:1', ''])
})

test('proxyCandidates: a single proxyUrl still works on its own', () => {
  assert.deepEqual(proxyCandidates(SETTINGS, undefined, 'http://single:1'), ['http://single:1'])
})

test('pickProxy resolves through the list and skips the dead hop', async () => {
  resetProxyRotations()
  const port = await closedPort()
  const settings: ProxySettings = { urls: ['http://127.0.0.1:' + port, ''], probeMs: 300 }
  assert.equal(await pickProxy(undefined, undefined, settings), undefined)
})

test('pickProxy prefers an account proxy without touching the list', async () => {
  resetProxyRotations()
  const open = await openPort()
  try {
    const settings: ProxySettings = { urls: [''], probeMs: 300 }
    assert.equal(
      await pickProxy('http://127.0.0.1:' + open.port, undefined, settings),
      'http://127.0.0.1:' + open.port,
    )
  } finally {
    await open.close()
  }
})
