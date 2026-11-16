'use strict';
/**
 * 热更新纯逻辑层（不 require electron，可单独用 node 跑测试）
 *
 * 负责：版本号比较、清单签名/验签、文件差异计算、路径白名单、sha256。
 * IO / 下载 / 弹窗都在 updater.cjs，发布端在 tools/publish-hotfix.cjs。
 *
 * 清单格式（latest.json）：
 * {
 *   "version": "1.0.12",
 *   "notes": "修复…",
 *   "pubDate": "2026-11-15T03:10:00.000Z",
 *   "fileBase": "files/",
 *   "files": [{ "path": "electron/main.cjs", "size": 111234, "sha256": "..." }],
 *   "sig": "hmac-sha256-hex"
 * }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/* 只允许覆盖这些目录，且必须在应用根目录内 —— 防止清单被篡改成任意路径写文件。
 * tools/ 里的 js/cjs（视频网关、发布脚本）必须能热更，否则改一次网关又得发 129MB 安装包；
 * 但 .exe/.dll 这类二进制一律拒绝，它们只能随安装包走。 */
const ALLOW_PREFIX = ['app/', 'electron/', 'data/', 'tools/', 'package.json'];
const DENY_BINARY = /\.(exe|dll|node|bin|so|dylib|pyd|msi|jar)$/i;
const DENY_SEG = new Set(['', '.', '..', '.git', 'node_modules']);
const MAX_FILE = 80 * 1024 * 1024;      /* 单文件 80MB 上限 */
const MAX_TOTAL = 600 * 1024 * 1024;    /* 一次更新总量上限 */

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* 清单签名的规范化串：版本 + 每个文件的路径与摘要，顺序固定 */
function manifestPayload(m) {
  const files = Array.isArray(m && m.files) ? m.files : [];
  const lines = files
    .map((f) => `${String(f && f.path || '')}:${String(f && f.sha256 || '')}:${Number(f && f.size) || 0}`)
    .sort();
  return `v1\n${String(m && m.version || '')}\n${lines.join('\n')}`;
}

function signManifest(m, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(manifestPayload(m)).digest('hex');
}

function verifyManifest(m, secret) {
  if (!m || typeof m !== 'object') return { ok: false, reason: '清单为空' };
  if (!m.version || !Array.isArray(m.files) || !m.files.length) return { ok: false, reason: '清单字段不完整' };
  const want = String(m.sig || '').toLowerCase();
  if (!want) return { ok: false, reason: '清单未签名' };
  const got = signManifest(m, secret);
  if (got.length !== want.length) return { ok: false, reason: '签名长度不符' };
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { ok: false, reason: '签名校验失败' };
  for (const f of m.files) {
    const chk = checkRelPath(f && f.path);
    if (!chk.ok) return { ok: false, reason: `非法路径 ${chk.path}` };
    const sz = Number(f && f.size) || 0;
    if (sz < 0 || sz > MAX_FILE) return { ok: false, reason: `文件过大 ${chk.path}` };
    if (!/^[0-9a-f]{64}$/i.test(String(f && f.sha256 || ''))) return { ok: false, reason: `摘要格式错 ${chk.path}` };
  }
  const total = m.files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  if (total > MAX_TOTAL) return { ok: false, reason: '更新总量超限' };
  return { ok: true };
}

