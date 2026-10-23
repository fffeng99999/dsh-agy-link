// In-plugin editor for the proxy failover list.
//
// Deliberately a route + a self-contained page instead of a panel inside the
// React client: `src/client/index.ts` is the file upstream rewrites most often,
// and the whole point of this fork is that `git merge upstream/main` stays
// cheap. A page served from the host needs no client build step and no client
// edit at all — the two lines in index.ts are the entire integration.
//
// GET  /plugins/agy-link/proxy-pool  → { urls, probeMs, current, path }
// POST /plugins/agy-link/proxy-pool  ← { urls, probeMs }
// GET  /plugins/agy-link/proxy-ui    → the editor
// POST /plugins/agy-link/open-proxy-ui ← { origin }  (opens the editor in the OS browser)
import { spawn } from 'node:child_process'
import { proxyRotationFor, proxySettingsPath, proxyTarget, readProxySettings, writeProxySettings, DEFAULT_PROXY_PROBE_MS } from './proxy-pool.ts'
import { isDirectProxy } from '../common/proxy-list.ts'

/** Largest list the editor accepts; more hops than this is a configuration smell. */
const MAX_HOPS = 16
const MIN_PROBE_MS = 200
const MAX_PROBE_MS = 30_000

interface RawResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string | Buffer): void
}

export interface ProxyRouteDeps {
  reg: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => void
  readBody: (req: unknown) => Promise<Record<string, unknown>>
  methodOf: (req: unknown) => string
}

function writeJson(res: unknown, status: number, body: unknown): void {
  const raw = res as RawResponse
  raw.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  raw.end(JSON.stringify(body))
}

function writeHtml(res: unknown, html: string): void {
  const raw = res as RawResponse
  raw.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  raw.end(html)
}

/**
 * Build the editor URL from the origin the browser reports.
 *
 * Loopback only: this string is handed to the OS opener, so anything that is
 * not `http(s)://127.0.0.1|localhost|::1:<port>` is refused rather than
 * forwarded. The path is fixed, so the caller cannot smuggle one in.
 */
