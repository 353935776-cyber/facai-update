'use strict';
/**
 * 在线热更新（免安装包）
 *
 * 为什么能这么干：`build.asar = false`，安装目录下的 resources/app 就是一堆明文散文件，
 * 替换文件 + 重启进程即可生效，不需要重新跑安装程序、不需要代码签名。
 *
 * 安全边界（放心写盘的前提）：
 *  1) 清单必须带 HMAC-SHA256 签名（密钥与激活码同一套，内嵌在 license.cjs）；
 *  2) 每个文件带 sha256，下载后逐字节校验，不符就整批放弃；
 *  3) 只允许写 app/ electron/ data/ tools/ package.json，路径不许出现 .. 或盘符；
 *  4) 覆盖前把旧文件备份到 userData/hotfix/backup/<旧版本>/，连续启动失败自动回滚。
 *
 * 使用：
 *   main.cjs 里 updater.init({ isBusy }); 启动后 updater.check({ silent:true });
 *   更新源地址取值顺序：环境变量 XH_HOTFIX_URL > userData/update.json 的 url > 内置 DEFAULT_URL。
 */

const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const core = require('./updater-core.cjs');
/* 网络实现统一放 core，且始终经 core.xxx 调用 —— 单测可直接替换实现来模拟多源故障 */

/* 正式更新源：改成你自己的静态托管地址（结尾是 latest.json 或 latest.json 所在目录） */
const DEFAULT_URL = '';

const APP_ROOT = path.resolve(__dirname, '..');
const HEALTH_DELAY = 20000;      /* 启动后 20 秒无异常视为这次启动成功 */

let isBusy = () => false;
let started = false;
let running = false;
let dataRoot = '';

function dataDir() {
  return dataRoot || app.getPath('userData');
}
function hotfixDir() {
  return path.join(dataDir(), 'hotfix');
}
function stateFile() {
  return path.join(hotfixDir(), 'state.json');
}
function backupRoot() {
  return path.join(hotfixDir(), 'backup');
}

function readJson(p, dft) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : dft;
  } catch { return dft; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function log(...a) {
  try { console.log('[update]', ...a); } catch { /* ignore */ }
}

/* ---------------- 配置与版本 ---------------- */

/* 更新源可以是多个：GitHub 直连国内经常不通、jsDelivr 又有缓存，
 * 所以允许配一串地址，按顺序自动试，谁能用用谁。 */
function validUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.length > 500) return false;
  return /^https?:\/\//i.test(s) || /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s);
}
function normalizeUrls(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\r\n,;]+/);
  const out = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}
function cfgUrls(f) {
  if (!f || typeof f !== 'object') return [];
  const raw = [];
  for (const k of ['url', 'urls', 'mirrors']) {
    const v = f[k];
    if (Array.isArray(v)) raw.push(...v);
    else if (v) raw.push(v);
  }
  return normalizeUrls(raw);
}

function readCfg() {
  const env = String(process.env.XH_HOTFIX_URL || '').trim();
  if (env) {
    const urls = normalizeUrls(env);
    return { urls, url: urls[0] || '', auto: true, source: 'env' };
  }
  /* 两个可填地址的地方：用户数据目录（升级不覆盖）优先，随包的 data/update.json 兜底。 */
  for (const [p, source] of [
    [path.join(dataDir(), 'update.json'), 'userData'],
    [path.join(APP_ROOT, 'data', 'update.json'), 'bundle'],
  ]) {
    const f = readJson(p, null);
    const urls = cfgUrls(f);
    if (!urls.length) continue;
    return {
      urls,
      url: urls[0],
      auto: f.auto !== false,
      silentInstall: f.silentInstall === true,
      source,
    };
  }
  const urls = normalizeUrls(DEFAULT_URL);
  return { urls, url: urls[0] || '', auto: true, source: 'builtin' };
}

/* 让客服/客户在界面里直接填更新地址，写进 userData（升级不会覆盖）。
 * 这是「第一跳」的关键：已发出的安装包里 url 为空，配一次之后就全靠热更，不用再发安装包。 */
function cfgFile() { return path.join(dataDir(), 'update.json'); }

function setUrl(raw) {
  const urls = normalizeUrls(raw);
  if (!urls.length) return { ok: false, message: '地址不能为空' };
  if (urls.length > 8) return { ok: false, message: '最多填 8 个地址' };
  const bad = urls.find((u) => !validUrl(u));
  if (bad) return { ok: false, message: `地址格式不对：${bad}` };
  const prev = readJson(cfgFile(), {}) || {};
  const next = { ...prev, auto: prev.auto !== false };
  delete next.mirrors;
  delete next.urls;
  next.url = urls.length === 1 ? urls[0] : urls;
  writeJson(cfgFile(), next);
  log('更新地址已设为', urls.join(' | '));
  return { ok: true, url: urls[0], urls, source: 'userData' };
}

