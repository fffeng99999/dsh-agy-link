// Proxy failover: list parsing, hop probing, cursor rotation, settings
// resolution and the precedence that keeps single-URL installs unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { editorUrlFor, registerProxyRoutes } from '../src/host/proxy-ui.ts'

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

// ---- HTTP surface used by the in-plugin editor -----------------------------

/** Minimal stand-in for the host's ServerResponse. */
function fakeRes(): { res: unknown; done: Promise<{ status: number; body: string }> } {
  let settle: (value: { status: number; body: string }) => void = () => {}
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    settle = resolve
  })
  let status = 0
  const res = {
    writeHead(code: number) {
      status = code
    },
    end(body?: string | Buffer) {
      settle({ status, body: body === undefined ? '' : String(body) })
    },
  }
  return { res, done }
}

function routeHarness(method: string, body: Record<string, unknown> = {}) {
  const handlers = new Map<string, (req: unknown, res: unknown) => void>()
  registerProxyRoutes({
    reg: (route) => {
      handlers.set(route.path, route.handler)
    },
    readBody: async () => body,
    methodOf: () => method,
  })
  return handlers
}

/** Run one request against a route and resolve with its status + body. */
async function call(
  handlers: Map<string, (req: unknown, res: unknown) => void>,
  path: string,
): Promise<{ status: number; body: string }> {
  const handler = handlers.get(path)
  assert.ok(handler, 'route registered: ' + path)
  const { res, done } = fakeRes()
  handler({}, res)
  return done
}

async function withTempDshHome(run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-home-'))
  const previousHome = process.env.DSH_HOME
  const previousList = process.env.DSH_AGY_PROXY_URLS
  process.env.DSH_HOME = dir
  delete process.env.DSH_AGY_PROXY_URLS
  resetProxyRotations()
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousList !== undefined) process.env.DSH_AGY_PROXY_URLS = previousList
    resetProxyRotations()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('proxy-pool route: POST persists the list and GET reads it back', async () => {
  await withTempDshHome(async () => {
    const saved = await call(
      routeHarness('POST', { urls: ['http://127.0.0.1:20122', ''], probeMs: 900 }),
      '/plugins/agy-link/proxy-pool',
    )
    assert.equal(saved.status, 200)
    const savedBody = JSON.parse(saved.body) as { ok: boolean; urls: string[]; probeMs: number }
    assert.equal(savedBody.ok, true)
    assert.deepEqual(savedBody.urls, ['http://127.0.0.1:20122', ''])
    assert.equal(savedBody.probeMs, 900)

    const read = await call(routeHarness('GET'), '/plugins/agy-link/proxy-pool')
    assert.equal(read.status, 200)
    const readBody = JSON.parse(read.body) as { urls: string[]; probeMs: number; current: string }
    assert.deepEqual(readBody.urls, ['http://127.0.0.1:20122', ''])
    assert.equal(readBody.probeMs, 900)
    assert.equal(typeof readBody.current, 'string')
  })
})

test('proxy-pool route: rejects a list without any usable hop', async () => {
  await withTempDshHome(async () => {
    for (const urls of [[], [''], ['   ']]) {
      const res = await call(routeHarness('POST', { urls }), '/plugins/agy-link/proxy-pool')
      assert.equal(res.status, 400)
      const body = JSON.parse(res.body) as { ok: boolean; error: string }
      assert.equal(body.ok, false)
      assert.ok(body.error.length > 0)
    }
  })
})

test('proxy-pool route: rejects an unusable proxy URL', async () => {
  await withTempDshHome(async () => {
    const res = await call(
      routeHarness('POST', { urls: ['not-a-url'] }),
      '/plugins/agy-link/proxy-pool',
    )
    assert.equal(res.status, 400)
    assert.match(JSON.parse(res.body).error as string, /not a usable proxy URL/)
  })
})

test('proxy-pool route: clamps the probe budget into the accepted range', async () => {
  await withTempDshHome(async () => {
    const res = await call(
      routeHarness('POST', { urls: ['http://127.0.0.1:20122'], probeMs: 999_999 }),
      '/plugins/agy-link/proxy-pool',
    )
    assert.equal(res.status, 200)
    assert.equal((JSON.parse(res.body) as { probeMs: number }).probeMs, 30_000)
  })
})

test('proxy-ui route: serves the editor with the default probe budget inlined', async () => {
  const res = await call(routeHarness('GET'), '/plugins/agy-link/proxy-ui')
  assert.equal(res.status, 200)
  assert.match(res.body, /代理故障转移/)
  assert.ok(!res.body.includes('__DEFAULT_PROBE_MS__'))
  assert.ok(res.body.includes(String(DEFAULT_PROXY_PROBE_MS)))
})

test('editorUrlFor builds the editor URL from a loopback origin', () => {
  assert.equal(
    editorUrlFor('http://127.0.0.1:13320'),
    'http://127.0.0.1:13320/plugins/agy-link/proxy-ui',
  )
  assert.equal(
    editorUrlFor('http://localhost:9211/'),
    'http://localhost:9211/plugins/agy-link/proxy-ui',
  )
  // A path in the reported origin must not survive: the editor path is fixed.
  assert.equal(
    editorUrlFor('http://127.0.0.1:13320/some/deep/route'),
    'http://127.0.0.1:13320/plugins/agy-link/proxy-ui',
  )
})

test('editorUrlFor refuses anything that is not a loopback http(s) origin', () => {
  for (const origin of [
    'http://evil.example.com',
    'https://10.0.0.2:8443',
    'file:///C:/Windows',
    'javascript:alert(1)',
    '',
    '   ',
    undefined,
    null,
    42,
  ]) {
    assert.equal(editorUrlFor(origin), null, String(origin))
  }
})

test('open-proxy-ui route: POST only, and only for a loopback origin', async () => {
  const wrongMethod = await call(routeHarness('GET'), '/plugins/agy-link/open-proxy-ui')
  assert.equal(wrongMethod.status, 405)

  const badOrigin = await call(
    routeHarness('POST', { origin: 'http://evil.example.com' }),
    '/plugins/agy-link/open-proxy-ui',
  )
  assert.equal(badOrigin.status, 400)
  assert.equal((JSON.parse(badOrigin.body) as { ok: boolean }).ok, false)
})
