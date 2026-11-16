'use strict';
/**
 * 豆包视频助手（helper）进程管理 + HTTP 客户端
 *
 * 背景：原版软件把「豆包网页自动化」做成一个独立的 Go 二进制
 *   resources/doubao-extension/helper-bin/win-x64/server-win-x64.exe
 * 它监听 127.0.0.1:8787，用 Authorization: Bearer <token> 鉴权，
 * 提供 /accounts、/tasks、/chat-generate-video 等接口。
 *
 * 本壳原先只把 doubao:* 全部 stub 掉，导致「豆包插件」页永远是空的。
 * 这里按原版 manager.js 的契约重新接回来：
 *   - 复用原版数据目录（账号池、Chrome 用户目录、任务历史都在里面）
 *   - token 用与原版完全一致的派生算法，这样两个程序可以共用同一个 helper
 *   - 启动 / 停止 / 崩溃重启 / 状态上报
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const APP_DATA = path.join(process.env.APPDATA || os.homedir(), 'MJStudio');
const LOG_DIR = path.join(APP_DATA, 'logs');
const CONFIG_FILE = path.join(APP_DATA, 'doubao-config.json');

const DEFAULT_PORT = 8787;
const START_TIMEOUT_MS = 60000;
const MAX_AUTO_RESTART = 3;

/* ---------- 候选路径 ---------- */
const HELPER_BIN_CANDS = [
  path.join(__dirname, '..', 'tools', 'doubao-helper', 'win-x64', 'server-win-x64.exe'),
  path.join(__dirname, '..', 'tools', 'doubao-helper', 'server-win-x64.exe'),
];
const HELPER_ROOT_CANDS = [
  path.join(__dirname, '..', 'tools', 'doubao-helper'),
  'D:\\漫剧分镜台-A方案分享版\\resources\\doubao-extension',
];
// 原版数据目录：账号池 / Chrome profile / tasks.db 都在这里，优先复用
const DATA_DIR_CANDS = [
  'D:\\漫剧分镜台-A方案分享版\\data\\Roaming\\梦源AI\\doubao-data',
];