/* CDN 会缓存 latest.json 和 files/（jsDelivr 对分支缓存可达 12 小时）。
 * 清单每次加时间戳、文件按版本号加参数，让缓存 key 变化；真拿到旧内容还有
 * sha256 校验 + 换源兜底，不会出现「明明发了新版客户却说已是最新」。 */
function bust(u) {
  const s = String(u);
  return `${s}${s.indexOf('?') >= 0 ? '&' : '?'}_=${Date.now()}`;
}
function versioned(u, v) {
  const s = String(u);
  return `${s}${s.indexOf('?') >= 0 ? '&' : '?'}v=${encodeURIComponent(String(v || ''))}`;
}
/* 国内访问 raw.githubusercontent.com 常常是黑洞，不能让一个源拖死整次检查 */
function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}超时 ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/* 没有服务器也能用：把发布目录整个拷到本机/共享盘，url 直接填那个目录或里面的 latest.json。
 * 这样客户仍要拿一次小目录，但只有几 MB，且软件会自动检测并应用，不用重装 129MB 安装包。 */
function isLocalSource(u) {
  return !/^https?:\/\//i.test(String(u || '').trim());
}
function localRootOf(u) {
  const s = String(u || '').trim();
  try { if (fs.statSync(s).isDirectory()) return s; } catch { /* 当成文件路径 */ }
  return path.dirname(s);
}
function readLocalManifest(u) {
  return JSON.parse(fs.readFileSync(path.join(localRootOf(u), 'latest.json'), 'utf8'));
}

function localVersion() {
  const st = readJson(stateFile(), null);
  if (st && st.version) return String(st.version);
  try { return String(app.getVersion() || ''); } catch { return ''; }
}

/* ---------------- 网络：统一走 updater-core，避免两处实现 ---------------- */

/* ---------------- 备份 / 应用 / 回滚 ---------------- */

function canWrite() {
  try {
    const probe = path.join(APP_ROOT, `.write-probe-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function backupFiles(need, fromVersion) {
  const dir = path.join(backupRoot(), String(fromVersion || 'unknown'));
  for (const f of need) {
    const src = core.resolveInside(APP_ROOT, f.path);
    if (!src || !fs.existsSync(src)) continue;
    const dst = core.resolveInside(dir, f.path);
    if (!dst) continue;
    if (fs.existsSync(dst)) continue;     /* 同一版本反复更新时，保留最早那份，回滚才回到真旧版 */
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}

function listFiles(dir) {
  const out = [];
  const walk = (d, base) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

async function downloadAll(manifest, need, cfg) {
  const staging = path.join(hotfixDir(), 'staging');
  rmrf(staging);
  fs.mkdirSync(staging, { recursive: true });
  const urls = (cfg.urls && cfg.urls.length) ? cfg.urls : [cfg.url];
  const done = [];
  for (const f of need) {
    const dest = core.resolveInside(staging, f.path);
    if (!dest) throw new Error(`非法路径 ${f.path}`);
    let ok = false;
    let lastErr = '';
    /* 每个文件都按源顺序试：GitHub 直连超时、jsDelivr 缓存旧内容、镜像挂掉，
     * 都能自动落到下一个源，sha256 不过关就当这个源不可用。 */
    for (const u of urls) {
      try {
        let r;
        if (isLocalSource(u)) {
          const localBase = path.resolve(localRootOf(u), String(manifest.fileBase || ''));
          const src = core.resolveInside(localBase, f.path);
          if (!src || !fs.existsSync(src)) throw new Error(`本地更新源缺文件 ${f.path}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          r = { sha256: core.sha256File(dest), size: fs.statSync(dest).size };
        } else {
          const base = manifest.fileBase
            ? new URL(String(manifest.fileBase), u).toString()
            : u;
          r = await core.downloadTo(versioned(core.joinUrl(base, f.path), manifest.version), dest, core.MAX_FILE);
        }
        if (r.sha256 !== f.sha256) throw new Error('sha256 不符（可能是 CDN 旧缓存）');
        if (Number(f.size) && r.size !== Number(f.size)) throw new Error('大小不符');
        done.push(f);
        const host = isLocalSource(u) ? '本地目录' : String(u).replace(/^https?:\/\//i, '').split('/')[0];
        log(`已下载 ${f.path} ${(r.size / 1024).toFixed(0)}KB  ← ${host}`);
        ok = true;
        break;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        log(`源 ${u} 取 ${f.path} 失败：${lastErr}`);
      }
    }
    if (!ok) throw new Error(`${f.path}：所有更新源都试过了（${lastErr}）`);
  }
  return staging;
}

