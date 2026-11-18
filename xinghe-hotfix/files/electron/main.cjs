'use strict';
/**
 * MJStudio —— 独立桌面壳（不依赖、不修改 mirrorflow）
 *
 * 设计目标：让「漫剧分镜台」的前端资源（app/ 下的 dist）在独立壳里原样运行，
 * 桥接层按它原有的 window.electronAPI / flygen / coreBridge 契约实现。
 *
 * 关键约定：
 *  - 所有数据写 %APPDATA%/MJStudio/，绝不写星核的目录
 *  - 不 require mirrorflow 的任何文件（P2 阶段才会以只读方式接入）
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { buildPrompt } = require('./prompt-builders.cjs');
const doubaoHelper = require('./doubao-helper.cjs');
// 一机一码授权（独立于星核 SynCore 的一套密钥，详见 license.cjs 顶部说明）
const lic = require('./license.cjs');
// 在线热更新（清单签名 + 文件校验 + 备份回滚，详见 updater.cjs 顶部说明）
const updater = require('./updater.cjs');

/* ---- 显示名 与 数据目录 是两件事 ----
 * APP_NAME（显示名）随便改：窗口标题、任务栏、桌面快捷方式都跟着它。
 * APP_ID（数据目录）永远不要改：Electron 的 userData/localStorage 按名字落盘，
 * 一改就等于换了个新软件，已存的设置、侧边栏菜单、登录态全部丢失。 */
const APP_ID = 'MJStudio';
const APP_NAME = '星核AIGC';
app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_ID));
app.setAppUserModelId('com.xinghe.aigc');

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, '..', 'app');
// XH_DATA_DIR：绿色版 / 冒烟测试用，指到别的目录就能模拟一台全新电脑
const DATA_DIR = process.env.XH_DATA_DIR
  ? path.resolve(process.env.XH_DATA_DIR)
  : path.join(app.getPath('appData'), APP_ID);
// 授权文件（license.json / machine.json / revoked.json）落在数据目录，跟作品数据同一层
lic.init(DATA_DIR);
/* 渠道开关：作者本机 = 开发者版，客户机 = 正式版。
 * 用 try/catch 懒加载：万一热更时 dev-mode.cjs 没下来，也不能让客户版起不来，
 * 缺文件就安全退化成正式版。标记放数据目录，不在安装包/热更包里。 */
let devMode = {
  enabled: () => false, channel: () => 'release', label: () => '正式版',
  title: (n) => n, state: () => ({ enabled: false, source: 'default', versionSuffix: '' }),
  cfgFile: () => '',
};
try {
  devMode = require('./dev-mode.cjs');
  devMode.init(DATA_DIR, path.join(ROOT, '..'));
} catch (e) { /* 缺模块一律正式版 */ }
const ICON_PNG = path.join(APP_DIR, 'branding', 'xinghe-aigc-v3.png');
const ICON_ICO = path.join(APP_DIR, 'branding', 'xinghe-aigc-v3.ico');
const WINDOW_ICON = fs.existsSync(ICON_PNG) ? ICON_PNG : undefined;
const LOG_DIR = path.join(DATA_DIR, 'logs');
/* 为什么在这里建目录：XH_DATA_DIR 指向新目录时 logs 子目录不存在，
 * appendFileSync 会被 catch 吞掉，整场启动一条日志都不留，排障全靠猜。 */
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

const PROBE = process.env.MJ_PROBE === '1';
// 单实例：重复双击桌面图标时不再起第二个进程抢 17900 端口，而是把已有窗口拉到前面
const HAS_LOCK = PROBE || process.env.MJ_ALLOW_MULTI === '1' || process.env.MJ_MAKE_SHORTCUT === '1'
  ? true
  : app.requestSingleInstanceLock();
if (!HAS_LOCK) {
  console.log('[MJStudio] another instance is running, this one will exit');
}
app.on('second-instance', () => {
  try {
    /* 窗口已经销毁但进程还活着（关窗时被「还有图片在传」拦下、用户选了继续等待，
     * 或者渲染进程挂了）—— 这时候只 show() 是没用的，win 是个死对象，
     * 用户看到的就是「双击图标没反应、软件打不开」。必须重新建一个窗口。 */
    if (!win || win.isDestroyed()) {
      log('[instance] 已有进程但没有窗口，重建主窗口');
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (e) {
    log('[instance] 拉起窗口失败', (e && e.message) || e);
  }
});
const PORT = Number(process.env.MJ_PORT || 17900);
const PROXY_PORT = Number(process.env.MJ_PROXY_PORT || (PORT + 1));
const logFile = path.join(LOG_DIR, 'shell.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
  console.log(line);
}

/* ---------------- 静态服务：把 app/ 当站点根 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/* ---------------- 本地文件协议 xingyuan-file:// ----------------
 * 原版前端把本地绝对路径统一映射成 xingyuan-file:///C:/... 交给 <img>/<video>/<audio>，
 * 这是它自己的 scheme，必须由壳层注册，否则所有本地图片与视频一律加载失败
 * （实测分镜工作台 85 张图有 84 张挂掉，控制台刷 IMAGE_LOAD_ERROR）。
 * 必须在 app ready 之前声明 privileges。 */
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'xingyuan-file',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
  ]);
} catch (err) {
  log('registerSchemesAsPrivileged failed', err && err.message);
}

/** xingyuan-file:///C:/a.png / xingyuan-file://///C:/a.png / xingyuan-file://C:/a.png → 本地路径 */
function resolveXingyuanPath(rawUrl) {
  const raw = String(rawUrl || '');
  if (!/^xingyuan-file:/i.test(raw)) return '';
  let rest = raw.replace(/^xingyuan-file:/i, '');
  // 前端 Pt() 给「刚重新生成」的缩略图加 ?v=时间戳 防缓存，#片段同理。
  // 它们不属于文件名，必须在解码前剥掉；否则 fs.statSync 会把 ?v= 当文件名 → 404 → 列表破图
  // （点开的大图走另一条不带参数的路径，所以能正常显示，看起来就像「图丢了」）。
  const q = rest.search(/[?#]/);
  if (q >= 0) rest = rest.slice(0, q);
  // 统计前导斜杠数量，用于区分 Windows 盘符路径 / UNC / POSIX 绝对路径
  const lead = (rest.match(/^\/+/) || [''])[0].length;
  try { rest = decodeURIComponent(rest); } catch { /* 保留原样 */ }
  let p = rest.replace(/^\/+/, '');

  if (/^[A-Za-z]:[\\/]/.test(p)) {
    // Windows 绝对路径，例如 C:/Users/x.png
    return p.replace(/\//g, '\\');
  }
  if (/^[A-Za-z]\//.test(p)) {
    // standard scheme 会把 xingyuan-file:///C:/x 规范化成 xingyuan-file://c/x，
    // 盘符被吃成 host 且被小写化，这里补回来
    return (p[0].toUpperCase() + ':' + p.slice(1)).replace(/\//g, '\\');
  }
  if (lead === 2 && p) {
    // UNC：xingyuan-file://server/share/a.png
    return '\\\\' + p.replace(/\//g, '\\');
  }
  if (!p) return '';
  // 其余按 POSIX 绝对路径处理
  return '/' + p.replace(/\\/g, '/');
}

function registerLocalFileProtocol() {
  protocol.handle('xingyuan-file', (request) => {
    const file = resolveXingyuanPath(request.url);
    if (!file) {
      if (PROBE) log('xingyuan-file bad url', String(request.url).slice(0, 160));
      return new Response('bad path', { status: 400 });
    }
    let st = null;
    try { st = fs.statSync(file); } catch { /* 落到下面 404 */ }
    if (!st || !st.isFile()) {
      if (PROBE) log('xingyuan-file 404', file);
      return new Response('not found: ' + file, { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(st.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  });
  log('xingyuan-file protocol registered');
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        let rel = decodeURIComponent((req.url || '/').split('?')[0]);
        if (rel === '/' || rel === '') rel = '/index.html';
        // 厂商云端提示词接口：无论前端把它发往静态源站还是本地代理，都本地兜底返回内置提示词
        if (/\/allPrompt/i.test(rel)) {
          try {
            const prompts = readJson(path.join(ROOT, '..', 'data', 'local-prompts.json'), {});
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(prompts));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: String(err && err.message) }));
          }
          return;
        }
        const file = path.join(APP_DIR, rel);
        if (PROBE && !fs.existsSync(file) && !rel.startsWith('/assets/') && !rel.startsWith('/branding/')) {
          log('static miss', req.method, (req.url || '').slice(0, 160));
        }
        if (!file.startsWith(APP_DIR)) { res.writeHead(403).end('forbidden'); return; }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          // SPA 兜底：未知路径回 index.html
          const idx = path.join(APP_DIR, 'index.html');
          if (fs.existsSync(idx)) {
            res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
            res.end(fs.readFileSync(idx));
            return;
          }
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
      } catch (err) {
        res.writeHead(500).end(String(err && err.message));
      }
    });
    server.on('error', (err) => { log('static server error', err.message); resolve(null); });
    server.listen(PORT, '127.0.0.1', () => { log('static server on', PORT); resolve(server); });
  });
}

/* ---------------- 本地反向代理（localProxy） ----------------
 * 原版把模型请求改写到本地代理以绕开 CORS。地址规则（自洽即可）：
 *   rewrite('https://api.openai.com/v1/chat/completions?a=1')
 *     → http://127.0.0.1:17901/px/https%3A%2F%2Fapi.openai.com/v1/chat/completions?a=1
 * 代理按原样转发方法/头/体，SSE 直接透传。
 */
const https = require('https');
let proxyReady = null;

/* 供应商密钥：客户自填的优先
 *   1) %APPDATA%/MJStudio/keys.json   客户/卖家手动放的（可选，装了就不用在程序目录里改）
 *   2) <程序目录>/data/keys.json      开发机内置的；**发布包里不包含这个文件**
 * 正常情况下客户是在「软件设置」里填 key，前端自己带 Authorization，
 * 这里只在客户端没带 token 时兜底注入。
 * 只在代理转发时按域名注入 Authorization，绝不明文写进前端或日志。 */
const KEY_TEMPLATE = {
  providers: {},
  geminiShim: { enabled: true, baseUrl: 'https://www.aicost.me/v1', fallbackKey: '' },
  textGateway: { baseUrl: 'https://www.aicost.me/v1', apiKey: '', model: 'gemini-3.8-flash' },
};
let KEYS = KEY_TEMPLATE;
let KEYS_SRC = '';
// Gemini 原生协议 → OpenAI 兼容 的翻译开关（前端有大量 gemini 路径调用，可用额度都在 aicost）
let SHIM = { enabled: true, baseUrl: 'https://www.aicost.me/v1', fallbackKey: '' };

function keyFilePath() { return path.join(DATA_DIR, 'keys.json'); }
function loadKeys() {
  const cands = [
    keyFilePath(),
    path.join(ROOT, '..', 'data', 'keys.json'),
  ];
  const found = cands.find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || '';
  const raw = found ? readJson(found, {}) : {};
  KEYS = raw && typeof raw === 'object' ? raw : {};
  KEYS.providers = KEYS.providers || {};
  SHIM = { enabled: true, baseUrl: 'https://www.aicost.me/v1', fallbackKey: '', ...(KEYS.geminiShim || {}) };
  KEYS_SRC = found;
  return KEYS;
}
loadKeys();
const geminiShim = require('./gemini-shim.cjs');
const imageRescue = require('./image-rescue.cjs');

/* ---- 付费出图在途计数 ----
 * 上游是「收钱即开工」：客户端断开也照画照扣，图却没人接。
 * 计数只做两件事：退出前拦截、日志里报「还有几张在传」。 */
let paidInFlight = 0;
const paidInFlightAt = []; /* [{host, path, startedAt}] 方便弹窗里说清在等什么 */

/* 首次启动给客户落一份「去密钥」的配置模板：图片平台、推理地址都配好，只缺客户自己那把 key。
 * 只在 settings.json 不存在时落一次，绝不覆盖客户已经改过的配置。 */
function seedSettingsOnce() {
  const f = path.join(DATA_DIR, 'settings.json');
  try { if (fs.existsSync(f)) return false; } catch { return false; }
  const src = path.join(ROOT, '..', 'data', 'settings.seed.json');
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(src, f);
    log('首启配置模板已落盘', f);
    return true;
  } catch (e) { log('首启配置模板落盘失败', e.message); return false; }
}

/* 覆盖安装的客户：settings.json 已存在，seedSettingsOnce 不会再落盘，新版模板里新增的提示词
 * 预设就永远拿不到。这里做一次「只补不删」的合并：只把 seed 里有、客户当前没有的预设按 id
 * 补进去，客户改过名字/内容的预设一律不动；用 seed 预设 id 的签名做标记，同一版模板只处理
 * 一次，客户删掉的预设不会每次启动又复活。 */
function mergeSeedPromptPresets() {
  const f = path.join(DATA_DIR, 'settings.json');
  const src = path.join(ROOT, '..', 'data', 'settings.seed.json');
  try {
    if (!fs.existsSync(f) || !fs.existsSync(src)) return false;
    const cur = readJson(f, null);
    const seed = readJson(src, null);
    if (!cur || !seed || !seed.workbenchEntityPromptSettings) return false;
    const seedGroups = seed.workbenchEntityPromptSettings;
    const seenFile = path.join(DATA_DIR, 'seed-prompts-seen.json');
    const seenState = readJson(seenFile, null);
    const seen = seenState && Array.isArray(seenState.seen) ? seenState.seen.slice() : [];
    const seenSet = new Set(seen);
    const dst = cur.workbenchEntityPromptSettings || (cur.workbenchEntityPromptSettings = {});
    let added = 0;
    for (const kind of Object.keys(seedGroups)) {
      const sp = seedGroups[kind] || {};
      if (!Array.isArray(sp.presets)) continue;
      const dp = dst[kind] || (dst[kind] = { presets: [], activeId: sp.activeId || '' });
      if (!Array.isArray(dp.presets)) dp.presets = [];
      const ids = new Set(dp.presets.map((p) => p && p.id).filter(Boolean));
      for (const p of sp.presets) {
        /* 只处理这版模板里「从没见过」的新预设：客户删过的 id 已记在 seen 里，不会复活 */
        if (!p || !p.id || seenSet.has(p.id)) continue;
        if (!ids.has(p.id)) { dp.presets.push(p); ids.add(p.id); added += 1; }
        seenSet.add(p.id);
      }
      if (!dp.activeId && sp.activeId) dp.activeId = sp.activeId;
    }
    const changed = added > 0 || seenSet.size !== seen.length;
    if (!changed) return false;
    fs.writeFileSync(f, JSON.stringify(cur, null, 1), 'utf8');
    fs.writeFileSync(seenFile, JSON.stringify({ seen: Array.from(seenSet) }, null, 1), 'utf8');
    log('提示词预设已从模板补齐', added);
    return added > 0;
  } catch (e) {
    log('提示词预设补齐失败', String((e && e.message) || e));
    return false;
  }
}

/* 出图 / 出片路径判定：只认明确的图片、视频生成端点。
 * 文本推理（/chat/completions、gemini :generateContent）不拦 —— 未激活本来就进不了主界面，
 * 而授权到期后用户可能还想打开软件导出已有作品，不该被文本请求一起卡死。 */
function isPaidPath(rest) {
  const p = String(rest || '');
  return (
    /\/images?\/(generations|edits|variations)/i.test(p) ||
    /\/videos?\b/i.test(p) ||
    /\/video\/(generations?|create)/i.test(p) ||
    /\bsora\b/i.test(p)
  );
}