/* 相对路径白名单：必须落在允许目录里，且不能出现 .. / 盘符 / 绝对路径 */
function checkRelPath(p) {
  const raw = String(p || '').replace(/\\/g, '/').trim();
  if (!raw) return { ok: false, path: raw };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return { ok: false, path: raw };
  const parts = raw.split('/');
  if (parts.some((s) => DENY_SEG.has(s))) return { ok: false, path: raw };
  if (parts.some((s) => /[:*?"<>|]/.test(s))) return { ok: false, path: raw };
  const norm = parts.join('/');
  if (DENY_BINARY.test(norm)) return { ok: false, path: norm };
  const allowed = ALLOW_PREFIX.some((pre) => (pre.endsWith('/') ? norm.startsWith(pre) : norm === pre));
  return { ok: allowed, path: norm };
}

/* 解析为绝对路径，并再次确认没跳出 appRoot */
function resolveInside(appRoot, rel) {
  const chk = checkRelPath(rel);
  if (!chk.ok) return null;
  const abs = path.resolve(appRoot, chk.path);
  const root = path.resolve(appRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function sha256File(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return '';
  } catch { return ''; }
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return h.digest('hex');
}

/* 本地已是最新？逐文件比对摘要，返回需要下载的清单 */
function diffFiles(appRoot, manifest) {
  const need = [];
  for (const f of manifest.files) {
    const abs = resolveInside(appRoot, f.path);
    if (!abs) continue;
    const local = sha256File(abs);
    if (local !== String(f.sha256).toLowerCase()) {
      need.push({ path: f.path, size: Number(f.size) || 0, sha256: String(f.sha256).toLowerCase() });
    }
  }
  return need;
}

/* 需要重启吗：只有 app/assets 下的前端 chunk 可以靠页面刷新生效，
 * 但为可预测，统一走重启（回滚逻辑也只需一套）。这里保留判断供日志用。 */
function needRestart(need) {
  return need.some((f) => !/^app\/assets\//.test(f.path));
}

function joinUrl(base, rel) {
  const b = String(base || '');
  const r = String(rel || '').replace(/^\/+/, '');
  return b.endsWith('/') ? b + r : `${b}/${r}`;
}

/* ---------------- 网络（不依赖 electron，方便单测） ---------------- */

const CONNECT_TIMEOUT = 15000;
const IDLE_TIMEOUT = 60000;
const MAX_REDIRECT = 3;

function request(urlStr, { method = 'GET' } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('地址不合法')); return; }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) { reject(new Error('只支持 http/https')); return; }
    const req = mod.request(u, { method, headers: { 'user-agent': 'xinghe-updater/1' } }, (res) => {
      const code = Number(res.statusCode) || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECT) { reject(new Error('重定向次数过多')); return; }
        const next = new URL(res.headers.location, u).toString();
        resolve(request(next, { method }, redirects + 1));
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code}`)); return; }
      resolve(res);
    });
    req.setTimeout(CONNECT_TIMEOUT, () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchText(urlStr) {
  const res = await request(urlStr);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      try { res.destroy(); } catch { /* ignore */ }
      reject(new Error('读取超时'));
    }, IDLE_TIMEOUT);
    res.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        clearTimeout(timer);
        try { res.destroy(); } catch { /* ignore */ }
        reject(new Error('清单过大'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function fetchJson(urlStr) {
  const txt = await fetchText(urlStr);
  try { return JSON.parse(txt); } catch { throw new Error('清单不是合法 JSON'); }
}

/* 流式下载到文件，同时算 sha256；返回 {sha256,size} */
function downloadTo(urlStr, dest, limit) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    request(urlStr).then((res) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      const h = crypto.createHash('sha256');
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          try { res.destroy(); } catch { /* ignore */ }
          out.destroy();
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          fail(new Error('文件超过大小上限'));
          return;
        }
        h.update(c);
      });
      res.pipe(out);
      out.on('finish', () => {
        if (settled) return;
        try { fs.renameSync(tmp, dest); } catch (e) { fail(e); return; }
        settled = true;
        resolve({ sha256: h.digest('hex'), size });
      });
      out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } fail(e); });
      res.on('error', (e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } fail(e); });
    }).catch(fail);
  });
}

module.exports = {
  cmpVersion,
  manifestPayload,
  signManifest,
  verifyManifest,
  checkRelPath,
  resolveInside,
  sha256File,
  diffFiles,
  needRestart,
  joinUrl,
  request,
  fetchText,
  fetchJson,
  downloadTo,
  ALLOW_PREFIX,
  MAX_FILE,
  MAX_TOTAL,
};