export function editorUrlFor(origin: unknown): string | null {
  if (typeof origin !== 'string' || origin.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(origin.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
  return parsed.origin + '/plugins/agy-link/proxy-ui'
}

/**
 * Hand a URL to the OS default browser.
 *
 * The DSH desktop shell is an Electron webview with no window-open handler, so
 * `window.open` from the client silently does nothing (the first version of the
 * settings link did exactly that and was dead on click). The host can always
 * spawn the platform opener instead.
 */
export function openInBrowser(url: string): boolean {
  const isWin = process.platform === 'win32'
  const file = isWin ? process.env.ComSpec ?? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args: string[] = isWin ? ['/d', '/s', '/c', 'start', '', url] : [url]
  try {
    const child = spawn(file, args, { windowsHide: true, detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Validate one submitted list; returns an error string or the normalized list. */
function normalizeSubmitted(value: unknown): { urls: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'urls must be an array' }
  if (value.length > MAX_HOPS) return { error: `at most ${MAX_HOPS} hops` }
  const urls: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { error: 'every hop must be a string' }
    const trimmed = entry.trim()
    if (isDirectProxy(trimmed)) {
      urls.push('')
      continue
    }
    if (proxyTarget(trimmed) === null) {
      return { error: `not a usable proxy URL: ${trimmed} (http:// or socks5:// with a port)` }
    }
    urls.push(trimmed)
  }
  // A list of only blank entries means "no failover configured" — reject it so a
  // stray save cannot silently disable the proxy.
  if (urls.every((entry) => entry === '')) return { error: 'add at least one proxy URL' }
  return { urls }
}

export function registerProxyRoutes(deps: ProxyRouteDeps): void {
  deps.reg({
    kind: 'exact',
    path: '/plugins/agy-link/proxy-pool',
    handler: (req, res) => {
      void (async () => {
        if (deps.methodOf(req) === 'POST') {
          const body = await deps.readBody(req)
          const normalized = normalizeSubmitted(body.urls)
          if ('error' in normalized) {
            writeJson(res, 400, { ok: false, error: normalized.error })
            return
          }
          const probeRaw = body.probeMs
          const probeMs =
            typeof probeRaw === 'number' && Number.isFinite(probeRaw)
              ? Math.min(MAX_PROBE_MS, Math.max(MIN_PROBE_MS, Math.round(probeRaw)))
              : readProxySettings().probeMs
          writeProxySettings({ urls: normalized.urls, probeMs })
          writeJson(res, 200, {
            ok: true,
            urls: normalized.urls,
            probeMs,
            path: proxySettingsPath(),
          })
          return
        }
        const settings = readProxySettings()
        const rotation = proxyRotationFor(settings.urls)
        writeJson(res, 200, {
          urls: settings.urls,
          probeMs: settings.probeMs,
          current: rotation.describe(),
          path: proxySettingsPath(),
        })
      })()
    },
  })

  deps.reg({
    kind: 'exact',
    path: '/plugins/agy-link/proxy-ui',
    handler: (_req, res) => {
      writeHtml(res, PROXY_UI_HTML.replaceAll('__DEFAULT_PROBE_MS__', String(DEFAULT_PROXY_PROBE_MS)))
    },
  })

  deps.reg({
    kind: 'exact',
    path: '/plugins/agy-link/open-proxy-ui',
    handler: (req, res) => {
      void (async () => {
        if (deps.methodOf(req) !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'POST only' })
          return
        }
        const body = await deps.readBody(req)
        const url = editorUrlFor(body.origin)
        if (url === null) {
          writeJson(res, 400, { ok: false, error: 'origin must be a loopback http(s) URL' })
          return
        }
        const opened = openInBrowser(url)
        writeJson(res, opened ? 200 : 500, { ok: opened, url })
      })()
    },
  })
}

/**
 * The editor page. Vanilla JS, no build step, no dependency on the client
 * bundle — it talks to the two routes above and nothing else.
 */
export const PROXY_UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agy-link · 代理故障转移</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px;
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #14161a; color: #e6e8eb;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 650; }
  .sub { color: #8b93a1; font-size: 12.5px; margin-bottom: 18px; }
  .sub code { background: #1e222a; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  .card { background: #1b1f26; border: 1px solid #2a303a; border-radius: 10px; padding: 14px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px dashed #262c35; }
  .row:last-child { border-bottom: 0; }
  .idx { width: 22px; color: #6f7887; font-variant-numeric: tabular-nums; font-size: 12px; }
  .url { flex: 1; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  .url.direct { color: #7f8a99; font-style: italic; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid #2f3946; color: #8b93a1; }
  button {
    font: inherit; font-size: 12.5px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
    background: #232833; color: #dfe3e8; border: 1px solid #313846;
  }
  button:hover:not(:disabled) { background: #2b3140; }
  button:disabled { opacity: .45; cursor: default; }
  button.icon { padding: 3px 7px; font-size: 12px; }
  button.primary { background: #3b6ef5; border-color: #3b6ef5; color: #fff; }
  button.primary:hover:not(:disabled) { background: #4b7bf7; }
  button.danger { color: #f08a8a; border-color: #4a2f33; }
  .add { display: flex; gap: 8px; margin-top: 12px; }
  input[type=text], input[type=number] {
    flex: 1; font: inherit; font-size: 12.5px; padding: 7px 10px; border-radius: 7px;
    background: #12151a; color: #e6e8eb; border: 1px solid #2c333e;
  }
  input[type=number] { flex: 0 0 110px; }
  .foot { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  .status { font-size: 12.5px; color: #8b93a1; flex: 1; }
  .status.err { color: #f08a8a; }
  .status.ok { color: #6fcf97; }
  .hint { margin-top: 14px; font-size: 12px; color: #77808f; }
  .empty { color: #77808f; padding: 10px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>代理故障转移</h1>
  <div class="sub">
    按顺序探测，用第一个能连上的。空项表示<b>直连</b>（本机客户端关掉、走路由器代理时用）。<br>
    落盘：<code id="path">—</code>
  </div>

  <div class="card">
    <div id="list"></div>
    <div class="add">
      <input id="draft" type="text" placeholder="http://127.0.0.1:20122 或 socks5://10.0.0.2:1080">
      <button id="addBtn">添加</button>
      <button id="addDirect" title="追加一个直连项">+ 直连</button>
    </div>
    <div class="foot">
      <span class="status" id="status">加载中…</span>
      <label style="font-size:12px;color:#8b93a1">探测超时
        <input id="probe" type="number" min="200" max="30000" step="100" value="__DEFAULT_PROBE_MS__" style="width:90px;margin-left:6px">
        ms
      </label>
      <button class="primary" id="save">保存</button>
    </div>
  </div>

  <div class="hint">
    当前生效：<span id="current">—</span>。改完保存后下一次对话即生效，无需重启。
    账号卡片上的「专属代理」优先级更高，填了会盖掉这个列表。
  </div>
</div>

<script>
(function () {
  var urls = [];
  var probeMs = __DEFAULT_PROBE_MS__;
  var listEl = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var probeEl = document.getElementById('probe');
  var pathEl = document.getElementById('path');
  var currentEl = document.getElementById('current');
  var draftEl = document.getElementById('draft');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function render() {
    listEl.textContent = '';
    if (urls.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有配置，点下面「添加」或「+ 直连」。';
      listEl.appendChild(empty);
      return;
    }
    urls.forEach(function (url, i) {
      var row = document.createElement('div');
      row.className = 'row';

      var idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      row.appendChild(idx);

      var label = document.createElement('span');
      label.className = 'url' + (url === '' ? ' direct' : '');
      label.textContent = url === '' ? '直连（不使用代理）' : url;
      row.appendChild(label);

      if (i === 0) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '优先';
        row.appendChild(tag);
      }

      var up = document.createElement('button');
      up.className = 'icon';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.onclick = function () { move(i, -1); };
      row.appendChild(up);

      var down = document.createElement('button');
      down.className = 'icon';
      down.textContent = '↓';
      down.disabled = i === urls.length - 1;
      down.onclick = function () { move(i, 1); };
      row.appendChild(down);

      var del = document.createElement('button');
      del.className = 'icon danger';
      del.textContent = '✕';
      del.onclick = function () { urls.splice(i, 1); render(); };
      row.appendChild(del);

      listEl.appendChild(row);
    });
  }

  function move(from, delta) {
    var to = from + delta;
    if (to < 0 || to >= urls.length) return;
    var tmp = urls[from];
    urls[from] = urls[to];
    urls[to] = tmp;
    render();
  }

  function load() {
    fetch('/plugins/agy-link/proxy-pool', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        urls = Array.isArray(data.urls) ? data.urls.slice() : [];
        if (typeof data.probeMs === 'number') { probeMs = data.probeMs; probeEl.value = String(probeMs); }
        pathEl.textContent = data.path || '—';
        currentEl.textContent = data.current || 'direct';
        setStatus('已加载 ' + urls.length + ' 项');
        render();
      })
      .catch(function (e) { setStatus('加载失败：' + e, 'err'); });
  }

  function save() {
    var body = { urls: urls, probeMs: Number(probeEl.value) || probeMs };
    setStatus('保存中…');
    fetch('/plugins/agy-link/proxy-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.ok) {
          setStatus(res.data && res.data.error ? res.data.error : '保存失败', 'err');
          return;
        }
        urls = res.data.urls.slice();
        probeMs = res.data.probeMs;
        probeEl.value = String(probeMs);
        setStatus('已保存，下次对话生效', 'ok');
        render();
      })
      .catch(function (e) { setStatus('保存失败：' + e, 'err'); });
  }

  document.getElementById('addBtn').onclick = function () {
    var v = draftEl.value.trim();
    if (v === '') return;
    urls.push(v);
    draftEl.value = '';
    render();
  };
  document.getElementById('addDirect').onclick = function () { urls.push(''); render(); };
  document.getElementById('save').onclick = save;
  draftEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('addBtn').click(); });

  load();
})();
</script>
</body>
</html>`