function rewriteUrl(raw) {
  const u = String(raw || '');
  if (!/^https?:\/\//i.test(u)) return u;
  const m = /^(https?:\/\/[^/?#]+)([\s\S]*)$/i.exec(u);
  if (!m) return u;
  const origin = m[1];
  const rest = m[2] || '/';
  // 已经是本地地址就不要再包一层
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) && rest.startsWith('/px/')) return u;
  return `http://127.0.0.1:${PROXY_PORT}/px/${encodeURIComponent(origin)}${rest}`;
}

/* 只有「垫片自己的上游」才需要 Gemini → OpenAI 翻译。
 * 客户在「软件设置 → 推理模型 → API 平台配置」里新加的地址（如 api.mmg.lat）大多原生支持
 * /v1beta 协议，硬转成 OpenAI 会把客户的 key 发到 aicost、拿回 401 又被吞成空响应，
 * 前端就只看到「模型返回为空」。 */
function shimOwnsHost(origin) {
  const norm = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  try {
    const a = norm(new URL(String(origin || '')).hostname);
    const b = norm(new URL(String(SHIM.baseUrl || '')).hostname);
    if (!a || !b) return false;
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch { return false; }
}

/* Gemini 原生协议 → OpenAI 兼容（aicost）
 * 命中 `{base}/v1beta/models/{model}:generateContent` 或 `:streamGenerateContent`
 * 时，把请求改写成 /v1/chat/completions，并把响应翻译回 Gemini 形态。
 * 前端（聊天室等按模型名反推 provider 的地方）不需要任何改动。 */
function handleGeminiShim(req, res, rest, m, CORS) {
  const model = decodeURIComponent(m[1] || '');
  const isStream = /^streamGenerateContent$/i.test(m[2]) || /[?&]alt=sse/i.test(rest);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    const qs = new URLSearchParams((rest.split('?')[1] || ''));
    let key = qs.get('key') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!key) key = SHIM.fallbackKey || '';
    if (!key) {
      res.writeHead(401, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 401, message: '缺少 API Key（gemini 请求未带 key）' } }));
      return;
    }
    const reqBody = geminiShim.toOpenAIRequest(body, model);
    reqBody.stream = isStream;
    const payload = Buffer.from(JSON.stringify(reqBody), 'utf8');
    let u;
    try { u = new URL(String(SHIM.baseUrl || '').replace(/\/+$/, '') + '/chat/completions'); } catch {
      res.writeHead(500, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'geminiShim.baseUrl 无效' } }));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const up = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json',
        authorization: `Bearer ${key}`,
        'content-length': payload.length,
      },
    }, (upRes) => {
      if (PROBE) log('gemini shim', upRes.statusCode, model, isStream ? 'stream' : 'once');
      if (!isStream) {
        const bufs = [];
        upRes.on('data', (d) => bufs.push(d));
        upRes.on('end', () => {
          const raw = Buffer.concat(bufs).toString('utf8');
          const code = upRes.statusCode || 502;
          /* 上游报错要原样告诉前端：以前不管状态码一律回 200 空响应，
           * 客户只能看到「模型返回为空」，根本不知道是 key 不对还是模型不存在 */
          if (code >= 400) {
            let msg = raw.slice(0, 300);
            try {
              const j = JSON.parse(raw);
              msg = (j.error && (j.error.message || j.error.code)) || j.message || msg;
            } catch { /* 保留原文 */ }
            log('gemini shim 上游报错', code, String(msg).slice(0, 160));
            res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code, message: msg } }));
            return;
          }
          let out;
          try { out = geminiShim.toGeminiResponse(JSON.parse(raw)); } catch {
            res.writeHead(502, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: '上游返回非 JSON：' + raw.slice(0, 300) } }));
            return;
          }
          res.writeHead(200, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        });
        return;
      }
      /* 流式也一样：先把状态码看清楚再决定回什么，避免把 401/404 伪装成「200 + 空内容」 */
      if ((upRes.statusCode || 502) >= 400) {
        const bufs = [];
        upRes.on('data', (d) => bufs.push(d));
        upRes.on('end', () => {
          const raw = Buffer.concat(bufs).toString('utf8');
          const code = upRes.statusCode || 502;
          let msg = raw.slice(0, 300);
          try {
            const j = JSON.parse(raw);
            msg = (j.error && (j.error.message || j.error.code)) || j.message || msg;
          } catch { /* 保留原文 */ }
          log('gemini shim 上游报错', code, String(msg).slice(0, 160));
          try {
            res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code, message: msg } }));
          } catch { /* 客户端已断开 */ }
        });
        return;
      }
      res.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const t = line.trim();
            if (!t.toLowerCase().startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const ch = (j.choices && j.choices[0]) || {};
              const delta = (ch.delta && ch.delta.content) || (ch.message && ch.message.content) || '';
              if (delta) res.write(geminiShim.streamChunk(delta, false));
            } catch { /* 跳过心跳等非 JSON 行 */ }
          }
        }
      });
      upRes.on('end', () => { try { res.write(geminiShim.streamChunk('', true)); res.end(); } catch { /* ignore */ } });
      upRes.on('error', () => { try { res.end(); } catch { /* ignore */ } });
    });
    up.on('error', (err) => {
      log('gemini shim error', err && err.message);
      try {
        res.writeHead(502, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: String((err && err.message) || err) } }));
      } catch { /* ignore */ }
    });
    up.setTimeout(600000, () => { try { up.destroy(new Error('upstream timeout')); } catch { /* ignore */ } });
    up.write(payload);
    up.end();
  });
}

function startProxyServer() {
  if (proxyReady) return proxyReady;
  proxyReady = new Promise((resolve) => {
    const CORS = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': '*',
      'access-control-max-age': '86400',
    };
    const server = http.createServer((req, res) => {
      if (PROBE) log('proxy req', req.method, (req.url || '').slice(0, 160));
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
      const m = /^\/px\/([^/?#]+)([\s\S]*)$/.exec(req.url || '');
      if (!m) { res.writeHead(404, { ...CORS, 'content-type': 'text/plain' }); res.end('proxy: bad path'); return; }
      let origin;
      try { origin = decodeURIComponent(m[1]); } catch { origin = m[1]; }
      const rest = m[2] || '/';
      // 出图 / 出片前置校验：未激活或已到期直接 403，不把请求转给上游（也省额度）
      if (isPaidPath(rest)) {
        try {
          lic.requireActive();
        } catch (e) {
          log('[license] blocked paid request', rest.slice(0, 80), String((e && e.message) || e));
          res.writeHead(403, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 403, type: 'license_required', message: String((e && e.message) || e) } }));
          return;
        }
      }
      // 厂商云端提示词接口 → 本地内置提示词（data/local-prompts.json，与前端内置补丁同源）
      // 放宽匹配：任何含 /allPrompt 的请求都本地兜底，避免不同 URL 构造路径漏拦
      if (/\/allPrompt/i.test(rest)) {
        try {
          const prompts = readJson(path.join(ROOT, '..', 'data', 'local-prompts.json'), {});
          const body = JSON.stringify(prompts);
          if (PROBE) log('allPrompt serve', 'origin=' + origin, 'rest=' + rest.slice(0, 80), 'bytes=' + body.length);
          res.writeHead(200, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        } catch (err) {
          if (PROBE) log('allPrompt error', String(err && err.message));
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ message: String(err && err.message) }));
        }
        return;
      }
      // Gemini 原生路径 → 协议翻译后转 aicost（详见 handleGeminiShim）
      // 真的 Google 域名不劫持，留给用户接官方 key 时原样透传
      const gpath = (rest || '/').split('?')[0];
      // 有的前端路径只拼到 /v1beta/models/{model}（不带 :generateContent），也一并接住
      const gm = /^\/v1beta\/models\/([^:?#/]+)(?::(generateContent|streamGenerateContent))?\/?$/i.exec(gpath);
      const isRealGoogle = /googleapis\.com/i.test(origin || '');
      /* 客户自己填的 Gemini 地址原样透传（原生 /v1beta 直连），只有目标是垫片上游时才翻译 */
      if (gm && SHIM.enabled && !isRealGoogle && shimOwnsHost(origin)) {
        handleGeminiShim(req, res, rest, gm, CORS);
        return;
      }
      let target;
      try { target = new URL(origin); } catch { res.writeHead(400, CORS); res.end('proxy: bad origin'); return; }
      /* 出图接口：响应旁路一份，用于留证据 + 兜底落盘（见 image-rescue.cjs） */
      const rescueOn = imageRescue.isImageEndpoint(rest);
      const reqStart = Date.now();   /* 用于算出「上游到底占了多久」 */
      let reqBodyText = '';
      const mod = target.protocol === 'http:' ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers.origin;
      delete headers.referer;
      // 真实供应商秘钥注入（兜底）：仅当客户端自身没带 token 时才注入，
      // 否则尊重前端配置的 key（例如推理 key 与出图 key 是同一家的两把不同秘钥）
      const hostKey = (target.host || target.hostname || '').toLowerCase();
      const prov = KEYS.providers[hostKey];
      const curAuth = String(headers.authorization || '').trim();
      const noToken = !curAuth || /^bearer\s*$/i.test(curAuth);
      if (prov && prov.key && noToken) {
        headers.authorization = `${prov.auth || 'Bearer'} ${prov.key}`;
        if (PROBE) log('key inject', hostKey);
      } else if (PROBE && curAuth) {
        log('key keep', hostKey);
      }
      const opts = {
        method: req.method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: rest,
        headers,
      };
      /* 首字节 = 上游把图画完、开始往回吐数据的时刻。
       * 「首字节 − 请求发出」是生成耗时，「响应结束 − 首字节」是纯传输耗时。
       * 少了这两个数就只能看到总时长，没法判断该换模型还是该换中转。 */
      let firstByteAt = 0;
      let recvBytes = 0;
      let paidDone = false;
      if (rescueOn) {
        paidInFlight += 1;
        paidInFlightAt.push({ host: target.host, path: rest.split('?')[0].slice(0, 50), startedAt: reqStart });
      }
      const paidRelease = () => {
        if (!rescueOn || paidDone) return;
        paidDone = true;
        paidInFlight = Math.max(0, paidInFlight - 1);
        const idx = paidInFlightAt.findIndex((x) => x.startedAt === reqStart);
        if (idx >= 0) paidInFlightAt.splice(idx, 1);
      };
      const up = mod.request(opts, (upRes) => {
        if (PROBE) log('proxy resp', upRes.statusCode, target.host + rest.slice(0, 90));
        // 去掉上游的 CORS 头，统一由本地代理给
        const h = { ...upRes.headers };
        for (const k of Object.keys(h)) if (/^access-control-/i.test(k)) delete h[k];
        res.writeHead(upRes.statusCode || 502, { ...h, ...CORS });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        /* 先记首字节与累计字节数，再交给 pipe */
        upRes.on('data', (c) => {
          if (!firstByteAt) firstByteAt = Date.now();
          recvBytes += c.length;
        });
        upRes.on('aborted', paidRelease);
        if (rescueOn) {
          /* 前端解析失败 / 页面刷新 / 并发覆盖，都不能再把已经付费的图弄丢 */
          const chunks = [];
          let total = 0;
          upRes.on('data', (c) => {
            if (total < imageRescue.MAX_CAPTURE) { chunks.push(c); total += c.length; }
          });
          upRes.on('end', () => {
            const endedAt = Date.now();
            paidRelease();
            imageRescue.onPaidResponse({
              status: upRes.statusCode,
              contentType: upRes.headers['content-type'],
              body: Buffer.concat(chunks).toString('utf8'),
              requestBody: reqBodyText,
              assetsRoot: path.join(DATA_DIR, 'assets'),
              startedAt: reqStart,
              firstByteAt,
              recvBytes,
              endedAt,
              onSaved: attachRescuedAssets,
              log,
            }).catch((e) => log('[paid] 旁路分析异常', (e && e.message) || e));
          });
        } else {
          upRes.on('end', paidRelease);
        }
        upRes.pipe(res);
      });
      up.setTimeout(600000, () => { try { up.destroy(new Error('upstream timeout')); } catch { /* ignore */ } });
      up.on('error', (err) => {
        paidRelease();
        log('proxy error', origin + rest, err && err.message);
        try { res.writeHead(502, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(err && err.message) } })); } catch { /* ignore */ }
      });
      res.on('close', paidRelease);
      if (rescueOn) {
        const bufs = [];
        req.on('data', (c) => bufs.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(bufs);
          reqBodyText = raw.toString('utf8');
          up.end(raw);
        });
      } else {
        req.pipe(up);
      }
    });
    server.on('error', (err) => { log('proxy server error', err.message); resolve(null); });
    server.listen(PROXY_PORT, '127.0.0.1', () => { log('local proxy on', PROXY_PORT); resolve(server); });
  });
  return proxyReady;
}

/* ---------------- 窗口 ---------------- */
let win = null;
const consoleLines = [];

/* 页面加载后注入的常驻浮层：右下角「检查更新」所有渠道都有；
 * 左下角「开发者版控制台」只有开发者渠道才注入 —— 客户机连这段代码都不会执行。 */
function injectOverlays(wc) {
  wc.on('did-finish-load', () => {
    const inject = (name) => {
      try {
        const f = path.join(__dirname, '..', 'app', name);
        if (fs.existsSync(f)) wc.executeJavaScript(fs.readFileSync(f, 'utf8'), true).catch(() => {});
      } catch { /* 页面没就绪就算了，下次加载还会再试 */ }
    };
    inject('update-badge.js');
    inject('asset-name-guard.js');
    if (devMode.enabled()) inject('dev-badge.js');
  });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const WIN_TITLE = devMode.title(APP_NAME);
  win = new BrowserWindow({
    width: Math.min(1680, Math.round(width * 0.92)),
    height: Math.min(1000, Math.round(height * 0.92)),
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0f1420',
    title: WIN_TITLE,
    icon: WINDOW_ICON,
    show: !PROBE || process.env.MJ_SHOW === '1',
    webPreferences: webPrefs(),
  });

  // window.open → 开新窗口（独立窗口兜底路径走这里）
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const w = new BrowserWindow({
        width: 1560, height: 960, minWidth: 1180, minHeight: 720,
        backgroundColor: '#0f1420', title: WIN_TITLE, icon: WINDOW_ICON, show: true,
        webPreferences: webPrefs(),
      });
      injectOverlays(w.webContents);
      w.loadURL(url);
      return { action: 'deny' };
    } catch { return { action: 'deny' }; }
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const item = `[c${level}] ${message}${source ? ` @${path.basename(String(source))}:${line}` : ''}`;
    consoleLines.push(item);
    if (PROBE) console.log('CONSOLE ' + item);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('RENDER GONE', JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => log('PRELOAD ERROR', p, err && err.message));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('FAIL LOAD', code, desc));

  // 菜单删掉后没有了 Toggle DevTools 的入口，留 F12 兜底，方便排查前端问题
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      try { win.webContents.toggleDevTools(); } catch { /* ignore */ }
    }
  });

  /* 开发者版把窗口标题锁住：页面自己的 <title> 会盖掉 BrowserWindow 的 title */
  if (devMode.enabled()) {
    win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { win.setTitle(WIN_TITLE); } catch { /* ignore */ }
    });
  }
  /* 浮层单独放 js 文件，不塞进压缩后的 Vue chunk：前端重新打包不会冲掉，
   * 热更也能单独替换这一个文件。 */
  injectOverlays(win.webContents);

  win.loadURL(`http://127.0.0.1:${PORT}/`);
  return win;
}

