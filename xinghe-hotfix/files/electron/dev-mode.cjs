'use strict';
/**
 * 渠道开关：同一套程序，作者本机是「开发者版」，客户机永远是「正式版」。
 *
 * 为什么不在 app 目录里放开关文件：
 *   - 安装包 / 热更包会原样带上 app/ 下的东西，一不小心就把开发者版发给客户了；
 *   - 热更还会用清单里的文件覆盖安装目录，标记容易被冲掉。
 * 所以标记只放数据目录（%APPDATA%\MJStudio\dev.json），它不在任何包里。
 *
 * 标记带 HMAC 签名，且绑定「本机机器码 + 程序安装路径」：
 *   - 拷到别的电脑 → 机器码不符，不启用；
 *   - 同一台电脑上另装一份客户版 → 程序路径不符，仍是正式版（方便作者本机验客户版）；
 *   - 客户自己造不出签名（密钥在 license.cjs，未随公开仓库分发）。
 *
 * 环境变量 XH_DEV=1 只用于临时调试，不写盘、不随包分发。
 * 缺 license.cjs / 标记损坏 / 签名不对，一律安全退化为正式版，绝不拖垮启动。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHANNEL_DEV = 'dev';
const CHANNEL_RELEASE = 'release';
const SIG_TEXT = 'xinghe-aigc|dev-channel|v1';

let lic = null;
try { lic = require('./license.cjs'); } catch { /* 缺授权模块就一律正式版 */ }

let dir = '';
let appRoot = '';
let cache = null;

function normRoot(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function init(dataDir, root) {
  dir = String(dataDir || '');
  appRoot = normRoot(root || path.resolve(__dirname, '..'));
  cache = null;
  return module.exports;
}

function cfgFile() { return dir ? path.join(dir, 'dev.json') : ''; }

function mid() {
  try { return String((lic && lic.machineId && lic.machineId()) || '').toUpperCase(); }
  catch { return ''; }
}

function payload(machine, root) {
  return `${SIG_TEXT}|${String(machine || '').toUpperCase()}|${normRoot(root || appRoot)}`;
}

function signFor(machine, root) {
  const s = lic && lic.secret && lic.secret();
  if (!s) throw new Error('授权模块不可用，无法生成开发者标记');
  return crypto.createHmac('sha256', String(s)).update(payload(machine, root)).digest('hex');
}

function safeEq(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function state() {
  if (cache) return cache;
  const base = {
    enabled: false, channel: CHANNEL_RELEASE, label: '正式版',
    source: 'default', versionSuffix: '',
  };
  if (process.env.XH_DEV === '1') {
    return (cache = {
      ...base, enabled: true, channel: CHANNEL_DEV,
      label: '开发者版', source: 'env', versionSuffix: '-dev',
    });
  }
  try {
    const f = cfgFile();
    if (!f || !fs.existsSync(f)) return (cache = base);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || j.enabled !== true) return (cache = base);
    const m = mid();
    /* 两道都要过：签名本身有效，且标记绑定的路径必须就是「当前正在跑的这份程序」。
     * 少后者的话，作者在本机另装一份客户版，会读到同一个 dev.json 而误变开发者版。 */
    if (!m || normRoot(j.app) !== appRoot || !safeEq(signFor(m, j.app), j.sig || '')) {
      /* 机器码或安装路径对不上：说明这个文件是从别的电脑/别的安装目录拷来的 */
      return (cache = { ...base, source: 'bad-signature' });
    }
    return (cache = {
      enabled: true,
      channel: CHANNEL_DEV,
      label: String(j.label || '开发者版').slice(0, 24),
      source: 'userData',
      versionSuffix: '-dev',
      note: String(j.note || '').slice(0, 120),
    });
  } catch { return (cache = base); }
}

function enabled() { return state().enabled; }
function channel() { return state().channel; }
function label() { return state().label; }
function title(appName) { return enabled() ? `${appName} · 开发者版 [DEV]` : appName; }

/** 生成一份可写到数据目录的开发者标记（tools/gen-dev-token.cjs 用） */
function makeToken(root, labelText, noteText) {
  const m = mid();
  if (!m) throw new Error('取不到本机机器码');
  const r = String(root || appRoot || path.resolve(__dirname, '..'));
  return {
    enabled: true,
    channel: CHANNEL_DEV,
    label: String(labelText || '开发者版'),
    note: String(noteText || '作者自用 · 请勿外发'),
    app: r,
    mid: m.slice(0, 4) + '****',   /* 只留前缀便于核对，不公开完整机器码 */
    sig: signFor(m, r),
  };
}

module.exports = {
  init, enabled, channel, label, title, state, cfgFile,
  makeToken, signFor, mid, normRoot,
  CHANNEL_DEV, CHANNEL_RELEASE,
};
