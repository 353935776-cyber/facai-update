'use strict';
/**
 * 出图接口旁路记录 + 兜底落盘（2026-11-13 晚）
 *
 * 前端走的是本地反向代理（127.0.0.1:17901/px/...），所以图片接口的响应
 * 一定经过主进程。这里做两件事：
 *   1) 把状态码 / content-type / 响应体（截断）写进 logs/shell.log —— 再出问题时
 *      不用猜，直接能看到上游到底回了什么；
 *   2) 只要响应里能认出图片（url 或 b64_json），立刻下载/解码存到
 *      assets/_rescue/ 下 —— 前端解析失败、页面被刷新、并发覆盖都不影响，
 *      钱已经花掉的图至少还在磁盘上，可以再挂回资产表。
 *
 * 只对 /images/(generations|edits|variations) 生效，文本/视频不碰。
 */

const fs = require('fs');
const path = require('path');

const MAX_CAPTURE = 8 * 1024 * 1024; /* 最多留 8MB 响应体做分析 */

function isImageEndpoint(rest) {
  return /\/images?\/(generations|edits|variations)/i.test(String(rest || ''));
}

/**
 * 从响应文本里找出所有图片引用（http(s) 链接 / data: base64）
 *
 * 同时收集「同一张图的两种形态」：这家中转（aicost / gpt-image-2）会在同一个
 * data[i] 里既给 url 又给 b64_json —— 图其实已经随响应到了内存，前端却还要去
 * www.aicost.me 把同一张图再下载一遍（实测 13KB/s，2.5MB 要 150~180 秒）。
 * 记住这层对应关系，可以让下载直接命中内存。
 */
function collectImages(text) {
  const out = [];
  const pairs = []; /* { url, dataUrl } 同一个对象里 url 与 base64 指向同一张图 */
  const push = (s) => {
    const v = String(s || '').trim();
    if (!v || out.includes(v)) return;
    if (!/^(https?:\/\/|data:image\/)/i.test(v)) return;
    out.push(v);
  };
  let j = null;
  try { j = JSON.parse(text); } catch { j = null; }
  const walk = (v, depth) => {
    if (v == null || depth > 8) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) push(v);
      else {
        const md = /!\[[^\]]*\]\((https?:[^)\s]+)\)/.exec(v);
        if (md) push(md[1]);
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      const b64 = (typeof v.b64_json === 'string' && v.b64_json.length > 256)
        ? v.b64_json
        : (typeof v.base64 === 'string' && v.base64.length > 256 && !v.url && !v.image_url ? v.base64 : '');
      if (b64) {
        const dataUrl = `data:image/png;base64,${b64}`;
        push(dataUrl);
        const href = typeof v.url === 'string' ? v.url : (typeof v.image_url === 'string' ? v.image_url : '');
        if (/^https?:\/\//i.test(href)) pairs.push({ url: href, dataUrl });
      }
      Object.keys(v).forEach((k) => walk(v[k], depth + 1));
    }
  };
  if (j) walk(j, 0);
  if (!out.length) {
    const re = /https?:\/\/[^\s"'<>)\]]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)\]]*)?/ig;
    let m;
    while ((m = re.exec(text)) !== null) push(m[0]);
  }
  return { images: out, pairs };
}

function extractImages(text) {
  return collectImages(text).images;
}

/* ── 内存图缓存：外链 URL → 已经随响应收到的字节 ─────────────────────────
 * 目的：前端调 asset:download 时不必再从境外图床拉一遍。
 * 只留最近 20 张、20 分钟内有效，避免长期占内存。 */
const CACHE_TTL_MS = 20 * 60 * 1000;
const CACHE_MAX = 20;
const byteCache = new Map(); /* url → { buf, ct, at } */

function rememberBytes(url, buf, ct) {
  const u = String(url || '');
  if (!u || !buf || !buf.length) return;
  const now = Date.now();
  for (const [k, v] of byteCache) if (now - v.at > CACHE_TTL_MS) byteCache.delete(k);
  byteCache.set(u, { buf, ct: String(ct || 'image/png'), at: now });
  while (byteCache.size > CACHE_MAX) {
    const oldest = byteCache.keys().next().value;
    byteCache.delete(oldest);
  }
}

function getCachedBytes(url) {
  const hit = byteCache.get(String(url || ''));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { byteCache.delete(String(url || '')); return null; }
  return { buf: hit.buf, ct: hit.ct };
}

/** 从请求体里抠出 prompt，方便把图和「哪个场景/角色」对上 */
function pickPrompt(requestBody) {
  const s = String(requestBody || '');
  try {
    const j = JSON.parse(s);
    const hit = [];
    const walk = (v, depth) => {
      if (v == null || depth > 6 || hit.length) return;
      if (typeof v === 'string') {
        if (v.length > 20) hit.push(v);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof v === 'object') {
        if (typeof v.prompt === 'string' && v.prompt.trim()) { hit.push(v.prompt); return; }
        Object.keys(v).forEach((k) => walk(v[k], depth + 1));
      }
    };
    walk(j, 0);
    if (hit.length) return hit[0].replace(/\s+/g, ' ').slice(0, 300);
  } catch { /* 不是 JSON 就退回正则 */ }
  const m = /"prompt"\s*:\s*"([\s\S]{20,600}?)"/.exec(s);
  return m ? m[1].replace(/\\n/g, ' ').replace(/\s+/g, ' ').slice(0, 300) : '';
}

const extOf = (ct) => (/png/i.test(ct) ? '.png' : /jpe?g/i.test(ct) ? '.jpg' : /webp/i.test(ct) ? '.webp' : /gif/i.test(ct) ? '.gif' : '.png');