/* ---------------- IPC ---------------- */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  /* 原子写：先落临时文件再 rename。直接 writeFileSync 在断电/被杀进程时
   * 会留下半个 JSON，下次启动整份作品表解析失败 → 看起来像"作品全没了"。 */
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(file, text, 'utf8');   /* rename 被占用时退回直接写 */
    log('writeJson fallback', file, (err && err.message) || err);
  }
}

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({ ok: false, error: String(error && error.message || error) });

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      // 首次运行缺文件是正常情况（前端会兜底），不打进日志噪音
      if (!(err && err.code === 'ENOENT')) log(`handler ${channel} error:`, err && err.message);
      return fail(err);
    }
  });
}

/* --- fs / 项目数据：全部落在 MJStudio 自己的数据目录 --- */
const PROJECTS_FILE = path.join(DATA_DIR, 'novel-projects.json');
const WORK_DIR = path.join(DATA_DIR, 'workspace');
fs.mkdirSync(WORK_DIR, { recursive: true });
// 前端到处用相对路径（如「作品/chatroom/…」），一律落到 workspace 下，绝不落到程序目录
function resolvePath(p) {
  const s = String(p || '');
  if (!s) return s;
  if (path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) return s;
  return path.join(WORK_DIR, s.replace(/^[\\/]+/, ''));
}
// 前端 fs 契约：一律返回 { success, data?, message? }
// （实测：readFile 读的是 data.content，writeFile/mkdir/copyFile 只判断 success）
const fsOk = (data) => (data === undefined ? { success: true } : { success: true, data });
const fsFail = (e) => ({ success: false, message: String((e && e.message) || e) });
handle('fs:exists', (p) => fsOk({ exists: fs.existsSync(resolvePath(p)) }));
handle('fs:readFile', (p, enc) => {
  try {
    let file = resolvePath(p);
    // 聊天指令库跟着「工程目录」走，用户一旦改目录就整份读不到（下拉只剩内置的 24 条）。
    // 原路径不存在时回落到随包副本，保证 67 条指令始终在。
    if (!fs.existsSync(file) && path.basename(file).toLowerCase() === 'custom-instructions.json') {
      const fallback = path.join(ROOT, '..', 'data', 'custom-instructions.json');
      if (fs.existsSync(fallback)) {
        log('custom-instructions fallback:', file, '->', fallback);
        file = fallback;
      }
    }
    const buf = fs.readFileSync(file);
    return fsOk({ content: enc === 'base64' ? buf.toString('base64') : buf.toString('utf8') });
  } catch (e) { return fsFail(e); }
});
handle('fs:writeFile', (p, content, encoding) => {
  try {
    const file = resolvePath(p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const str = typeof content === 'string' ? content : String(content ?? '');
    const enc = String(encoding || '').toLowerCase();
    let buf;
    if (/^data:[^,]+,/.test(str)) {
      // 前端有时直接传完整 dataURL
      buf = Buffer.from(str.slice(str.indexOf(',') + 1), 'base64');
    } else if (enc === 'base64') {
      // 前端站位图裁剪、音频等走 fs.writeFile(path, base64, 'base64')，必须按 base64 解码
      buf = Buffer.from(str, 'base64');
    } else if (enc === 'binary' || enc === 'latin1') {
      buf = Buffer.from(str, 'binary');
    } else {
      buf = Buffer.from(str, 'utf8');
    }
    fs.writeFileSync(file, buf);
    return fsOk({ path: file });
  } catch (e) { return fsFail(e); }
});
handle('fs:mkdir', (p) => {
  try { const d = resolvePath(p); fs.mkdirSync(d, { recursive: true }); return fsOk({ path: d }); }
  catch (e) { return fsFail(e); }
});
handle('fs:unlink', (p) => {
  try { fs.unlinkSync(resolvePath(p)); return fsOk(); } catch (e) { return fsFail(e); }
});
handle('fs:readdir', (p) => {
  try {
    const d = resolvePath(p);
    return fsOk({ files: fs.existsSync(d) ? fs.readdirSync(d) : [] });
  } catch (e) { return fsFail(e); }
});
handle('fs:stat', (p) => {
  try {
    const st = fs.statSync(resolvePath(p));
    return fsOk({ size: st.size, mtime: st.mtimeMs, isDirectory: st.isDirectory() });
  } catch (e) { return fsFail(e); }
});
handle('fs:copyFile', (a, b) => {
  try { fs.copyFileSync(resolvePath(a), resolvePath(b)); return fsOk({ path: resolvePath(b) }); }
  catch (e) { return fsFail(e); }
});
handle('fs:rename', (a, b) => {
  try { fs.renameSync(resolvePath(a), resolvePath(b)); return fsOk({ path: resolvePath(b) }); }
  catch (e) { return fsFail(e); }
});

/* --- 小说项目 --- */
function readProjects() {
  const db = readJson(PROJECTS_FILE, { projects: [] });
  if (Array.isArray(db)) return db;
  return Array.isArray(db && db.projects) ? db.projects : [];
}
handle('novel:loadAllProjects', () => ({ success: true, data: readProjects() }));
// 前端契约：saveProject(id, project) —— 两个参数；同时兼容单对象调用
handle('novel:saveProject', (a, b) => {
  const proj = (b && typeof b === 'object') ? b : (a && typeof a === 'object' ? a : null);
  const id = String(
    (proj && (proj.id || proj.projectId)) || (typeof a === 'string' ? a : '') || '',
  ).trim();
  if (!id) return { success: false, message: '项目缺少 id' };
  const list = readProjects().filter((x) => !x || String(x.id) !== id);
  list.push({ ...(proj || {}), id });
  writeJson(PROJECTS_FILE, { projects: list });
  return { success: true, data: { id, count: list.length } };
});
handle('novel:deleteProject', (a) => {
  const id = String(typeof a === 'string' ? a : (a && (a.id || a.projectId)) || '').trim();
  if (!id) return { success: false, message: '项目缺少 id' };
  const list = readProjects().filter((x) => !x || String(x.id) !== id);
  writeJson(PROJECTS_FILE, { projects: list });
  return { success: true, data: { id } };
});
handle('novel:loadProject', (a) => {
  const id = String(typeof a === 'string' ? a : (a && (a.id || a.projectId)) || '').trim();
  const hit = readProjects().find((x) => x && String(x.id) === id) || null;
  return { success: !!hit, data: hit };
});
handle('novel:exportProject', () => ({ success: true }));

/* --- 设置（flygen） --- */
handle('flygen:getSettings', () => readJson(SETTINGS_FILE, {}));
handle('flygen:setSettings', (patch) => {
  const cur = readJson(SETTINGS_FILE, {});
  writeJson(SETTINGS_FILE, { ...cur, ...(patch || {}) });
  return true;
});
handle('flygen:saveFile', async (opts) => {
  const r = await dialog.showSaveDialog(win, opts || {});
  return r.canceled ? null : r.filePath;
});
handle('flygen:selectFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('flygen:selectFiles', async (opts) => {
  // 自动化测试用：MJ_PICK_FILES=路径1;路径2 时直接返回，不弹原生窗口
  const preset = String(process.env.MJ_PICK_FILES || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (preset.length) { log('selectFiles preset', preset.length, 'file(s)'); return preset; }
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], ...(opts || {}) });
  return r.canceled ? [] : r.filePaths;
});

/* --- 占位类 --- */
const stub = (v) => () => v;
handle('auth:saveToken', (t) => {
  const rec = readJson(TOKEN_FILE, {});
  const next = { ...rec, ...(t || {}) };
  // 授权字段一律以 license.json 为准：前端 saveToken 带过来的 isPermanent / expireTime
  // 是它自己按未知字段兜出来的默认值（实测会把永久卡存成 false / "0"），不能信。
  try {
    const l = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'license.json'), 'utf8'));
    if (l && l.code) {
      next.activationCode = l.code;
      next.type = l.type;
      next.label = l.label;
      next.expiresAt = l.expiresAt || 0;
      next.isPermanent = !l.expiresAt;
      next.expireTime = l.expiresAt ? new Date(l.expiresAt).toLocaleDateString('zh-CN') : '';
    }
  } catch { /* 还没激活就按前端传来的写，反正 status 也不认 */ }
  writeJson(TOKEN_FILE, next);
  return true;
});
handle('auth:loadToken', () => {
  const rec = readJson(TOKEN_FILE, null);
  if (!rec || !rec.token) return { success: false, data: null };
  return { success: true, data: { accessToken: rec.token, userName: rec.account || rec.userName || 'local', ...rec } };
});
handle('auth:getToken', stub(null));
handle('auth:loadTokenTwo', () => ({ success: true, data: DEVICE_ID }));
handle('auth:clearToken', () => { try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ } return true; });
// 激活页显示的机器码：跟发码用的那一串完全一致（前 12 位，4 位一组）
handle('system:getMachineId', () => ({ success: true, data: lic.bindCodeOf() }));
handle('system:getInfo', () => ({ success: true, data: { platform: os.platform(), hostname: os.hostname() } }));
handle('system:writeAutoLoginLog', (p) => { log('[auto-login]', p && p.level, p && p.message); return true; });
// 前端产品配置（mt()）：apiBaseUrl 指向本地代理，厂商云端接口由本地代理拦截/兜底
handle('system:getAppConfig', () => ({
  success: true,
  data: {
    apiBaseUrl: `http://127.0.0.1:${PROXY_PORT}/vendor`,
    tenantId: '1',
    brandCode: 'mengyuan',
  },
}));
/* ---- 豆包视频助手（真插件链路，127.0.0.1:8787）---- */
handle('doubao:getStatus', async () => {
  const s = doubaoHelper.status();
  if (!s.running) {
    // 页面打开时自动尝试拉起（与原版一样懒启动）
    doubaoHelper.start().catch(() => { /* ignore */ });
  }
  return s;
});
handle('doubao:subscribeStatus', () => {
  if (global.__doubaoSubscribed) return true;
  global.__doubaoSubscribed = true;
  doubaoHelper.onStatus((s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('doubao:status', s); } catch { /* ignore */ }
    }
  });
  return true;
});
handle('doubao:setEnabled', (v) => doubaoHelper.setEnabled(v !== false));
handle('doubao:restart', async () => { await doubaoHelper.restart(); return true; });
handle('doubao:regenerateToken', () => doubaoHelper.regenerateToken());
/* 恢复账号数据前先识别文件来源：星核 Helper 只接受自己导出的 NDJSON 备份。
   画布工作台导出的 .txt 虽然同为 NDJSON，但带私有元数据、加密上下文也不同，
   直接交给 Helper 会在解密后 JSON 解析阶段报 "Unexpected token ..."，
   更糟的是恢复流程会先清空当前星核账号。这里在 IPC 层挡住，给出可操作的提示。 */
function checkAccountRestoreInput(p, body) {
  try {
    if (String(p || '') !== '/internal/accounts/restore') return null;
    const src = String((body && body.inputPath) || '');
    if (!src || !fs.existsSync(src)) return null;
    const fd = fs.openSync(src, 'r');
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const text = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '');
    let head = null;
    try { head = JSON.parse(text.split(/\r?\n/, 1)[0].trim()); }
    catch { return { success: false, message: '所选文件不是账号备份（文件头无法识别），请重新选择星核 AIGC 导出的备份文件' }; }
    if (!head || head.kind !== 'doubao-accounts-login-backup') {
      return { success: false, message: '所选文件不是星核账号备份，请使用「备份账号数据」导出的文件' };
    }
    if (head.app === '画布工作台' || head.sourceFormat || head.canvasMeta || /"type":"meta"/.test(text)) {
      return { success: false, message: '这是画布工作台导出的账号备份，只能在画布工作台里用「恢复账号数据」还原；星核 AIGC 读不了这个文件，强行恢复还会覆盖当前星核账号。' };
    }
    return null;
  } catch { return null; }
}
handle('doubao:fetchHelper', async ({ path: p, method, body } = {}) => {
  const blocked = checkAccountRestoreInput(p, body);
  if (blocked) return blocked;
  return doubaoHelper.request(p, method || 'GET', body);
});
handle('doubao:getPath', () => doubaoHelper.getConfig());
handle('doubao:openFolder', async () => {
  try { await shell.openPath(doubaoHelper.getConfig().dataDir); return true; } catch { return false; }
});
/* 前端调用是 revealInFolder({filePath}) 且判定返回值里的 success；
 * 旧实现按字符串接收、只返回 true → 每次点「打开文件目录/打开目录」都弹「打开目录失败」。
 * 这里统一解析 xingyuan-file://、file://、绝对路径、带 ?cv= 缓存参数、数据目录相对路径，
 * 再按「文件 → 定位文件；目录 → 打开目录；文件已不在 → 打开父目录」处理。 */