function applyStaged(staging, files) {
  const order = files.slice().sort((a, b) => {
    const rank = (p) => (/^package\.json$/.test(p) ? 2 : 0);
    return rank(a.path) - rank(b.path);
  });
  for (const f of order) {
    const src = core.resolveInside(staging, f.path);
    const dst = core.resolveInside(APP_ROOT, f.path);
    if (!src || !dst) throw new Error(`非法路径 ${f.path}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.hotfix-tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  }
}

async function apply(manifest, need, cfg, fromVersion) {
  if (!canWrite()) {
    return { ok: false, reason: 'readonly', message: '安装目录不可写，请用安装包更新' };
  }
  const staging = await downloadAll(manifest, need, cfg);
  let backupDir = '';
  try {
    backupDir = backupFiles(need, fromVersion);
    applyStaged(staging, need);
  } catch (e) {
    /* 边写边失败：把已经写坏的用备份顶回去 */
    try { restoreFrom(backupDir); } catch { /* ignore */ }
    rmrf(staging);
    return { ok: false, reason: 'write', message: `写入失败：${(e && e.message) || e}` };
  }
  rmrf(staging);
  writeJson(stateFile(), {
    version: String(manifest.version),
    prevVersion: String(fromVersion || ''),
    appliedAt: new Date().toISOString(),
    bootTries: 0,
    healthy: false,
    note: String(manifest.notes || ''),
  });
  log(`已应用 ${fromVersion} -> ${manifest.version}，${need.length} 个文件`);
  return { ok: true, version: String(manifest.version), count: need.length, backupDir };
}

function restoreFrom(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const rel of listFiles(dir)) {
    const src = core.resolveInside(dir, rel);
    const dst = core.resolveInside(APP_ROOT, rel);
    if (!src || !dst) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    n += 1;
  }
  return n;
}

function rollback(reason) {
  const st = readJson(stateFile(), null);
  if (!st || !st.prevVersion) return { ok: false, message: '没有可回滚的备份' };
  const dir = path.join(backupRoot(), String(st.prevVersion));
  if (!fs.existsSync(dir)) return { ok: false, message: '备份目录不存在' };
  const n = restoreFrom(dir);
  if (!n) return { ok: false, message: '备份为空' };
  writeJson(stateFile(), {
    version: String(st.prevVersion),
    prevVersion: '',
    appliedAt: new Date().toISOString(),
    bootTries: 0,
    healthy: true,
    rolledBack: true,
    note: String(reason || ''),
  });
  log(`已回滚到 ${st.prevVersion}（${n} 个文件）`);
  return { ok: true, version: String(st.prevVersion), count: n };
}

/* 启动守卫：连续 4 次启动都没撑过 HEALTH_DELAY 就判定新版本坏了，自动回滚 */
function bootGuard() {
  const st = readJson(stateFile(), null);
  if (!st || !st.appliedAt || !st.version) return;
  if (st.rolledBack) return;
  const tries = (Number(st.bootTries) || 0) + 1;
  st.bootTries = tries;
  writeJson(stateFile(), st);
  if (tries > 3) {
    const r = rollback(`连续 ${tries} 次启动失败`);
    if (r.ok) {
      const win = BrowserWindow.getAllWindows()[0];
      dialog.showMessageBox(win || null, {
        type: 'warning',
        title: '已自动回滚',
        message: `新版本无法正常启动，已回滚到 v${r.version}`,
        detail: '请关闭软件后重新打开。如果仍然异常，请联系作者重新安装。',
        buttons: ['知道了'],
      }).catch(() => {});
    }
    return;
  }
  setTimeout(() => {
    const cur = readJson(stateFile(), null);
    if (!cur || cur.version !== st.version) return;
    cur.bootTries = 0;
    cur.healthy = true;
    writeJson(stateFile(), cur);
  }, HEALTH_DELAY);
}

/* ---------------- 对外入口 ---------------- */

function info() {
  const cfg = readCfg();
  const st = readJson(stateFile(), null);
  return {
    configured: cfg.urls.length > 0,
    url: cfg.url,
    urls: cfg.urls,
    source: cfg.source,
    auto: cfg.auto,
    version: localVersion(),
    hotfix: st || null,
  };
}

async function check({ silent = true } = {}) {
  if (running) return { ok: false, reason: 'busy', message: '正在检查中' };
  const cfg = readCfg();
  if (!cfg.urls.length) return { ok: false, reason: 'noconfig', message: '未配置更新地址' };
  running = true;
  try {
    const secret = require('./license.cjs').secret();
    const from = localVersion();
    /* 依次试每个更新源：取清单 → 验签 → 比版本。第一个可用的拿来用；
     * 其余源在下载文件超时/校验不符时由 downloadAll 自动顶上。 */
    let picked = null;
    let lastErr = '';
    let upToDate = null;
    for (const u of cfg.urls) {
      try {
        const m = isLocalSource(u)
          ? readLocalManifest(u)
          : await withTimeout(core.fetchJson(bust(u)), 8000, '更新源');
        const sig = core.verifyManifest(m, secret);
        if (!sig.ok) { lastErr = `清单校验失败（${sig.reason}）`; log(u, lastErr); continue; }
        if (core.cmpVersion(m.version, from) <= 0) {
          /* 不一定真没更新：CDN 可能还缓存着旧清单，继续问后面的源 */
          if (!upToDate) upToDate = { ok: true, upToDate: true, version: from, latest: String(m.version), source: u };
          continue;
        }
        picked = { url: u, manifest: m };
        break;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        log('更新源不可用', u, lastErr);
      }
    }
    if (!picked) {
      if (upToDate) return upToDate;
      return { ok: false, reason: 'network', message: `所有更新源都不可用（${lastErr}）` };
    }
    const manifest = picked.manifest;
    const need = core.diffFiles(APP_ROOT, manifest);
    if (!need.length) {
      /* 文件都一样但版本号更高：把 state 里的版本对齐，免得每次启动都问 */
      const st = readJson(stateFile(), {}) || {};
      writeJson(stateFile(), { ...st, version: String(manifest.version), appliedAt: new Date().toISOString(), bootTries: 0, healthy: true });
      return { ok: true, upToDate: true, version: String(manifest.version) };
    }
    const sizeMb = (need.reduce((s, f) => s + (f.size || 0), 0) / 1048576).toFixed(1);

    const win = BrowserWindow.getAllWindows()[0] || null;
    if (isBusy()) {
      return { ok: false, reason: 'busy', message: '正在生成中，稍后再更新', pending: { version: manifest.version, need: need.length } };
    }
    /* 静默安装：默认关闭，只有 update.json 明确写 silentInstall:true 或
     * 环境变量 XH_HOTFIX_AUTO=1（自动化测试）才会不问直接装。 */
    const silentInstall = process.env.XH_HOTFIX_AUTO === '1' || cfg.silentInstall === true;
    if (silent) {
      if (!silentInstall) {
        const r = await dialog.showMessageBox(win || null, {
          type: 'info',
          title: '发现新版本',
          message: `v${from} → v${manifest.version}`,
          detail: `${String(manifest.notes || '').trim() || '包含若干改进与修复'}\n\n需要下载 ${need.length} 个文件，约 ${sizeMb} MB。更新完成后需要重启软件。`,
          buttons: ['立即更新', '稍后'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (r.response !== 0) return { ok: true, skipped: true };
      }
    }
    /* 选中的源排第一，其余作备用：某个文件在这个源上超时或校验不过就自动换下一个 */
    const ordered = { ...cfg, urls: [picked.url, ...cfg.urls.filter((u) => u !== picked.url)] };
    const applied = await apply(manifest, need, ordered, from);
    if (!applied.ok) {
      if (!silent) {
        dialog.showMessageBox(win || null, {
          type: 'error', title: '更新失败', message: applied.message || '更新失败', buttons: ['知道了'], noLink: true,
        }).catch(() => {});
      }
      return applied;
    }
    if (silentInstall) {
      app.relaunch();
      app.exit(0);
      return { ok: true, applied: true, version: applied.version, count: applied.count, restarted: true };
    }
    const ask = await dialog.showMessageBox(win || null, {
      type: 'info',
      title: '更新完成',
      message: `已更新到 v${applied.version}`,
      detail: '需要重启软件才能生效。现在重启吗？',
      buttons: ['立即重启', '稍后手动重启'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (ask.response === 0) {
      app.relaunch();
      app.exit(0);
    }
    return { ok: true, applied: true, version: applied.version, count: applied.count };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('检查失败：', msg);
    if (!silent) {
      const win = BrowserWindow.getAllWindows()[0];
      dialog.showMessageBox(win || null, {
        type: 'warning', title: '检查更新失败', message: msg, buttons: ['知道了'], noLink: true,
      }).catch(() => {});
    }
    return { ok: false, reason: 'network', message: msg };
  } finally {
    running = false;
  }
}

function init(opts = {}) {
  if (typeof opts.isBusy === 'function') isBusy = opts.isBusy;
  if (opts.dataDir) dataRoot = String(opts.dataDir);
  if (started) return;
  started = true;
  setTimeout(() => { try { bootGuard(); } catch (e) { log('启动守卫异常', e && e.message); } }, 1500);
}

module.exports = {
  init, check, info, setUrl, rollback, localVersion, dataDir, hotfixDir,
  _test: { normalizeUrls, cfgUrls, validUrl, bust, versioned, downloadAll },
};