async function saveOne(ref, dir, tag, idx, log) {
  const stamp = `${Date.now().toString(36)}-${idx}`;
  try {
    if (/^data:image\//i.test(ref)) {
      const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(ref);
      if (!m) return '';
      const file = path.join(dir, `${tag}-${stamp}${extOf(m[1])}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return file;
    }
    for (let i = 0; i < 3; i += 1) {
      try {
        const t0 = Date.now();
        let refHost = '';
        try { refHost = new URL(ref).host; } catch { refHost = '?'; }
        const res = await fetch(ref);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('空响应');
        const ct = String(res.headers.get('content-type') || '');
        const file = path.join(dir, `${tag}-${stamp}${extOf(ct)}`);
        fs.writeFileSync(file, buf);
        const sec = Math.max(0.001, (Date.now() - t0) / 1000);
        if (log) {
          log('[rescue] 下载', refHost, `${(buf.length / 1048576).toFixed(2)}MB`,
            `${sec.toFixed(1)}s`, `${Math.round(buf.length / 1024 / sec)}KB/s`);
        }
        return file;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  } catch (e) {
    if (log) log('[rescue] 落盘失败', String((e && e.message) || e), String(ref).slice(0, 80));
  }
  return '';
}

/**
 * @param {object} o {status, contentType, body, requestBody, assetsRoot, log}
 * @returns {Promise<{images:string[], saved:string[], prompt:string}>}
 */
async function onPaidResponse(o) {
  const opts = o || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const body = String(opts.body || '');
  const prompt = pickPrompt(opts.requestBody);
  const { images, pairs } = collectImages(body);
  const out = { images, saved: [], prompt };

  /* 把「同一个对象里 url + b64」的图按 url 记进内存：前端下载时可以直接命中 */
  const twinUrl = new Map(); /* url → dataUrl */
  for (const p of pairs) {
    twinUrl.set(p.url, p.dataUrl);
    try {
      const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(p.dataUrl);
      if (m) rememberBytes(p.url, Buffer.from(m[2], 'base64'), m[1]);
    } catch { /* 单个图解码失败不影响其它 */ }
  }
  if (twinUrl.size) {
    log('[rescue] 响应自带内联图', `${twinUrl.size} 张`, '→ 下载会直接命中内存，不再走外网');
  }

  /* 关键归因信息：上游占了多少秒、图是内联 base64 还是外链 */
  const cost = opts.startedAt ? `${((Date.now() - opts.startedAt) / 1000).toFixed(1)}s` : '?';
  const shapes = images.map((u) => {
    if (/^data:/i.test(u)) return 'b64';
    try { return new URL(u).host; } catch { return '?'; }
  }).join(',');

  /* 首字节把它切成两段：前面是生成，后面是纯传输。
   * 只报总时长永远分不清该换模型还是该换中转，所以这段必须有。 */
  let timing = '';
  if (opts.startedAt && opts.firstByteAt) {
    const gen = Math.max(0, opts.firstByteAt - opts.startedAt) / 1000;
    const end = opts.endedAt || Date.now();
    const xfer = Math.max(0, end - opts.firstByteAt) / 1000;
    const kb = (Number(opts.recvBytes) || 0) / 1024;
    const rate = xfer > 0.05 ? Math.round(kb / xfer) : 0;
    timing = `生成=${gen.toFixed(1)}s 传输=${xfer.toFixed(1)}s 收到=${Math.round(kb)}KB ${rate}KB/s`;
  }

  const parts = ['[paid]', String(opts.status), String(opts.contentType || '').slice(0, 40), `${body.length}B`,
    `images=${images.length}`, `上游耗时=${cost}`];
  if (timing) parts.push(timing);
  if (shapes) parts.push(`形态=${shapes}`);
  parts.push(prompt ? `prompt=${prompt.slice(0, 60)}` : 'prompt=?');
  log(...parts);
  if (images.length) {
    log('[paid] 图片地址', images.slice(0, 3).map((u) => String(u).slice(0, 110)).join(' | '));
  }
  if (!images.length) {
    log('[paid] 响应体样本', body.slice(0, 400).replace(/\s+/g, ' '));
    return out;
  }

  const root = String(opts.assetsRoot || '');
  if (!root) return out;
  const dir = path.join(root, '_rescue');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  for (let i = 0; i < images.length; i += 1) {
    /* 同一张图既有外链又有内联 base64 时，只存内联那份：外链再下一遍纯属浪费带宽 */
    if (twinUrl.has(images[i])) continue;
    const file = await saveOne(images[i], dir, 'rescue', i, log);
    if (file) out.saved.push(file);
  }
  if (out.saved.length) {
    const spent = opts.startedAt ? `${((Date.now() - opts.startedAt) / 1000).toFixed(1)}s` : '?';
    log('[rescue] 已兜底保存', out.saved.map((p) => path.basename(p)).join(','),
      `总耗时=${spent}`, prompt ? `| ${prompt.slice(0, 40)}` : '');
  }
  /* 交给调用方挂回资产表：前端保存失败时这一刀能救回来 */
  if (out.saved.length && typeof opts.onSaved === 'function') {
    try { await opts.onSaved(out.saved, prompt); } catch (e) { log('[rescue] 挂回资产失败', (e && e.message) || e); }
  }
  return out;
}

module.exports = {
  isImageEndpoint, extractImages, collectImages, pickPrompt, onPaidResponse, MAX_CAPTURE,
  getCachedBytes, rememberBytes,
};