function toLocalFilePath(raw) {
  let s = (raw && typeof raw === 'object')
    ? String(raw.filePath || raw.path || raw.url || raw.src || '')
    : String(raw == null ? '' : raw);
  s = s.trim();
  if (!s) return { ok: false, message: '未获取到文件路径' };
  if (/^https?:\/\//i.test(s)) return { ok: false, message: '这是网络文件，没有本地目录' };
  if (/^xingyuan-file:/i.test(s)) {
    s = resolveXingyuanPath(s) || '';
    if (!s) return { ok: false, message: '无法解析本地路径' };
  } else {
    const q = s.search(/[?#]/);
    if (q >= 0) s = s.slice(0, q);
    if (/^file:\/\//i.test(s)) {
      s = s.replace(/^file:\/{1,3}/i, '');
      try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    }
    s = s.replace(/\//g, '\\');
  }
  if (!path.isAbsolute(s)) {
    const cands = [path.join(DATA_DIR, s), path.join(DATA_DIR, 'assets', s), path.join(APP_ROOT, s)];
    const hit = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
    s = hit || cands[0];
  }
  return { ok: true, path: s };
}
async function revealInFolder(arg) {
  const r = toLocalFilePath(arg);
  if (!r.ok) return { success: false, message: r.message };
  const target = r.path;
  try {
    if (fs.existsSync(target)) {
      const st = fs.statSync(target);
      if (st.isDirectory()) { await shell.openPath(target); return { success: true, path: target }; }
      shell.showItemInFolder(target);
      return { success: true, path: target };
    }
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) {
      await shell.openPath(parent);
      return { success: true, path: parent, message: '文件已不在，已打开所在目录' };
    }
    return { success: false, message: '目录不存在：' + parent };
  } catch (err) {
    return { success: false, message: String((err && err.message) || err) };
  }
}
handle('asset:revealInFolder', (arg) => revealInFolder(arg));
/* asset.download({url,kind,entityId}) → {success,data:{filePath}}；importLocal({sourcePath,...}) 同理 */
function assetDir(kind, entityId) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '') || 'misc';
  const dir = path.join(DATA_DIR, 'assets', safe(kind || 'misc'), safe(entityId || 'misc'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
handle('asset:importLocal', async ({ sourcePath, kind, entityId } = {}) => {
  const src = String(sourcePath || '');
  if (!src || !fs.existsSync(src)) return { success: false, message: '源文件不存在：' + src };
  const dir = assetDir(kind, entityId);
  const dest = path.join(dir, path.basename(src));
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  return { success: true, data: { filePath: dest } };
});
handle('asset:download', async ({ url, kind, entityId } = {}) => {
  const u = String(url || '');
  const dir = assetDir(kind, entityId);
  const stamp = Date.now().toString(36);
  const brief = `${kind || '?'}/${(String(entityId || '').split('_').pop() || '?')}`;
  try {
    if (/^https?:/i.test(u)) {
      /* 中转返回的响应里本来就带着 base64（同一张图的两种形态），
       * 图已经在内存里了，没必要再去境外图床按 13KB/s 拉一遍。
       * 命中就立即落盘 —— 这是「生成完就能马上看到」的关键。 */
      const hit = imageRescue.getCachedBytes(u);
      if (hit && hit.buf && hit.buf.length) {
        const extHit = /png/.test(hit.ct) ? '.png' : /jpe?g/.test(hit.ct) ? '.jpg' : /webp/.test(hit.ct) ? '.webp' : '.png';
        const destHit = path.join(dir, `dl-${stamp}${extHit}`);
        fs.writeFileSync(destHit, hit.buf);
        log('[asset:download] 内存命中(免下载)', brief, `${(hit.buf.length / 1024 / 1024).toFixed(2)}MB`, path.basename(destHit));
        return { success: true, data: { filePath: destHit } };
      }
      /* 图已经生成、钱已经扣了，下载这一步不能一次失败就丢：重试两次再报错 */
      let res = null;
      let lastErr = null;
      for (let i = 0; i < 3; i += 1) {
        try {
          res = await fetch(u);
          if (res.ok) break;
          lastErr = new Error('HTTP ' + res.status);
        } catch (e) { lastErr = e; res = null; }
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
      if (!res || !res.ok) {
        log('[asset:download] 失败', brief, String((lastErr && lastErr.message) || ''), u.slice(0, 100));
        return { success: false, message: '下载失败 ' + String((lastErr && lastErr.message) || '') };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = String(res.headers.get('content-type') || '');
      const ext = /png/.test(ct) ? '.png' : /jpe?g/.test(ct) ? '.jpg' : /webp/.test(ct) ? '.webp' : /mp4/.test(ct) ? '.mp4' : '.bin';
      const dest = path.join(dir, `dl-${stamp}${ext}`);
      fs.writeFileSync(dest, buf);
      log('[asset:download] ok', brief, `${(buf.length / 1024 / 1024).toFixed(2)}MB`, path.basename(dest));
      return { success: true, data: { filePath: dest } };
    }
    if (/^data:/i.test(u)) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
      if (!m) return { success: false, message: '无法识别的数据地址' };
      const ext = /png/.test(m[1]) ? '.png' : /jpe?g/.test(m[1]) ? '.jpg' : /webp/.test(m[1]) ? '.webp' : '.bin';
      const dest = path.join(dir, `dl-${stamp}${ext}`);
      fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
      log('[asset:download] ok(base64)', brief, path.basename(dest));
      return { success: true, data: { filePath: dest } };
    }
    const local = u.replace(/^file:\/\//i, '');
    if (local && fs.existsSync(local)) {
      const dest = path.join(dir, path.basename(local));
      fs.copyFileSync(local, dest);
      return { success: true, data: { filePath: dest } };
    }
    log('[asset:download] 不支持/找不到', brief, u.slice(0, 120));
    return { success: false, message: '不支持的地址：' + u.slice(0, 120) };
  } catch (err) {
    log('[asset:download] 异常', brief, String((err && err.message) || err), u.slice(0, 100));
    return { success: false, message: String((err && err.message) || err) };
  }
});
handle('asset:list', ({ kind } = {}) => {
  const base = path.join(DATA_DIR, 'assets', String(kind || ''));
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, depth + 1); else out.push({ filePath: p, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(base, 0);
  return { success: true, data: out };
});
handle('asset:save', (p) => ({ success: true, data: { filePath: String(p || '') } }));
handle('asset:delete', (p) => { try { fs.unlinkSync(String(p || '')); } catch { /* ignore */ } return { success: true }; });

/* --- 作品库（job）：漫剧制作的系列 / 单集 / 分镜全在这里 --- */
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
function loadJobs() { const j = readJson(JOBS_FILE, { jobs: [] }); return Array.isArray(j.jobs) ? j.jobs : []; }
function saveJobs(list) { writeJson(JOBS_FILE, { jobs: list }); }

/* 备份 jobs.json（同一 tag 只留最近 5 份，避免备份目录越滚越大） */
function backupJobsFile(tag) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dst = path.join(DATA_DIR, `jobs.json.bak-${tag}-${stamp}.json`);
    if (!fs.existsSync(dst)) fs.copyFileSync(JOBS_FILE, dst);
    const prefix = `jobs.json.bak-${tag}-`;
    const olds = fs.readdirSync(DATA_DIR)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .slice(0, -5);
    for (const n of olds) { try { fs.unlinkSync(path.join(DATA_DIR, n)); } catch { /* ignore */ } }
  } catch { /* 备份失败不阻断主流程 */ }
}

/**
 * 唯一的数据出口：所有剧集都过一遍「资产身份归一化 + 分镜引用对齐」。
 * 读（job:list）、写（job:create）、启动迁移都走这里，避免只在某一个入口
 * 打补丁、换个页面/换台机器又复现（1.0.22）。
 */
function normalizeJobsInPlace(jobs) {
  const report = { fixed: [], desc: [], derived: [], relinked: [], created: [], dangling: [], changed: false, errors: 0 };
  let mod = null;
  try { mod = require('./asset-repair.cjs'); } catch { return report; }
  if (!mod || typeof mod.normalizeEpisodeAssets !== 'function') return report;
  const eps = (Array.isArray(jobs) ? jobs : []).filter((x) => x && x.kind === 'episode' && x.script_json);
  for (const job of eps) {
    const siblings = eps.filter((x) => {
      if (x === job) return false;
      const a = String(x.parentId || x.parent_id || '');
      const b = String(job.parentId || job.parent_id || '');
      return !a || !b || a === b;
    });
    try {
      const r = mod.normalizeEpisodeAssets(job, siblings);
      if (r.changed) report.changed = true;
      report.fixed.push(...r.names.fixed);
      report.desc.push(...((r.desc && r.desc.filled) || []));
      report.derived.push(...((r.derived && r.derived.filled) || []));
      report.relinked.push(...r.refs.relinked);
      report.created.push(...r.refs.created);
      report.dangling.push(...r.refs.dangling);
    } catch (e) {
      report.errors += 1;
      log('[asset] 归一化失败', job.id, (e && e.message) || e);
    }
  }
  return report;
}
function logNormalizeReport(tag, r) {
  if (!r || !r.changed) return;
  log(`[asset] ${tag}归一化`, JSON.stringify({
    补名: r.fixed.length, 补描述: (r.desc || []).length,
    分镜兜底描述: (r.derived || []).length, 改引用: r.relinked.length,
    补空资产: r.created.length, 仍悬空: r.dangling.length,
  }));
  if (r.fixed.length) log('[asset] 补名明细', r.fixed.slice(0, 12).join(' '));
  if ((r.desc || []).length) log('[asset] 补描述明细', r.desc.slice(0, 12).join(' '));
  if ((r.derived || []).length) log('[asset] 分镜兜底描述明细', r.derived.slice(0, 12).join(' '));
  if (r.relinked.length) log('[asset] 引用明细', r.relinked.slice(0, 12).join(' '));
  if (r.created.length) log('[asset] 新增占位资产', r.created.slice(0, 12).join(' '));
}
/* job:list 每次进页面都会调；100 集时全量扫提示词有开销。
 * 用 jobs.json 的 mtime+size 做戳，没变过就直接返回，只在写盘后归一化一次。 */
let lastNormStamp = '';
function jobsFileStamp() {
  try { const st = fs.statSync(JOBS_FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}
handle('job:list', () => {
  const jobs = loadJobs();
  const stamp = jobsFileStamp();
  if (stamp && stamp === lastNormStamp) return { success: true, data: jobs };
  try {
    const r = normalizeJobsInPlace(jobs);
    if (r.changed) {
      backupJobsFile('before-normalize');
      saveJobs(jobs);
      logNormalizeReport('读取时', r);
    }
    lastNormStamp = jobsFileStamp();
    if (r.dangling.length) log('[asset] 分镜引用了表里没有的实体', `${r.dangling.length} 条`, r.dangling.slice(0, 8).join(' '));
  } catch (e) {
    log('[job:list] 归一化失败，按原样返回', (e && e.message) || e);
  }
  return { success: true, data: jobs };
});

/* 兜底图挂回资产表：按提示词里出现的资产名匹配。
 * 批量生图在前端「下载失败就直接 return、还不报错」，这里的兜底能把它救回来。 */
const RESCUE_TARGETS = [
  { kind: 'role', field: 'updated_roles', select: 'selectRolePath', list: 'rolePathList' },
  { kind: 'scene', field: 'updated_scenes', select: 'selectScenePath', list: 'scenePathList' },
  { kind: 'prop', field: 'updated_props', select: 'selectPropPath', list: 'propPathList' },
];
function attachRescuedAssets(paths, prompt) {
  const list = (paths || []).filter(Boolean);
  const text = String(prompt || '');
  if (!list.length || !text) return { attached: 0 };
  const jobs = loadJobs();
  let done = null;
  for (const job of jobs) {
    if (!job || job.kind !== 'episode' || !job.script_json) continue;
    for (const t of RESCUE_TARGETS) {
      const arr = job.script_json[t.field];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const name = String((it && it.name) || '').trim();
        if (name.length < 2 || !text.includes(name)) continue;
        if (String(it.imageUrl || it[t.select] || '').trim()) continue;   /* 已有图不抢 */
        done = { job, target: t, item: it, name };
        break;
      }
      if (done) break;
    }
    if (done) break;
  }
  if (!done) {
    log('[rescue] 提示词里没匹配到资产名，图留在 assets/_rescue');
    return { attached: 0 };
  }
  const { target, item, name } = done;
  const prev = Array.isArray(item[target.list]) ? item[target.list] : [];
  const all = Array.from(new Set([...list, ...prev]));
  item[target.list] = all;
  item[target.select] = list[0];
  if (target.kind === 'scene') { item.scene_path_list = all; item.select_scene_path = list[0]; }
  if (target.kind === 'prop') { item.prop_path_list = all; item.select_prop_path = list[0]; }
  if (target.kind === 'role') { item.role_path_list = all; item.select_role_path = list[0]; }
  item.imageUrl = `xingyuan-file:///${String(list[0]).replace(/\\/g, '/')}`;
  item.image_url = item.imageUrl;
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(JOBS_FILE, path.join(DATA_DIR, `jobs.json.bak-before-rescue-${stamp}`));
  } catch { /* 备份失败不阻断 */ }
  saveJobs(jobs);
  log('[rescue] 已挂回资产', name, path.basename(list[0]));
  return { attached: 1, name };
}
handle('job:create', (job) => {
  const id = String((job && job.id) || '').trim();
  if (!id) return { success: false, message: '缺少作品ID' };
  const all = loadJobs();
  const prev = all.find((x) => String(x && x.id) === id) || null;
  /* 前端各页面各自持有一份旧对象，直接整条覆盖会把刚生成的图片引用写没，
   * 这里先跟盘上的同 ID 作品合并一次（只补空字段，不删用户改动）。 */
  let saved = job;
  try {
    const { mergeJobOnSave } = require('./asset-repair.cjs');
    saved = mergeJobOnSave(prev, job);
  } catch (err) {
    log('[job:create] 合并资产引用失败，按原样保存', (err && err.message) || err);
  }
  /* 【按每集独立 + 图片由用户自己匹配】
   * 本集资产表只保留本集自己的条目：不并兄弟集、不改写 @id，只在本集内部同名去重。
   * 【不再自动从资产库补图】—— 以前保存剧本时会自动把母版图挂到本集空白行，
   * 现在改成完全由人在分镜页点「一键匹配资产图片」（或逐条在资产库挑图）来决定。
   * 每一集都是独立的：不自动继承别集的实体，也不自动继承别集的图片。
   * 母版入库同样仍是手动「批量添加到资产库」，不自动入库。 */
  try {
    const { dedupeJobAssets } = require('./asset-repair.cjs');
    const deduped = dedupeJobAssets(saved, []);   /* 只在当前分集内部去重 */
    saved = deduped.job;
    if (deduped.merged.length) {
      log('[asset] 本集内部同名归并', deduped.merged.map((m) => `${m.name}:${m.from}->${m.to}`).join(' '));
    }
    /* 硬守卫：前端历史上有 Il()/Kv() 两条跨集合并链路（1.0.16 / 1.0.19 已断），
     * 这里再兜一层，保证以后不管从哪条路径带过来的别集实体/图片都落不了盘。
     * 只处理「相对盘上旧对象新增」的条目，用户手动新增/手动匹配的图不受影响。 */
    const { stripCrossEpisodeAssets } = require('./asset-repair.cjs');
    const guarded = stripCrossEpisodeAssets(
      saved, prev, all.filter((x) => String(x && x.id) !== id),
    );
    saved = guarded.job;
    if (guarded.removed.length) log('[asset] 拦截跨集带入实体', guarded.removed.join(' '));
    if (guarded.cleared.length) log('[asset] 清除跨集带入图片', guarded.cleared.join(' '));
    if (guarded.renamed.length) log('[asset] 回填空壳资产名', guarded.renamed.join(' '));
    if (guarded.unresolved.length) log('[asset] 未能补名的资产（保留编号）', guarded.unresolved.join(' '));
    /* 写完再走一遍统一归一化：补齐历史空壳行 + 把分镜 role_ids 对齐到本集资产表。
     * 有些页面保存的是旧内存对象，只靠上面的「新增条目」规则修不到已存在的空壳。 */
    const { normalizeEpisodeAssets } = require('./asset-repair.cjs');
    const siblings = all.filter((x) => String(x && x.id) !== id);
    const norm = normalizeEpisodeAssets(saved, siblings);
    if (norm.changed) {
      logNormalizeReport('保存时', {
        changed: true,
        fixed: norm.names.fixed,
        desc: (norm.desc && norm.desc.filled) || [],
        derived: (norm.derived && norm.derived.filled) || [],
        relinked: norm.refs.relinked,
        created: norm.refs.created,
        dangling: norm.refs.dangling,
      });
    }
    if (norm.refs.dangling.length) log('[asset] 分镜引用了表里没有的实体', norm.refs.dangling.slice(0, 8).join(' '));
  } catch (err) {
    log('[job:create] 本集归并/跨集隔离失败', (err && err.message) || err);
  }
  const list = all.filter((x) => String(x && x.id) !== id);
  list.push(saved);
  saveJobs(list);
  return { success: true, data: saved };
});
handle('job:delete', (id) => {
  const key = String(id || '').trim();
  saveJobs(loadJobs().filter((x) => String(x && x.id) !== key));
  try { fs.rmSync(path.join(DATA_DIR, 'assets', 'job', key), { recursive: true, force: true }); } catch { /* ignore */ }
  return { success: true };
});
handle('job:flags', () => ({ success: true, data: {} }));

/* --- 在线热更新（前端可主动触发；启动时也会静默查一次） --- */
handle('app:updateInfo', () => ({ success: true, data: updater.info() }));
handle('app:updateCheck', () => updater.check({ silent: false }));
handle('app:updateDiag', () => updater.diag());
handle('app:updateSetUrl', (url) => ({ success: true, data: updater.setUrl(url) }));

/* --- 渠道 / 开发者工具 ---
 * 同一套程序靠本机标记区分渠道：客户机没有标记，下面每个接口都直接拒绝，
 * 界面也不会出现开发者浮层。这里不碰激活/授权逻辑，避免出包时带出授权漏洞。 */
const DEV_PATHS = {
  data: () => DATA_DIR,
  logs: () => LOG_DIR,
  app: () => path.join(ROOT, '..'),
};
const devOn = () => devMode.enabled();
handle('app:devInfo', () => {
  if (!devOn()) return { success: false, error: '正式版不可用' };
  const st = devMode.state();
  return {
    success: true,
    data: {
      enabled: true,
      channel: devMode.channel(),
      label: devMode.label(),
      source: st.source,
      note: st.note || '',
      version: updater.localVersion(),
      displayVersion: `${updater.localVersion()}${st.versionSuffix || ''}`,
      dataDir: DATA_DIR,
      logDir: LOG_DIR,
      appRoot: path.join(ROOT, '..'),
      marker: devMode.cfgFile(),
      machine: (() => { try { return String(lic.machineCode()).slice(0, 4) + '****'; } catch { return ''; } })(),
      update: updater.info(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron || '',
      node: process.version,
    },
  };
});
handle('app:devOpenTools', () => {
  if (!devOn()) return { success: false, error: '正式版不可用' };
  const w = BrowserWindow.getFocusedWindow() || win;
  if (!w || w.isDestroyed()) return { success: false, error: '没有可用窗口' };
  w.webContents.openDevTools({ mode: 'detach' });
  return { success: true };
});
handle('app:devOpenPath', async (which) => {
  if (!devOn()) return { success: false, error: '正式版不可用' };
  const get = DEV_PATHS[String(which || 'data')];
  if (!get) return { success: false, error: '未知目录' };
  try {
    const p = get();
    try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignore */ }
    const err = await shell.openPath(p);
    return err ? { success: false, error: String(err) } : { success: true, data: { path: p } };
  } catch (e) { return { success: false, error: String((e && e.message) || e) }; }
});
handle('app:devCopyDiag', () => {
  if (!devOn()) return { success: false, error: '正式版不可用' };
  const st = devMode.state();
  const u = updater.info();
  const h = u.hotfix;
  const txt = [
    `星核AIGC · ${devMode.label()}`,
    `版本：v${updater.localVersion()}${st.versionSuffix || ''}`,
    `系统：${os.platform()} ${os.arch()} / Electron ${process.versions.electron || ''} / Node ${process.version}`,
    `程序目录：${path.join(ROOT, '..')}`,
    `数据目录：${DATA_DIR}`,
    `日志目录：${LOG_DIR}`,
    `更新源：${u.configured ? (u.urls || []).join(' | ') : '未配置'}（${u.source || ''}）`,
    `最近热更：${h ? JSON.stringify(h) : '无'}`,
    `机器码：${(() => { try { return lic.machineCode(); } catch { return ''; } })()}`,
    `时间：${new Date().toLocaleString('zh-CN')}`,
  ].join('\n');
  try { clipboard.writeText(txt); } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
  return { success: true, data: txt };
});

/* --- 聊天室本地存储：electronAPI.chatroom --- */
const CHAT_DIR = path.join(DATA_DIR, 'chatroom');
handle('chatroom:loadStore', () => {
  const empty = { meta: { version: 1, activeSessionId: '' }, sessions: [] };
  const store = readJson(path.join(CHAT_DIR, 'store.json'), null);
  if (store && Array.isArray(store.sessions) && store.sessions.length) {
    return { success: true, data: store };
  }
  /* 前端只写 sessions/<id>.json 和 meta.json，从不写 store.json。
   * 若这里只信 store.json，切换界面（组件重新挂载）就会读到空列表、
   * 前端随即新建一个「新对话」盖掉 activeSessionId，看起来像历史对话全丢了。
   * 因此 store.json 缺失/为空时，从 sessions 目录重建会话列表。 */
  let sessions = [];
  try {
    const dir = path.join(CHAT_DIR, 'sessions');
    sessions = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => readJson(path.join(dir, f), null))
      .filter((s) => s && s.id)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  } catch { /* 目录不存在按空处理 */ }
  if (!sessions.length) return { success: true, data: empty };

  const meta = readJson(path.join(CHAT_DIR, 'meta.json'), null) || {};
  let active = String(meta.activeSessionId || '');
  const activeRec = sessions.find((s) => s.id === active);
  // active 指向空会话（切界面时新建的「新对话」）或已不存在 → 回到最近一条有内容的对话
  if (!activeRec || !(Array.isArray(activeRec.messages) && activeRec.messages.length)) {
    const firstWithContent = sessions.find((s) => Array.isArray(s.messages) && s.messages.length);
    active = (firstWithContent || sessions[0]).id;
  }
  return { success: true, data: { meta: { version: 1, activeSessionId: active }, sessions } };
});
handle('chatroom:saveStore', (store) => { writeJson(path.join(CHAT_DIR, 'store.json'), store || {}); return { success: true }; });
handle('chatroom:saveMeta', (meta) => { writeJson(path.join(CHAT_DIR, 'meta.json'), meta || {}); return { success: true }; });
handle('chatroom:saveSession', (id, data) => {
  writeJson(path.join(CHAT_DIR, 'sessions', String(id || 'unknown') + '.json'), data || {});
  return { success: true };
});
handle('chatroom:deleteSession', (id) => {
  try { fs.unlinkSync(path.join(CHAT_DIR, 'sessions', String(id || '') + '.json')); } catch { /* ignore */ }
  return { success: true };
});
handle('chatroom:loadSession', (id) => ({ success: true, data: readJson(path.join(CHAT_DIR, 'sessions', String(id || '') + '.json'), null) }));

handle('shell:openExternal', (url) => { try { shell.openExternal(String(url)); } catch { /* ignore */ } return true; });
handle('shell:openPath', (p) => { try { shell.openPath(String(p)); } catch { /* ignore */ } return true; });
handle('shell:showItemInFolder', (p) => { try { shell.showItemInFolder(String(p)); } catch { /* ignore */ } return true; });
handle('gpuFallback:getStatus', stub({ active: false }));
handle('gpuFallback:reset', stub(true));
/* ---------------- 媒体信息（借 ffmpeg 读，不依赖 ffprobe） ----------------
 * 前端契约：
 *   media.getDuration({filePath}) -> {success, data:{durationUs}}
 *   media.getMeta({filePath})     -> {success, data:{durationUs,width,height,fps,...}}
 *   media.extractThumb({filePath, atSec, outPath}) -> {success, data:{path}}
 * 没有 ffmpeg 时返回 success:false，前端自己会用 <video> 兜底，不会崩。
 */
function findFfmpeg() {
  const cands = [
    process.env.MJ_FFMPEG,
    path.join(ROOT, '..', 'tools', 'ffmpeg.exe'),
    path.join(ROOT, '..', 'tools', 'ffmpeg'),
    'D:/漫剧分镜台-A方案分享版/无限想象/resources/ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return '';
}

const mediaInfoCache = new Map();

function parseFfmpegInfo(txt) {
  const out = { duration: 0, width: 0, height: 0, fps: 0, videoCodec: '', audioCodec: '', bitrate: 0 };
  const d = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const br = txt.match(/bitrate:\s*(\d+)\s*kb\/s/);
  if (br) out.bitrate = Number(br[1]);
  const v = txt.match(/Stream #\d+:\d+.*?Video:\s*([a-zA-Z0-9_]+).*?(\d{2,5})x(\d{2,5})/);
  if (v) {
    out.videoCodec = v[1];
    out.width = Number(v[2]);
    out.height = Number(v[3]);
  }
  const f = txt.match(/(\d+(?:\.\d+)?)\s*fps/);
  if (f) out.fps = Number(f[1]);
  const a = txt.match(/Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_]+)/);
  if (a) out.audioCodec = a[1];
  return out;
}

function ffmpegInfo(file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(null);
    if (mediaInfoCache.has(file)) return resolve(mediaInfoCache.get(file));
    const ff = findFfmpeg();
    if (!ff) return resolve(null);
    let buf = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      mediaInfoCache.set(file, val);
      resolve(val);
    };
    let p;
    try {
      p = spawn(ff, ['-hide_banner', '-i', file], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    p.stderr.on('data', (d) => {
      buf += d.toString();
      if (buf.length > 80000) buf = buf.slice(-40000);
    });
    p.on('error', () => finish(null));
    p.on('close', () => finish(parseFfmpegInfo(buf)));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(parseFfmpegInfo(buf)); }, 15000);
  });
}

const mediaPathArg = (a) => String((typeof a === 'string' ? a : (a && (a.filePath || a.path || a.file))) || '').trim();

handle('media:getDuration', async (arg) => {
  const file = resolvePath(mediaPathArg(arg));
  const info = await ffmpegInfo(file);
  if (!info) return { success: false, message: '无法读取媒体信息（未找到 ffmpeg 或文件）' };
  return { success: true, data: { durationUs: Math.round(info.duration * 1e6), duration: info.duration, filePath: file } };
});

handle('media:getMeta', async (arg) => {
  const file = resolvePath(mediaPathArg(arg));
  const info = await ffmpegInfo(file);
  if (!info) return { success: false, message: '无法读取媒体信息（未找到 ffmpeg 或文件）' };
  const st = fs.statSync(file);
  return {
    success: true,
    data: { ...info, durationUs: Math.round(info.duration * 1e6), size: st.size, filePath: file },
  };
});

handle('media:extractThumb', async (arg) => {
  const a = arg || {};
  const file = resolvePath(mediaPathArg(a));
  const atSec = Number(a.atSec ?? a.time ?? a.second ?? 0.1) || 0;
  const outPath = a.outPath ? resolvePath(a.outPath) : file.replace(/\.[^.]+$/, '') + `_thumb_${Math.round(atSec * 1000)}.jpg`;
  const ff = findFfmpeg();
  if (!ff) return { success: false, message: '未找到 ffmpeg' };
  if (!fs.existsSync(file)) return { success: false, message: '文件不存在：' + file };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  return await new Promise((resolve) => {
    let p;
    try {
      p = spawn(ff, ['-hide_banner', '-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-q:v', '3', outPath], { windowsHide: true });
    } catch (e) {
      return resolve({ success: false, message: String(e && e.message) });
    }
    p.on('error', (e) => resolve({ success: false, message: String(e && e.message) }));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve({ success: true, data: { path: outPath } });
      else resolve({ success: false, message: 'ffmpeg 抽帧失败，退出码 ' + code });
    });
  });
});
handle('mainLog:list', () => ({ success: true, data: { entries: consoleLines.slice(-800), filePath: logFile } }));
handle('mainLog:append', (line) => { consoleLines.push(String(line).slice(0, 500)); return true; });
handle('mainLog:clear', () => { consoleLines.length = 0; return true; });
/* --- 资产库：<projectDir>/asset-library/<library>.json ---
 * 前端契约（实测 dist）：
 *   listAll({projectDir, workId}) -> {success, data:{role,scene,prop,voice:{version,type,items}}}
 *   upsert({projectDir, library, item, sourceFilePath}) -> {success, data:item}
 *   delete({projectDir, library, id}) / batchDelete({projectDir, library, ids})
 */