function firstExisting(list) {
  for (const p of list) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/* ---------- 配置 ---------- */
const saved = readJson(CONFIG_FILE, {});

const DATA_DIR = process.env.MJ_DOUBAO_DATA_DIR
  || saved.dataDir
  || firstExisting(DATA_DIR_CANDS)
  || path.join(APP_DATA, 'doubao-data');

// 原版算法：userDataDir（doubao-data 的父目录）+ 固定后缀
function deriveToken(userDataDir) {
  const seed = String(userDataDir || '') + '::mengyuan-doubao-local-token-v1';
  return 'LOCAL-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

const TOKEN = process.env.MJ_DOUBAO_TOKEN || saved.token || deriveToken(path.dirname(DATA_DIR));
// helper 只校验 env 注入的 token 与请求头一致，salt 本身不参与校验；固定存一份便于复现
const SALT = saved.salt || crypto.randomBytes(32).toString('hex');
if (!saved.token || !saved.salt) {
  writeJson(CONFIG_FILE, { ...saved, dataDir: DATA_DIR, token: TOKEN, salt: SALT, port: saved.port || DEFAULT_PORT });
}

const PORT = Number(process.env.MJ_DOUBAO_PORT || saved.port || DEFAULT_PORT);
const HOST = '127.0.0.1';

const state = {
  proc: null,
  owned: false,          // 是不是本进程拉起来的（别人的就不主动杀）
  running: false,
  pid: null,
  chrome: null,
  db: null,
  lastError: '',
  lastStartedAt: 0,
  lastStoppedAt: 0,
  enabled: true,
  restartCount: 0,
  starting: null,
};

const listeners = new Set();

function log(...args) {
  const line = `[${new Date().toISOString()}] [doubao] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'shell.log'), line + '\n');
  } catch { /* ignore */ }
  console.log(line);
}

function emit() {
  const s = status();
  for (const cb of listeners) {
    try { cb(s); } catch { /* ignore */ }
  }
}

/* ---------- HTTP ---------- */
function rawRequest(pathname, { method = 'GET', body, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'x-helper-secret': TOKEN,
      Accept: 'application/json, */*',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('helper 请求超时')); });
    req.on('error', (e) => resolve({ status: 0, json: null, text: String(e && e.message) }));
    if (data) req.write(data);
    req.end();
  });
}

async function ping() {
  const r = await rawRequest('/health', { timeout: 2000 });
  if (r.status === 200 && r.json && r.json.status === 'ok') return r.json;
  return null;
}

/* ---------- 生命周期 ---------- */
async function start() {
  if (state.starting) return state.starting;
  state.starting = (async () => {
    // 1) 已经有 helper 在跑（可能是原版程序拉起来的）→ 直接接管
    const alive = await ping();
    if (alive) {
      state.running = true;
      state.owned = false;
      state.pid = alive.pid || null;
      state.chrome = alive.chrome || null;
      state.db = alive.db || null;
      state.lastError = '';
      log('复用已在运行的 helper pid=', state.pid);
      emit();
      return status();
    }

    // 2) 端口被占但不是我们能认的 helper
    const busy = await portInUse(PORT);
    if (busy) {
      state.running = false;
      state.lastError = `端口 ${PORT} 被其他程序占用（不是本程序的豆包助手）`;
      log(state.lastError);
      emit();
      return status();
    }

    // 3) 自己拉起来
    const bin = process.env.MJ_DOUBAO_BIN || firstExisting(HELPER_BIN_CANDS);
    if (!bin) {
      state.lastError = '未找到豆包助手二进制（tools/doubao-helper/win-x64/server-win-x64.exe）';
      log(state.lastError);
      emit();
      return status();
    }
    const helperRoot = firstExisting(HELPER_ROOT_CANDS) || path.dirname(bin);
    fs.mkdirSync(path.join(DATA_DIR), { recursive: true });
    const helperLog = path.join(LOG_DIR, 'doubao-helper.log');

    const env = {
      ...process.env,
      DOUBAO_AUTH_TOKEN: TOKEN,
      DOUBAO_LICENSE_SALT: SALT,
      DOUBAO_LICENSE_FINGERPRINT: crypto.createHash('sha256').update(TOKEN + SALT).digest('hex'),
      DOUBAO_HELPER_ROOT: helperRoot,
      DOUBAO_HOST: HOST,
      DOUBAO_PORT: String(PORT),
      DOUBAO_DATA_DIR: DATA_DIR,
      DOUBAO_HELPER_LOG_PATH: helperLog,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    let out;
    try {
      out = fs.openSync(helperLog, 'a');
      fs.appendFileSync(helperLog, `\n===== shell spawn ${new Date().toISOString()} =====\n`);
    } catch { out = 'ignore'; }

    log('spawn helper', bin, 'dataDir=', DATA_DIR);
    const proc = spawn(bin, [], { env, stdio: ['ignore', out, out], windowsHide: true });
    state.proc = proc;
    state.owned = true;
    state.lastStartedAt = Date.now();

    proc.on('exit', (code, signal) => {
      const wasRunning = state.running;
      log('helper 退出 code=', code, 'signal=', signal);
      state.running = false;
      state.proc = null;
      state.pid = null;
      state.lastStoppedAt = Date.now();
      if (code !== 0 && code !== null) state.lastError = `helper 退出码 ${code}`;
      emit();
      if (wasRunning && state.enabled && state.restartCount < MAX_AUTO_RESTART) {
        state.restartCount += 1;
        setTimeout(() => { start().catch(() => { /* ignore */ }); }, 2000);
      }
    });

    // 等就绪
    const t0 = Date.now();
    while (Date.now() - t0 < START_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 700));
      const h = await ping();
      if (h) {
        state.running = true;
        state.pid = h.pid || proc.pid;
        state.chrome = h.chrome || null;
        state.db = h.db || null;
        state.lastError = '';
        state.restartCount = 0;
        log('helper 就绪 pid=', state.pid, `${Date.now() - t0}ms`);
        emit();
        return status();
      }
      if (proc.exitCode !== null) break;
    }
    state.lastError = state.lastError || '豆包助手启动超时（60s 内未响应 /health）';
    log(state.lastError);
    emit();
    return status();
  })();
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

async function stop() {
  state.enabled = false;
  if (!state.owned) { state.running = false; emit(); return; }
  try { await rawRequest('/internal/shutdown', { method: 'POST', body: {}, timeout: 3000 }); } catch { /* ignore */ }
  const proc = state.proc;
  if (proc) {
    await new Promise((r) => setTimeout(r, 400));
    try { if (proc.exitCode === null) proc.kill(); } catch { /* ignore */ }
  }
  state.proc = null;
  state.running = false;
  state.pid = null;
  state.lastStoppedAt = Date.now();
  emit();
}

async function restart() {
  if (state.owned) await stop();
  state.enabled = true;
  state.restartCount = 0;
  return start();
}

async function setEnabled(on) {
  if (on) return restart();
  await stop();
  return status();
}

function status() {
  return {
    enabled: state.enabled,
    running: state.running,
    pid: state.pid,
    port: PORT,
    host: HOST,
    token: TOKEN ? TOKEN.slice(0, 3) + '***' + TOKEN.slice(-3) : '',
    tokenFile: path.join(DATA_DIR, 'token'),
    dataDir: DATA_DIR,
    helperEntry: process.env.MJ_DOUBAO_BIN || firstExisting(HELPER_BIN_CANDS) || '',
    lastError: state.lastError,
    lastStartedAt: state.lastStartedAt,
    lastStoppedAt: state.lastStoppedAt,
    chrome: state.chrome,
    db: state.db,
    owned: state.owned,
  };
}

/* 渲染层接口放行策略
 * 原版 manager 完全不做限制（整条 axios 直通），我先前按「已知接口」做了白名单，
 * 结果 UI 上还有没枚举到的路径（/internal/open-profile、/accounts/:id/reset、
 * /clear-usage、/tasks/:id/refetch-video）一按就弹「路径不在白名单」。
 * 现在改成「只挡会让助手自杀的两个内部接口，其余全放行」——功能和原版一致，
 * 又不会因为漏枚举再冒同样的错。
 */
const DENY = [
  /^\/internal\/shutdown$/i,
  /^\/internal\/token-reload$/i,
];

function allowed(p) {
  return !DENY.some((re) => re.test(p));
}

async function request(pathname, method = 'GET', body) {
  const p = String(pathname || '');
  if (!p.startsWith('/')) return { success: false, message: '非法路径：' + p };
  if (!allowed(p)) {
    log('拦截内部路径', p);
    return { success: false, message: '该接口会让豆包助手退出，已拦截：' + p };
  }
  if (!state.running) {
    await start();
    if (!state.running) return { success: false, message: state.lastError || '豆包助手未运行' };
  }
  const r = await rawRequest(p, { method: String(method || 'GET').toUpperCase(), body });
  if (r.status === 0) return { success: false, message: r.text || '请求失败' };
  if (r.status >= 400) {
    const msg = (r.json && (r.json.message || r.json.error)) || r.text.slice(0, 200) || `HTTP ${r.status}`;
    return { success: false, message: msg, status: r.status };
  }
  return { success: true, data: r.json };
}

function onStatus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

module.exports = {
  start,
  stop,
  restart,
  setEnabled,
  status,
  request,
  onStatus,
  ping,
  getConfig: () => ({ dataDir: DATA_DIR, port: PORT, token: TOKEN, bin: firstExisting(HELPER_BIN_CANDS) }),
  regenerateToken: async () => {
    const next = 'LOCAL-' + crypto.randomBytes(20).toString('hex');
    writeJson(CONFIG_FILE, { dataDir: DATA_DIR, token: next, salt: SALT, port: PORT });
    log('token 已重置，需重启壳层生效');
    return next;
  },
};