const LIB_TYPES = ['role', 'scene', 'prop', 'voice'];
function libRoot(projectDir) {
  const dir = String(projectDir || '').trim();
  return dir ? path.join(dir, 'asset-library') : path.join(DATA_DIR, 'asset-library');
}
function libFile(projectDir, library) {
  const t = String(library || 'role').trim() || 'role';
  return path.join(libRoot(projectDir), `${t.replace(/[^\w-]/g, '')}.json`);
}
function readLib(projectDir, library) {
  const raw = readJson(libFile(projectDir, library), null);
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return { version: 1, type: String(library || 'role'), items };
}
function writeLib(projectDir, library, items) {
  /* mediaUrl / resolvedMediaPath 是读的时候派生出来的，别被前端写回盘上 */
  const clean = (Array.isArray(items) ? items : []).map((x) => {
    if (!x || typeof x !== 'object') return x;
    const { mediaUrl, resolvedMediaPath, ...rest } = x;
    return rest;
  });
  writeJson(libFile(projectDir, library), { version: 1, type: String(library || 'role'), items: clean });
}
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

/* 前端资产库列表渲染读 mediaUrl、详情预览读 mediaUrl、
 * 分镜页「一键匹配资产图片」读 resolvedMediaPath；
 * 而盘上只存 mediaPath / cover / coverPath。缺这层映射时，
 * 资产库一律显示「暂无图片」，匹配也拿不到路径（全部算未命中）。
 * 这里统一补齐：mediaUrl 给 <img>/<audio> 用（xingyuan-file:// 协议），
 * resolvedMediaPath 回填时给磁盘绝对路径，与正式数据里的 pathList 格式一致。 */
const MEDIA_URL_RE = /^(https?:|data:|blob:|xingyuan-file:)/i;
function libFileUrl(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (MEDIA_URL_RE.test(s)) return s;
  return 'xingyuan-file:///' + encodeURI(s.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
function libDiskPath(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (!/^xingyuan-file:/i.test(s)) return s;
  let rest = s.replace(/^xingyuan-file:/i, '');
  const q = rest.search(/[?#]/);
  if (q >= 0) rest = rest.slice(0, q);
  try { rest = decodeURIComponent(rest); } catch { /* 保留原样 */ }
  const t = rest.replace(/^\/+/, '');
  if (/^[A-Za-z]:[\\/]/.test(t)) return t.replace(/\//g, '\\');
  if (/^[A-Za-z]\//.test(t)) return (t[0].toUpperCase() + ':' + t.slice(1)).replace(/\//g, '\\');
  return t ? '\\' + t.replace(/\//g, '\\') : '';
}
function decorateLibItem(it) {
  if (!it || typeof it !== 'object') return it;
  const disk = libDiskPath(it.mediaPath || it.cover || it.coverPath);
  let ok = false;
  if (disk) { try { ok = fs.statSync(disk).isFile(); } catch { ok = false; } }
  return { ...it, resolvedMediaPath: ok ? disk : '', mediaUrl: ok ? libFileUrl(disk) : '' };
}
function decorateLibItems(items) {
  return (Array.isArray(items) ? items : []).map(decorateLibItem);
}

handle('assetLibrary:listAll', ({ projectDir, workId } = {}) => {
  const wid = String(workId || '').trim();
  const out = {};
  for (const lib of LIB_TYPES) {
    const d = readLib(projectDir, lib);
    const items = wid ? d.items.filter((x) => String((x && x.workId) || '') === wid) : d.items;
    out[lib] = { version: 1, type: lib, items: decorateLibItems(items) };
  }
  return { success: true, data: out };
});
function upsertLibItem(projectDir, library, item, sourceFilePath) {
  const lib = String(library || 'role').trim() || 'role';
  const data = readLib(projectDir, lib);
  const src = libDiskPath(sourceFilePath);
  let mediaPath = String((item && item.mediaPath) || '').trim();
  if (src && fs.existsSync(src)) {
    // 源文件拷进资产库自己的 files/ 目录，避免用户删了原图资产就失效
    const filesDir = path.join(libRoot(projectDir), 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const ext = path.extname(src);
    const base = path.basename(src, ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40) || 'asset';
    const dest = path.join(filesDir, `${Date.now().toString(36)}-${base}${ext}`);
    fs.copyFileSync(src, dest);
    mediaPath = dest;
  }
  const id = String((item && item.id) || '').trim() || `ast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const idx = data.items.findIndex((x) => x && x.id === id);
  const isImg = IMG_RE.test(mediaPath);
  const now = new Date().toISOString();
  const rec = {
    id,
    name: String((item && item.name) || '').trim() || '未命名资产',
    category: String((item && item.category) || '').trim(),
    remark: String((item && item.remark) || '').trim(),
    mediaPath,
    workId: String((item && item.workId) || '').trim(),
    workName: String((item && item.workName) || '').trim(),
    cover: isImg ? mediaPath : '',
    coverPath: isImg ? mediaPath : '',
    /* 入库时记下本集资产的原始 id / 编号，跨集「只按名字」匹配不到时还能按编号命中。
     * 按每集之后资产库是唯一跨集来源，这层别名很关键。 */
    aliases: (() => {
      const raw = item && item.aliases;
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const old = (idx >= 0 && data.items[idx] && Array.isArray(data.items[idx].aliases))
        ? data.items[idx].aliases : [];
      return [...new Set([...old, ...arr]
        .map((v) => String(v || '').trim()).filter(Boolean))];
    })(),
    createdAt: (idx >= 0 && data.items[idx] && data.items[idx].createdAt) || now,
    updatedAt: now,
  };
  if (idx >= 0) data.items[idx] = { ...data.items[idx], ...rec };
  else data.items.unshift(rec);
  writeLib(projectDir, lib, data.items);
  return decorateLibItem(rec);
}
handle('assetLibrary:upsert', ({ projectDir, library, item, sourceFilePath } = {}) => (
  { success: true, data: upsertLibItem(projectDir, library, item, sourceFilePath) }
));

const normLibName = (v) => String(v || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');

/* 资产库「按名字 / 原始编号取图」的查询实现。
 * 【已不在保存链路中自动调用】按用户要求，图片改由分镜页「从资产库匹配图片」
 * 手动按钮决定；这里保留纯查询能力，供数据修复脚本 / 以后的手动匹配 IPC 复用。
 * scopeIds = [本集 id, 父作品 id]：本作品母版优先，避免两个作品的同名角色串图；
 * 本作品没命中才回退全局（兼容早期 workId 为空或写错的老数据）。 */
const { buildLookup: buildAssetLookup } = require('./asset-match.cjs');
function libImageLookup(projectDir, scopeIds) {
  const cache = new Map();
  return (kind, key) => {
    const lib = String(kind || 'role');
    if (!cache.has(lib)) {
      const entries = [];
      for (const it of readLib(projectDir, lib).items) {
        const disk = libDiskPath(it.mediaPath || it.cover || it.coverPath);
        if (!disk) continue;
        try { if (!fs.statSync(disk).isFile()) continue; } catch { continue; }
        entries.push({
          disk,
          workId: String((it && it.workId) || '').trim(),
          keys: [it && it.name, ...(Array.isArray(it && it.aliases) ? it.aliases : [])],
        });
      }
      cache.set(lib, buildAssetLookup(entries, scopeIds));
    }
    return cache.get(lib)(key) || '';
  };
}

/* 把本集「已有图」的资产写进作品级资产库（同名已在库则跳过，不重复拷文件）。
 * 当前【不自动调用】：母版改由分镜页「批量添加到资产库」手动触发，
 * 避免每集的一次性道具/废图把库灌满（见 job:create 处注释）。函数保留备用。 */
function syncJobAssetsToLibrary(job, projectDir) {
  let list = [];
  try {
    list = require('./asset-repair.cjs').listAssetsWithImages(job);
  } catch { return 0; }
  const known = new Map();      /* kind -> Set(名字) */
  let added = 0;
  for (const a of list) {
    const disk = libDiskPath(a.path);
    if (!disk) continue;
    try { if (!fs.statSync(disk).isFile()) continue; } catch { continue; }
    if (!known.has(a.kind)) {
      const set = new Set();
      for (const it of readLib(projectDir, a.kind).items) {
        const k = normLibName(it && it.name);
        if (!k) continue;
        const p = libDiskPath(it.mediaPath || it.cover || it.coverPath);
        let ok = false;
        if (p) { try { ok = fs.statSync(p).isFile(); } catch { ok = false; } }
        if (ok) set.add(k);
      }
      known.set(a.kind, set);
    }
    const key = normLibName(a.name);
    if (!key || known.get(a.kind).has(key)) continue;
    /* 变体/换装/战损形态不入母版库，避免同名造型互相覆盖 */
    const variant = String((a.item && a.item.variant_name) || '').trim();
    if (variant && variant !== '默认形态') continue;
    try {
      upsertLibItem(projectDir, a.kind, {
        name: a.name,
        category: a.kind,
        workId: String(job.id || ''),
        workName: String(job.jobName || ''),
      }, disk);
      known.get(a.kind).add(key);
      added += 1;
    } catch (err) {
      log('[library] 自动入库失败', a.name, (err && err.message) || err);
    }
  }
  return added;
}
handle('assetLibrary:delete', ({ projectDir, library, id } = {}) => {
  const lib = String(library || 'role').trim() || 'role';
  const data = readLib(projectDir, lib);
  const before = data.items.length;
  const target = data.items.find((x) => x && x.id === id);
  data.items = data.items.filter((x) => !x || x.id !== id);
  if (data.items.length === before) return { success: false, message: '资产不存在' };
  writeLib(projectDir, lib, data.items);
  // 清理托管到资产库里的副本，外链/工作目录文件不动
  try {
    const mp = String((target && target.mediaPath) || '');
    const filesDir = path.join(libRoot(projectDir), 'files');
    if (mp && path.resolve(mp).startsWith(path.resolve(filesDir)) && fs.existsSync(mp)) fs.unlinkSync(mp);
  } catch { /* ignore */ }
  return { success: true, data: { id } };
});
handle('assetLibrary:batchDelete', ({ projectDir, library, ids } = {}) => {
  const lib = String(library || 'role').trim() || 'role';
  const set = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)));
  if (!set.size) return { success: true, data: { deleted: 0 } };
  const data = readLib(projectDir, lib);
  const keep = [];
  let deleted = 0;
  const filesDir = path.join(libRoot(projectDir), 'files');
  for (const it of data.items) {
    if (it && set.has(String(it.id))) {
      deleted++;
      try {
        const mp = String(it.mediaPath || '');
        if (mp && path.resolve(mp).startsWith(path.resolve(filesDir)) && fs.existsSync(mp)) fs.unlinkSync(mp);
      } catch { /* ignore */ }
      continue;
    }
    keep.push(it);
  }
  writeLib(projectDir, lib, keep);
  return { success: true, data: { deleted } };
});
// 旧通道名保留兼容
handle('assetLibrary:list', ({ projectDir, library } = {}) => {
  const lib = String(library || 'role').trim() || 'role';
  const d = readLib(projectDir, lib);
  return { success: true, data: { version: 1, type: lib, items: decorateLibItems(d.items) } };
});
handle('assetLibrary:save', (p = {}) => {
  const { projectDir, library, item, sourceFilePath } = p;
  const lib = String(library || p.type || 'role').trim() || 'role';
  const data = readLib(projectDir, lib);
  const id = String((item && item.id) || '').trim() || `ast-${Date.now().toString(36)}`;
  const idx = data.items.findIndex((x) => x && x.id === id);
  if (idx >= 0) data.items[idx] = { ...data.items[idx], ...(item || {}), id };
  else data.items.unshift({ ...(item || {}), id, mediaPath: sourceFilePath || (item && item.mediaPath) || '' });
  writeLib(projectDir, lib, data.items);
  return { success: true, data: { id } };
});
handle('assetLibrary:remove', ({ projectDir, library, id } = {}) => {
  const data = readLib(projectDir, library || 'role');
  data.items = data.items.filter((x) => !x || x.id !== id);
  writeLib(projectDir, library || 'role', data.items);
  return { success: true };
});
handle('assetLibrary:import', stub([]));
handle('assetLibrary:export', stub(true));
handle('localProxy:ready', async () => { await startProxyServer(); return true; });
ipcMain.on('localProxy:portSync', (e) => { e.returnValue = PROXY_PORT; });
handle('localProxy:getBaseUrl', () => `http://127.0.0.1:${PROXY_PORT}`);
handle('localProxy:getHostToKey', () => ({}));
handle('localProxy:rewrite', (url) => rewriteUrl(url));
/* --- 画布（xapp）：找本机画布程序并启动 --- */
function findCanvasExe() {
  const candidates = [
    { exe: 'D:/画布工作台/画布工作台.exe', cwd: 'D:/画布工作台' },
    { exe: path.join(process.env.LOCALAPPDATA || '', 'Programs', '画布工作台', '画布工作台.exe'), cwd: path.join(process.env.LOCALAPPDATA || '', 'Programs', '画布工作台') },
    { exe: 'C:/Users/Administrator/WorkBuddy/2026-11-11-13-57-14/CanvasWorkbench/runtime/electron.exe', cwd: 'C:/Users/Administrator/WorkBuddy/2026-11-11-13-57-14/CanvasWorkbench' },
  ];
  for (const c of candidates) {
    try { if (c.exe && fs.existsSync(c.exe)) return c; } catch { /* ignore */ }
  }
  return null;
}
handle('xapp:check', () => {
  const p = findCanvasExe();
  return p ? { success: true, installed: true, path: p.exe } : { success: false, installed: false, message: '未找到「画布」程序' };
});
handle('xapp:launch', () => {
  const found = findCanvasExe();
  if (!found) return { success: false, message: '未找到「画布」程序' };
  try {
    const { spawn } = require('child_process');
    if (/electron\.exe$/i.test(found.exe)) {
      spawn(found.exe, ['.'], { cwd: found.cwd, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(found.exe, [], { cwd: found.cwd, detached: true, stdio: 'ignore' }).unref();
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: String((err && err.message) || err) };
  }
});

/* --- 独立分镜窗口：electronAPI.storyboard.openDetached({storyboardId}) --- */
const detachedWins = new Map();
function webPrefs() {
  return {
    preload: path.join(ROOT, 'preload.cjs'),
    nodeIntegration: false,
    contextIsolation: true,
    webviewTag: true,
    sandbox: false,
    spellcheck: false,
    /* 窗口最小化/被遮住时 Chromium 会把定时器节流到 ~1 次/分钟。
     * 视频轮询用的是 10 秒 setTimeout，一旦被节流，网关那边就会看到「前端停止轮询」
     * （2026-11-13 23:19 实测卡了 52 秒，直接把一条正在生成的视频判成取消）。
     * 这个应用本来就要在后台持续轮询，直接关掉节流。 */
    backgroundThrottling: false,
  };
}
handle('storyboard:openDetached', ({ storyboardId } = {}) => {
  const id = String((storyboardId && storyboardId.storyboardId) || storyboardId || '').trim();
  if (!id) return { success: false, message: '缺少 storyboardId' };
  const exist = detachedWins.get(id);
  if (exist && !exist.isDestroyed()) { exist.focus(); return { success: true, reused: true }; }
  const w = new BrowserWindow({
    width: 1560, height: 960, minWidth: 1180, minHeight: 720,
    backgroundColor: '#0f1420', title: devMode.title('分镜工作台'), icon: WINDOW_ICON, show: true,
    webPreferences: webPrefs(),
  });
  w.webContents.on('preload-error', (_e, p, err) => log('PRELOAD ERROR(detached)', p, err && err.message));
  injectOverlays(w.webContents);
  w.loadURL(`http://127.0.0.1:${PORT}/#/home/storyboard-workbench/${encodeURIComponent(id)}`);
  detachedWins.set(id, w);
  w.on('closed', () => detachedWins.delete(id));
  return { success: true, reused: false };
});

/* --- 内核 action：coreBridge.invoke(action, payload) --- */
/* 设备标识：跟激活页显示的机器码同源（license 模块读注册表 MachineGuid 算出来的指纹）。
 * 以前是 sha256(主机名|用户名)，换用户名就变一个值，且跟授权绑的机器不是一回事 —— 统一掉。 */
const DEVICE_ID = 'MJ-' + lic.machineCode();
const TOKEN_FILE = path.join(DATA_DIR, 'auth.json');

/* --- 文本推理统一出口（novel.generateText）
 * 原版内核把这个 action 当成"按 provider 路由到各家文本模型"的入口。
 * 本机只有 aicost 一把可用的推理 key，所以统一走 OpenAI 兼容的 chat/completions，
 * 具体地址/模型/密钥由 data/keys.json 的 textGateway 决定。 */
/* 客户在「软件设置 → 推理模型」里填的 key，壳自己的文本网关也认它。
 * 否则客户明明填了 key，走 novel.generateText 的功能（小说转剧本等）还是报「未配置」。 */
function gatewayFromSettings() {
  const s = readJson(SETTINGS_FILE, {}) || {};
  const prov = String(s.reasoningProvider || 'gemini').toLowerCase();
  const table = {
    gemini: { url: s.geminiUrl, key: s.geminiKey, model: s.geminiModel },
    gpt: { url: s.gptUrl, key: s.gptKey || s.gptApiKey, model: s.gptModel },
    claude: { url: s.claudeUrl, key: s.claudeKey || s.claudeApiKey, model: s.claudeModel },
    deepseek: { url: s.deepseekUrl, key: s.deepseekApiKey, model: s.deepseekModel },
  };
  return table[prov] || table.gemini || {};
}
/** 设置里填的可能是 https://api.mmg.lat（不带 /v1），补成 OpenAI 兼容根 */
function openAiBase(url) {
  const b = String(url || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/v\d+(\.\d+)?$/i.test(b)) return b;
  return `${b}/v1`;
}

async function generateTextViaGateway(p) {
  const opts = p || {};
  const gw = Object.assign(
    { baseUrl: SHIM.baseUrl || '', apiKey: SHIM.fallbackKey || '', model: 'gemini-3.8-flash' },
    KEYS.textGateway || {},
  );
  // 随包不带 key 之后，优先用客户自己在设置里填的那把
  if (!String(gw.apiKey || '').trim()) {
    const s = gatewayFromSettings();
    if (String(s.key || '').trim()) {
      gw.baseUrl = openAiBase(s.url) || gw.baseUrl;
      gw.apiKey = String(s.key).trim();
      gw.model = String(s.model || gw.model);
      if (PROBE) log('text gateway ← 软件设置', String(gw.baseUrl).replace(/^https?:\/\//, '').split('/')[0], gw.model);
    }
  }
  const base = String(gw.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { success: false, message: '未配置文本推理网关（data/keys.json → textGateway）' };
  const apiKey = String(gw.apiKey || '').trim();
  if (!apiKey) return { success: false, message: '文本推理网关缺少 API Key' };

  const model = String(opts.model || gw.model || '').trim();
  const messages = [];
  const sys = String(opts.systemPrompt || '').trim();
  if (sys) messages.push({ role: 'system', content: sys });

  const imgs = Array.isArray(opts.inlineImages) ? opts.inlineImages.filter((x) => x && x.data) : [];
  const userText = String(opts.userInput || opts.prompt || '').trim();
  if (imgs.length) {
    const content = [{ type: 'text', text: userText || '请分析这张图片。' }];
    for (const im of imgs) {
      const mime = String(im.mimeType || im.mime_type || 'image/png');
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${String(im.data).replace(/\s/g, '')}` } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  const body = { model, messages, stream: false };
  const temp = Number(opts.temperature);
  if (Number.isFinite(temp)) body.temperature = temp;
  const topP = Number(opts.topP);
  if (Number.isFinite(topP)) body.top_p = topP;
  const maxTok = Number(opts.maxOutputTokens);
  if (Number.isFinite(maxTok) && maxTok > 0) body.max_tokens = maxTok;

  const ac = new AbortController();
  // 前端会传 timeoutMs:120000，但长提示词改写实测要 2-5 分钟，这里给足 5 分钟下限
  const timeoutMs = Math.max(300000, Number(opts.timeoutMs) || 0);
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const rawText = await res.text();
    let json = null;
    try { json = JSON.parse(rawText); } catch { /* 非 JSON 交给下面统一报错 */ }
    if (!res.ok) {
      const msg = (json && ((json.error && json.error.message) || json.message)) || rawText.slice(0, 300);
      log('novel.generateText fail', res.status, String(msg).slice(0, 200));
      return { success: false, message: `模型请求失败（HTTP ${res.status}）：${msg}`, data: { raw: json } };
    }
    const choices = Array.isArray(json && json.choices) ? json.choices : [];
    const text = choices.map((c) => String((c && c.message && c.message.content) || '')).join('').trim();
    if (!text) return { success: false, message: '模型返回为空', data: { raw: json } };
    if (PROBE) log('novel.generateText ok', model, text.length + ' chars');
    return { success: true, data: { text, raw: json } };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const msg = aborted ? `模型请求超时（>${Math.round(timeoutMs / 1000)} 秒）` : String((err && err.message) || err);
    log('novel.generateText error', msg);
    return { success: false, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

const CORE = {
  /* 激活 = 一机一码校验：license.cjs 验签 + 绑机 + 期限全过，才写 auth.json。
   * 前端契约：od() 通过判定后执行 return t.data.data，故 data 里必须再包一层 data（用户信息） */
  'auth.login': (p) => {
    const code = String((p && p.activationCode) || '').trim();
    const username = String((p && (p.userName || p.account)) || 'local').trim() || 'local';
    if (!code) return { success: false, message: '请输入激活码' };

    const act = lic.activate(code);
    if (!act.ok) return { success: false, message: act.error || '激活码无效' };
    const d = act.data;
    const rec = {
      account: username,
      activatedAt: d.activatedAt,
      token: DEVICE_ID,
      activationCode: d.code,
      type: d.type,
      label: d.label,
      expiresAt: d.expiresAt,
      isPermanent: d.isPermanent,
    };
    writeJson(TOKEN_FILE, rec);
    log('[license] activated', d.type, d.code, 'machine=' + lic.bindCodeOf(), 'expiresAt=' + (d.expiresAt || 'never'));
    return {
      success: true,
      message: '',
      data: {
        accessToken: rec.token,
        token: rec.token,
        userName: rec.account,
        userId: 'local-user',
        sysUuid: DEVICE_ID,
        activationCode: d.code,
        type: d.type,
        label: d.label,
        expiresAt: d.expiresAt,
        vip: { isPermanent: d.isPermanent, expireTime: d.expiresAt ? new Date(d.expiresAt).toLocaleDateString('zh-CN') : '' },
      },
    };
  },
  'auth.restoreSession': () => {
    const rec = readJson(TOKEN_FILE, null);
    const s = lic.status();
    if (!rec || !s.activated) return { success: false, message: s.expired ? '授权已到期' : (s.note ? String(s.note).split('\n')[0] : '未激活') };
    return {
      success: true,
      data: {
        token: rec.token, userName: rec.account, userId: 'local-user', activationCode: rec.activationCode,
        vip: { isPermanent: s.isPermanent, expireTime: s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('zh-CN') : '' },
      },
    };
  },
  'auth.validateSession': () => {
    const rec = readJson(TOKEN_FILE, null);
    const s = lic.status();
    if (!rec || !s.activated) {
      return { success: false, data: { valid: false }, message: s.expired ? '授权已到期，请输入新的激活码' : (s.note ? String(s.note).split('\n')[0] : '登录凭证已失效') };
    }
    return { success: true, data: { valid: true, token: rec.token, userName: rec.account, expiresAt: s.expiresAt, vip: { isPermanent: s.isPermanent } } };
  },
  'auth.logout': () => { try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ } return true; },
  'license.getStatus': () => ({ ...lic.status(), plan: 'local' }),
  // 激活页/设置页要看的机器码（带横线，跟发码用的完全一致：绑定只取前 12 位）
  'license.info': () => ({ ...lic.status(), machine: lic.bindCodeOf(), summary: lic.describe() }),
  'device.getId': () => DEVICE_ID,
  // 系统内置提示词：本体在 data/local-prompts.json（id -> 提示词正文，从原版提取的 22 条）
  // 前端两种读法：{content} 用于指令型；{beforePrompt, afterPrompt} 用于分镜包装型
  'prompt.builtin': (p) => {
    const id = String((p && p.id) || '').trim();
    const table = readJson(path.join(ROOT, '..', 'data', 'local-prompts.json'), {});
    const hit = id && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
    // 三种存法：纯文本；指令型 {name,content}；工作台型 {name,beforePrompt,afterPrompt,videoPrompt,content}
    // 注意：原版工作台条目的 content 是 before/after 的 JSON 序列化串，不是提示词正文。
    // 若把那串 JSON 当 content 返回，「优化指令 / 最终预览」会把 JSON 喂给模型，必须按分段重组。
    const obj = hit && typeof hit === 'object' ? hit : null;
    const raw = typeof hit === 'string' ? hit : (obj && (obj.content || obj.text || obj.prompt)) || '';
    const hasParts = !!(obj && (typeof obj.beforePrompt === 'string' || typeof obj.afterPrompt === 'string' || typeof obj.videoPrompt === 'string'));
    const before = obj && typeof obj.beforePrompt === 'string' ? obj.beforePrompt : (hasParts ? '' : raw);
    const after = obj && typeof obj.afterPrompt === 'string' ? obj.afterPrompt : '';
    const video = obj && typeof obj.videoPrompt === 'string' ? obj.videoPrompt : '';
    const text = hasParts ? [before, after].filter(Boolean).join('\n\n') : raw;
    if (!text && !before && !after && !video) {
      return { success: false, message: `内置提示词不存在：${id || '(空 id)'}` };
    }
    return {
      success: true,
      data: {
        id,
        name: (obj && obj.name) || id,
        content: text || [before, after].filter(Boolean).join('\n\n'),
        beforePrompt: before,
        afterPrompt: after,
        videoPrompt: video,
      },
    };
  },
  'prompt.build': (p) => ({ prompt: '', ...(p || {}) }),
  'novel.generateOutline': () => { throw new Error('内核未接入：novel.generateOutline（P2）'); },
  // 前端 Rr() 走这里：分镜工作台的「优化指令 / 违规检测 / 转 H3 / Gemini 看图」全都落到这个 action。
  // 契约：{ ok:true, data:{ success:true, data:{ text, raw } } }
  'novel.generateText': (p) => generateTextViaGateway(p),
  // 提示词构建：原版内核为 V8 字节码，这里用本地实现替代（electron/prompt-builders.cjs）
  // 前端要求返回 { ok:true, data:{ success:true, data:{ prompt } } }
  'novel.buildPrompt': (p) => {
    const kind = String((p && p.kind) || '').trim();
    const payload = (p && p.payload) || {};
    return { success: true, data: { prompt: buildPrompt(kind, payload), kind } };
  },
  'novel.buildOutlinePrompt': (p) => ({ success: true, data: { prompt: buildPrompt('outline', p || {}) } }),
  'storyboard.generate': () => { throw new Error('内核未接入：storyboard.generate（P2）'); },
  'storyboard.check': () => ({ issues: [] }),
  'media.request': () => { throw new Error('内核未接入：media.request（P2）'); },
};
handle('core:invoke', async (action, payload) => {
  // 前端契约（实测自 dist）：invoke 返回 { ok, data } / { ok:false, error:{message,code} }，
  // 登录等判定 data.success，故这里统一包装
  const fn = CORE[String(action)];
  if (!fn) return { ok: false, error: { message: '未知内核方法: ' + action, code: -1 } };
  try {
    // 允许 action 返回 Promise（文本推理等异步能力）
    return { ok: true, data: await fn(payload) };
  } catch (err) {
    return { ok: false, error: { message: String((err && err.message) || err), code: -1 } };
  }
});

/* ---------------- 本地视频网关（127.0.0.1:8788） ----------------
 * 8787 让给真正的豆包助手（页面「豆包插件」用的那条链路）。
 * 这里随主程序拉起自带的网关（tools/video-gateway.cjs），退出时一起收掉；
 * 它在 mock 模式出占位片、proxy 模式转发真实视频 API、helper 模式借豆包账号池出片。
 */
let videoGatewayProc = null;
const VG_PORT = Number(process.env.MJ_VG_PORT || 8788);

function portInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

async function gatewayHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${VG_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j && j.service === 'xingyuan-video-gateway';
  } catch {
    return false;
  }
}

async function startVideoGateway() {
  if (process.env.MJ_NO_VIDEO_GATEWAY === '1') { log('[vg] 已按 MJ_NO_VIDEO_GATEWAY 跳过'); return; }
  const script = path.join(ROOT, '..', 'tools', 'video-gateway.cjs');
  if (!fs.existsSync(script)) { log('[vg] 缺少网关脚本，跳过'); return; }
  if (await gatewayHealthy()) { log('[vg] 已有本程序网关在跑，沿用'); return; }
  if (await portInUse(VG_PORT)) { log(`[vg] ${VG_PORT} 被其他程序占用，不抢端口`); return; }
  try {
    const out = fs.openSync(path.join(LOG_DIR, 'video-gateway.stdout.log'), 'a');
    videoGatewayProc = spawn(process.execPath, [script], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VG_PORT: String(VG_PORT) },
      stdio: ['ignore', out, out],
    });
    videoGatewayProc.on('exit', (code) => {
      log('[vg] 退出 code=', code);
      videoGatewayProc = null;
    });
    log('[vg] 已拉起本地视频网关 pid=', videoGatewayProc.pid);
    // 等它真的能响应再往下走
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      if (await gatewayHealthy()) { log('[vg] 网关就绪'); return; }
    }
    log('[vg] 网关 3s 内未就绪，继续启动界面（视频功能会报连接失败）');
  } catch (e) {
    log('[vg] 启动失败', e.message);
  }
}

function stopVideoGateway() {
  if (videoGatewayProc) {
    try { videoGatewayProc.kill(); } catch { /* ignore */ }
    videoGatewayProc = null;
  }
}

/* 前端「取消生成」原先调 electronAPI.jimeng.cancelVideo，但壳层从来没实现过这个 IPC，
 * 结果只 abort 了渲染层自己的 fetch，网关与豆包助手完全不知道，豆包还会继续把这一单跑完
 * （用户看到的就是「我明明取消了，豆包又自己打开生成同一个分镜」）。
 * 这里补上：带 taskId 就只取消这一个网关任务，没带才退化成整批取消
 * （以前一律 /cancel，点一个分镜的「取消生成」会把其它正在跑的分镜一起掐掉）。 */
ipcMain.handle('jimeng:cancelVideo', async (_e, payload) => {
  try {
    const taskId = String((payload && (payload.taskId || payload.task_id)) || '').trim();
    const url = taskId
      ? `http://127.0.0.1:${VG_PORT}/tasks/${encodeURIComponent(taskId)}/cancel`
      : `http://127.0.0.1:${VG_PORT}/cancel`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'frontend-cancel', token: (payload && payload.token) || '', taskId }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    log('[vg] 前端取消 → 网关', JSON.stringify(j).slice(0, 160));
    return { ok: true, data: j };
  } catch (e) {
    log('[vg] 前端取消失败', String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

function stopAllHelpers() {
  stopVideoGateway();
  try { doubaoHelper.stop(); } catch { /* ignore */ }
}

/* ---- 退出拦截：图还在传的时候关窗，等于把已经扣费的结果扔掉 ----
 * 上游「收钱即开工」，客户端断开也照画不误，但成品只往当时那条连接发一次。
 * 所以这里同步拦一道，让用户自己决定是等一下还是放弃。 */
let quitConfirmed = false;
app.on('before-quit', (e) => {
  if (quitConfirmed || paidInFlight <= 0) return;
  e.preventDefault();
  let leave = false;
  try {
    const opts = {
      type: 'warning',
      buttons: ['继续等待', '确定退出（会丢图）'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '还有图片正在传回',
      message: `还有 ${paidInFlight} 张图正在从上游传回本机`,
      detail: '这些图已经扣费，现在退出会中断传输，等于白花钱（上游不会重发）。\n'
        + '建议等传输完成再关；确实要退出就选第二个按钮。',
    };
    const r = win && !win.isDestroyed() && win.isVisible()
      ? dialog.showMessageBoxSync(win, opts)
      : dialog.showMessageBoxSync(opts);
    leave = r === 1;
  } catch {
    leave = true; /* 弹窗本身出错就别拦着用户了 */
  }
  if (leave) { quitConfirmed = true; app.quit(); return; }
  /* 选了「继续等待」但窗口已经被关掉了：把窗口拉回来，别留一个没有界面的僵尸进程。
   * 否则之后每次双击图标都只会提示「已有实例在运行」，看起来就是软件打不开。 */
  try {
    if (!win || win.isDestroyed()) {
      createWindow();
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } catch { /* 拉不起来也不阻断，用户还能从任务管理器结束 */ }
});
app.on('will-quit', stopAllHelpers);
// 被拦下来的那一次不能停后台助手，否则等于「假退出」，再点生成就起不来
app.on('before-quit', () => { if (paidInFlight <= 0 || quitConfirmed) stopAllHelpers(); });
// app.exit() 不触发 will-quit，探针模式靠这个兜住，避免留下孤儿进程
process.on('exit', stopAllHelpers);

/* ---------------- 桌面快捷方式 ----------------
 * .cmd 入口只能显示命令行的图标，想要自定义图标必须是 .lnk。
 * 本机 cmd/WScript.Shell 的 COM 被安全策略拦，所以用 Electron 自带的
 * shell.writeShortcutLink 来写（它走 Win32 ShellLink，不经过 COM）。 */
function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return { ok: false, reason: 'win32 only' };
  let dir = '';
  try { dir = app.getPath('desktop'); } catch { /* ignore */ }
  if (!dir || !fs.existsSync(dir)) return { ok: false, reason: '找不到桌面目录' };
  const lnk = path.join(dir, `${APP_NAME}.lnk`);
  // 打包后 exe 自己就能启动（resources/app 由 Electron 接管），不能再塞 main.cjs 参数：
  // 安装目录可能被用户改到别处，写死相对路径会让快捷方式在升级后失效。
  const packaged = app.isPackaged;
  const opts = {
    target: process.execPath,
    args: packaged ? '' : `"${path.join(ROOT, 'main.cjs')}"`,
    cwd: packaged ? path.dirname(process.execPath) : path.join(ROOT, '..'),
    description: `${APP_NAME} · 漫剧创作引擎`,
    icon: ICON_ICO,
    iconIndex: 0,
    appUserModelId: 'com.xinghe.aigc',
  };
  const exists = fs.existsSync(lnk);
  if (exists) {
    const cur = readBackShortcut(lnk);
    // 已经指向本程序 + 本图标就原样保留（实测 update/replace 在这台机器上都返回 false）
    const sameTarget = cur.target && path.normalize(cur.target).toLowerCase() === path.normalize(process.execPath).toLowerCase();
    const sameIcon = cur.icon && path.normalize(cur.icon).toLowerCase() === path.normalize(ICON_ICO).toLowerCase();
    if (sameTarget && sameIcon) return { ok: true, path: lnk, action: 'exists' };
  }

  // 先写到同目录的临时名，再改名顶替旧文件：
  // 桌面在 D:、项目在 C:，跨盘 rename 会报 EXDEV，所以备份只做「复制」不做「移动」
  const tmp = path.join(dir, `.${APP_NAME}.lnk.tmp`);
  let okWrite = false;
  try {
    if (exists) {
      try {
        const bakDir = path.join(ROOT, '..', 'backup');
        fs.mkdirSync(bakDir, { recursive: true });
        const bak = path.join(bakDir, `${APP_NAME}.lnk.bak-${Date.now()}`);
        fs.copyFileSync(lnk, bak);
        log('shortcut backed up', bak);
      } catch (e) { log('shortcut backup failed', e.message); }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    okWrite = shell.writeShortcutLink(tmp, 'create', opts);
    if (okWrite) {
      // 三步兜底：直接顶替 → 先删旧再顶替 → 删不了就只留临时文件（下次启动再试）
      try {
        fs.renameSync(tmp, lnk);
      } catch (e1) {
        log('shortcut replace failed, try delete-then-rename', e1.code || e1.message);
        try { fs.rmSync(lnk, { force: true }); } catch (e2) { log('shortcut delete failed', e2.code || e2.message); }
        fs.renameSync(tmp, lnk);
      }
    }
  } catch (e) {
    log('shortcut write failed', e.code || e.message);
    okWrite = false;
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  log('desktop shortcut', exists ? 'refresh' : 'create', okWrite ? 'ok' : 'failed', lnk);
  return { ok: !!okWrite, path: okWrite ? lnk : '', action: exists ? 'refresh' : 'create' };
}

function readBackShortcut(p) {
  try {
    const d = shell.readShortcutLink(p);
    return { target: d.target, args: d.args, icon: d.icon, iconIndex: d.iconIndex, cwd: d.cwd, desc: d.description };
  } catch (e) { return { error: e.message }; }
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(async () => {
  log('app ready, appDir=', APP_DIR, 'dataDir=', DATA_DIR,
    'channel=', devMode.channel(), 'marker=', devMode.cfgFile() || '(none)');

  // 去掉 Electron 自带的那条英文菜单（File/Edit/View/Window/Help）：
  // 这个应用没有用户需要的菜单项，留着只是多一行英文开发菜单
  Menu.setApplicationMenu(null);

  if (!HAS_LOCK) {
    log('已有实例在运行，本进程退出（窗口会被拉到前台）');
    app.exit(0);
    return;
  }

  // 维护入口：只刷新桌面快捷方式然后退出（MJ_MAKE_SHORTCUT=1）
  if (process.env.MJ_MAKE_SHORTCUT === '1') {
    const r = ensureDesktopShortcut();
    log('MJ_MAKE_SHORTCUT', JSON.stringify(r));
    if (r.path) log('shortcut readback', JSON.stringify(readBackShortcut(r.path)));
    setTimeout(() => app.exit(r.ok ? 0 : 3), 200);
    return;
  }

  registerLocalFileProtocol();
  seedSettingsOnce();
  mergeSeedPromptPresets();

  /* 历史数据兜底：早期「导入分镜」只把 @role_xxx 这类 ID 写进本集资产表，姓名/描述丢了，
   * 表现就是第 1 集正常、第 2 集一导入角色设置全变成 role_xxx。这里按同一作品回填，幂等。 */
  try {
    const { repairJobs, fillAssetRefs, looksLikeId } = require('./asset-repair.cjs');
    const r = repairJobs(loadJobs());
    /* 补图片引用：不同页面写盘时字段不统一，imageUrl 常被抹空 → 卡片没缩略图 */
    const f = fillAssetRefs(r.jobs, path.join(DATA_DIR, 'assets'));
    /* 统一归一化：历史空壳（name=role_xxx）+ 分镜里指向不存在实体的引用，
     * 启动时一次性修干净，之后读写都会保持。1.0.22 */
    const n = normalizeJobsInPlace(f.jobs);
    if (r.changed || f.changed || n.changed) {
      backupJobsFile('before-assetrepair');
      saveJobs(f.jobs);
      log('[asset-repair] 回填完成', JSON.stringify({ ...r.stats, refs: f.stats }));
      logNormalizeReport('启动', n);
    }
    if (n.dangling.length) log('[asset] 分镜引用了表里没有的实体（未能自动补）', `${n.dangling.length} 条`, n.dangling.slice(0, 12).join(' '));
    /* 自检：日志里出现这条就说明还有「名字是编号」的资产（角色设置会显示 role_xxx）。
     * 正常情况下回填后应为 0；留着方便客户反馈时一眼定位。 */
    try {
      const audit = [];
      const noDesc = [];
      for (const job of f.jobs) {
        for (const field of ['updated_roles', 'updated_scenes', 'updated_props']) {
          for (const it of ((job.script_json || {})[field] || [])) {
            const nm = String((it && it.name) || '').trim();
            if (!nm || looksLikeId(nm)) audit.push(`ep${job.episodeNo || '?'}:${field}:${nm || '(空)'}`);
            if (!String((it && it.description) || '').trim()) noDesc.push(`ep${job.episodeNo || '?'}:${field}:${nm || '?'}`);
          }
        }
      }
      if (audit.length) log('[asset-audit] 仍有未命名资产', `${audit.length} 条`, audit.slice(0, 12).join(' '));
      if (noDesc.length) log('[asset-audit] 空描述资产', `${noDesc.length} 条`, noDesc.slice(0, 12).join(' '));
    } catch { /* 自检失败不影响启动 */ }
  } catch (e) {
    log('[asset-repair] 跳过', (e && e.message) || e);
  }

  /* 一次性历史迁移（1.0.19）：老版本「导入分镜」会把兄弟集整表资产并进本集，
   * 代码断掉后已落盘的脏数据不会自己消失。重开软件时清一次，删掉的进回收站。
   * 只跑一次，标记在数据目录；新建的分集由前端 + job:create 守卫保证干净。 */
  try {
    require('./episode-isolation.cjs').migrate(JOBS_FILE, DATA_DIR, log);
  } catch (e) {
    log('[isolate] 跳过', (e && e.message) || e);
  }
  const server = await startStaticServer();
  if (!server) {
    // 端口被占：最常见是上一版（没有单实例锁）的窗口还开着，直接退出会让用户以为图标点不动
    if (!PROBE) {
      dialog.showErrorBox(
        `${APP_NAME} 启动失败`,
        `端口 ${PORT} 已被占用。\n\n通常是已经有一个 ${APP_NAME} 窗口在运行，请先把旧窗口关掉，再双击桌面图标。`,
      );
    }
    app.exit(2);
    return;
  }
  await startProxyServer();
  // 先接豆包助手（8787），再起本地视频网关（8788），两者互不抢端口
  try { await doubaoHelper.start(); } catch (e) { log('[doubao] 启动失败', e.message); }
  await startVideoGateway();
  createWindow();

  /* 在线热更新：窗口出来 8 秒后静默查一次（不阻塞启动）。
   * 生成中不打扰；MJ_NO_UPDATE=1 可在调试时关掉。 */
  try {
    updater.init({ isBusy: () => paidInFlight > 0, dataDir: DATA_DIR });
    if (process.env.MJ_NO_UPDATE !== '1') {
      setTimeout(() => {
        updater.check({ silent: true }).catch((e) => log('[update] 检查异常', (e && e.message) || e));
      }, 8000);
    }
  } catch (e) {
    log('[update] 初始化失败', (e && e.message) || e);
  }

  if (PROBE && process.env.MJ_ROUTES) {
    // 逐路由巡检：一条路由一段，收集控制台报错、文本长度、交互元素数量、可选截图
    setTimeout(async () => {
      const routes = String(process.env.MJ_ROUTES).split(',').map((s) => s.trim()).filter(Boolean);
      const wait = Number(process.env.MJ_ROUTE_WAIT || 2600);
      const shotsDir = process.env.MJ_SHOTS_DIR || '';
      if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
      const results = [];
      if (process.env.MJ_AUTO_LOGIN === '1') {
        const actCode = String(process.env.MJ_ACTIVATION_CODE || 'LOCAL');
        const s1 = await win.webContents.executeJavaScript(`(async function(){
          const inputs = Array.from(document.querySelectorAll('input'));
          if (inputs.length >= 2) {
            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            set.call(inputs[0], 'local'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
            set.call(inputs[1], ${JSON.stringify(actCode)}); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          }
          const cb = document.querySelector('input[type=checkbox]');
          if (cb && !cb.checked) cb.click();
          const btn = Array.from(document.querySelectorAll('button')).find(b => /激活/.test(b.textContent));
          if (btn) { btn.click(); return 'clicked'; }
          return 'no-button:' + (document.body.innerText||'').slice(0,80);
        })()`, true).catch((e) => 'err ' + e.message);
        log('AUTO_LOGIN step1', s1);
        // 点完激活立刻抓一次：失败时的 toast 只显示几秒，等 5s 后再看就没了
        await new Promise((r) => setTimeout(r, 1600));
        try {
          if (process.env.MJ_SHOT_LOGIN) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.MJ_SHOT_LOGIN, img.toPNG());
            log('login shot saved', process.env.MJ_SHOT_LOGIN);
          }
          const tip = await win.webContents.executeJavaScript(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 260)`, true).catch(() => '');
          log('AUTO_LOGIN after-click: ' + tip);
        } catch (e) { log('login shot failed', e.message); }
        await new Promise((r) => setTimeout(r, 5000));
        const s2 = await win.webContents.executeJavaScript(`(function(){
          const btn = Array.from(document.querySelectorAll('button')).find(b => /我知道了/.test(b.textContent));
          if (btn) { btn.click(); return 'dismissed'; }
          return 'no-dialog';
        })()`, true).catch((e) => 'err ' + e.message);
        log('AUTO_LOGIN step2', s2);
        await new Promise((r) => setTimeout(r, 2000));
      }
      for (const route of routes) {
        const mark = consoleLines.length;
        await win.webContents.executeJavaScript(`location.hash = '#${route}'; 'ok'`, true);
        await new Promise((r) => setTimeout(r, wait));
        const state = await win.webContents.executeJavaScript(`(function(){
          const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const txt = (document.body ? document.body.innerText : '') || '';
          return {
            hash: location.hash,
            textLen: txt.length,
            text: txt.replace(/\\s+/g,' ').slice(0, 420),
            buttons: Array.from(document.querySelectorAll('button')).filter(vis).map(b=>b.textContent.trim()).filter(Boolean).slice(0,25),
            inputs: Array.from(document.querySelectorAll('input,textarea')).filter(vis).map(i=>i.placeholder||i.type||'').slice(0,15),
          };
        })()`, true).catch((e) => ({ evalError: e.message }));
        const errs = consoleLines.slice(mark).filter((l) => /\[c3\]|\[c2\]|ERR |handler .* error/.test(l));
        results.push({ route, state, errs: errs.slice(0, 8) });
        if (shotsDir) {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotsDir, route.replace(/[^a-z0-9]+/gi, '_') + '.png'), img.toPNG());
          } catch { /* ignore */ }
        }
      }
      if (process.env.MJ_CLICKS) {
        const clicks = String(process.env.MJ_CLICKS).split(',').map((s) => s.trim()).filter(Boolean);
        if (!routes.length) {
          await win.webContents.executeJavaScript(`location.hash = '#/home/menu'; 'ok'`, true);
          await new Promise((r) => setTimeout(r, 2000));
        }
        for (const label of clicks) {
          const mark = consoleLines.length;
          const act = await win.webContents.executeJavaScript(`(async function(){
            const label = ${JSON.stringify(label)};
            if (label.startsWith('type:')) {
              const v = label.slice(5);
              const els = Array.from(document.querySelectorAll('input,textarea')).filter((e) => e.getBoundingClientRect().width > 0);
              const el = els.length ? els[els.length - 1] : null;
              if (!el) return 'no-input';
              const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
              return 'typed';
            }
            const all = Array.from(document.querySelectorAll('body *')).filter((e) => e.getBoundingClientRect().width > 0 && e.children.length <= 2);
            const els = all.filter((e) => e.textContent.trim() === label || (e.textContent.includes(label) && e.textContent.trim().length <= label.length + 3));
            const el = els[els.length - 1];
            if (!el) return 'not-found';
            (el.closest('button') || el).click();
            return 'clicked';
          })()`, true).catch((e) => 'err ' + e.message);
          await new Promise((r) => setTimeout(r, 3000));
          const errs = consoleLines.slice(mark).filter((l) => /\[c3\]|\[c2\]|error/i.test(l));
          const text = await win.webContents.executeJavaScript(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`, true).catch(() => '');
          results.push({ click: label, act, text, errs: errs.slice(0, 6) });
          if (shotsDir) {
            try {
              const img = await win.webContents.capturePage();
              fs.writeFileSync(path.join(shotsDir, 'click_' + label.replace(/[^a-z0-9]+/gi, '_') + '.png'), img.toPNG());
            } catch { /* ignore */ }
          }
        }
      }
      if (process.env.MJ_EVAL) {
        const v = await win.webContents.executeJavaScript(process.env.MJ_EVAL, true).catch((e) => 'EVAL_ERR ' + e.message);
        log('EVAL_RESULT ' + JSON.stringify(v));
        if (process.env.MJ_SHOT_AFTER) {
          try {
            // 隐藏窗口不渲染，抓帧前短暂显示一下，抓完立刻隐藏，避免长期可见窗口接到杂散输入
            const wasVisible = win.isVisible();
            if (!wasVisible) { win.showInactive(); await new Promise((r) => setTimeout(r, 900)); }
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.MJ_SHOT_AFTER, img.toPNG());
            if (!wasVisible) win.hide();
            log('shot after saved', process.env.MJ_SHOT_AFTER);
          } catch (e) { log('shot after failed', e.message); }
        }
      }
      log('ROUTES_RESULT ' + JSON.stringify(results, null, 2));
      app.exit(0);
    }, Number(process.env.MJ_WAIT || 5000));
    return;
  }

  if (PROBE) {
    setTimeout(async () => {
      const out = { console: consoleLines.slice(0, 60) };
      try {
        out.dom = await win.webContents.executeJavaScript(`(function(){
          return {
            title: document.title,
            bodyLen: document.body ? document.body.innerHTML.length : 0,
            appHtml: (document.querySelector('#app')||{}).innerHTML ? document.querySelector('#app').innerHTML.length : 0,
            navCount: document.querySelectorAll('nav a, nav button, .nav-item, aside a, aside button').length,
            hasDesktop: !!(window.desktop || window.electronAPI),
            apiKeys: window.electronAPI ? Object.keys(window.electronAPI) : [],
            flygenKeys: window.flygen ? Object.keys(window.flygen) : [],
            text: (document.body ? document.body.innerText : '').slice(0, 600),
          };
        })()`, true);
      } catch (e) { out.domError = e.message; }
      log('PROBE_RESULT ' + JSON.stringify(out, null, 2));
      if (process.env.MJ_SHOT) {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.MJ_SHOT, img.toPNG());
          log('shot saved', process.env.MJ_SHOT);
        } catch (e) { log('shot failed', e.message); }
      }
      app.exit(0);
    }, Number(process.env.MJ_WAIT || 6000));
  }
}).catch((e) => { log('FATAL', e && e.stack); app.exit(1); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
