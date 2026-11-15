'use strict';
/**
 * 星核AIGC —— 本地视频网关（127.0.0.1:8787）
 *
 * 为什么需要它：
 *   软件里所有"豆包系"视频档案（doubao-mini / doubao-fast / doubao-sd2.0-*）默认都指向
 *   http://127.0.0.1:8787，原本由浏览器插件/豆包扩展提供。没有插件时这条链路是断的。
 *
 * 它实现插件的那套契约：
 *   POST /generate             {prompt, aspect_ratio, duration, model, images} -> {task_id}
 *   POST /chat-generate-video  同上（sd2.0 系列档案用这个路径）
 *   GET  /tasks/{task_id}      -> {id, status, progress, video_url, error}
 *   GET  /files/{name}         分发 mp4（支持 Range）
 *   GET  /health               自检
 *
 * 三种后端（环境变量 VG_MODE 或 %APPDATA%/MJStudio/video-gateway.json 的 mode）：
 *   auto （默认）豆包助手在线且账号有额度 → 走 helper 出真视频；助手不在 → mock 占位，链路不中断。
 *   mock        用本机 ffmpeg 把参考图做成缓推镜头的占位视频，用于验证
 *               "前端 → 网关 → 任务轮询 → 下载落库 → 导出剪映" 整条链路。
 *   proxy       把请求转给真实视频 API（VG_UPSTREAM / VG_KEY / VG_MODEL），
 *                网关只做协议转译，出的是真 AI 视频。
 *   helper      转发给本机豆包助手（127.0.0.1:8787，账号池 Seedance），
 *                需要助手在跑且账号已登录豆包网页。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const CONFIG_FILE = path.join(process.env.APPDATA || os.homedir(), 'MJStudio', 'video-gateway.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
}
const CFG = readConfig();
const PORT = Number(process.env.VG_PORT || CFG.port || 8788);
const MODE = String(process.env.VG_MODE || CFG.mode || 'auto').toLowerCase();
const OUT_DIR = process.env.VG_OUT || path.join(process.env.APPDATA || os.homedir(), 'MJStudio', 'video-gateway');
const UPSTREAM = String(process.env.VG_UPSTREAM || '').replace(/\/+$/, '');
const UP_KEY = String(process.env.VG_KEY || '');
const UP_MODEL = String(process.env.VG_MODEL || 'minimax_h3');

/* ---------- 豆包助手（helper 模式）---------- */
const HELPER_PORT = Number(process.env.VG_HELPER_PORT || 8787);

function helperToken() {
  if (process.env.VG_HELPER_TOKEN) return process.env.VG_HELPER_TOKEN;
  const cfgFile = path.join(process.env.APPDATA || os.homedir(), 'MJStudio', 'doubao-config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg.token) return cfg.token;
    if (cfg.dataDir) {
      const seed = String(path.dirname(cfg.dataDir)) + '::mengyuan-doubao-local-token-v1';
      return 'LOCAL-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
    }
  } catch { /* ignore */ }
  return '';
}

function helperCall(pathname, method = 'GET', body, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const token = helperToken();
    if (!token) return reject(new Error('未找到豆包助手 token（先在「豆包插件」页打开一次）'));
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Authorization: `Bearer ${token}`, 'x-helper-secret': token, Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = http.request({ host: '127.0.0.1', port: HELPER_PORT, path: pathname, method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        if ((res.statusCode || 0) >= 400) return reject(new Error(`助手返回 ${res.statusCode}：${(json && (json.message || json.error)) || text.slice(0, 160)}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('助手请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* auto 模式：豆包助手在线 + 还有账号没跑满 → 真视频；否则退回占位片 */
let effCache = { at: 0, mode: '' };
async function effectiveMode() {
  if (MODE !== 'auto') return MODE;
  if (Date.now() - effCache.at < 10000 && effCache.mode) return effCache.mode;
  let mode = 'mock';
  try {
    const h = await helperCall('/health', 'GET', undefined, 2500);
    if (h && h.status === 'ok') {
      /* 助手在线就走真链路。以前这里还会看「账号额度是否用完」，用完就退回 mock 出占位片，
       * 结果是用户以为生成了、导出的却是假视频。现在次数用完由 reserveAccount 直接报错。 */
      mode = 'helper';
      try {
        const acc = await helperCall('/accounts', 'GET', undefined, 3500);
        const list = (acc && acc.accounts) || [];
        if (!list.length) log('auto: 豆包助手在线，但还没有添加账号');
        else if (!list.some((a) => accountUsable(a))) log('auto: 豆包助手在线，但账号次数都用完了（点生成会直接提示）');
      } catch { /* ignore */ }
    }
  } catch (e) {
    log('auto: 豆包助手不可用 → 占位片（' + String(e.message || e).slice(0, 60) + '）');
  }
  effCache = { at: Date.now(), mode };
  return mode;
}

/* 按「当日用得最少」排序的候选账号；某个账号正忙时换下一个再试 */
async function helperCandidates() {
  const j = await helperCall('/accounts');
  const list = (j && (j.accounts || j.data)) || [];
  const now = Date.now();
  const usable = list.filter((a) => {
    const st = String(a.status || '').toLowerCase();
    if (st && st !== 'active') return false;
    if (Number(a.cooldownUntil ?? a.cooldown_until ?? 0) > now) return false;
    const used = Number(a.dailyUsed ?? a.daily_used ?? a.usedCount ?? a.used_count ?? 0);
    const limit = Number(a.dailyLimit ?? a.daily_limit ?? a.totalLimit ?? a.total_limit ?? 5);
    return !(limit > 0 && used >= limit);
  });
  if (!usable.length) throw new Error('没有可用豆包账号（额度用尽或全部冷却中）');
  usable.sort((a, b) => Number(a.dailyUsed ?? a.daily_used ?? 0) - Number(b.dailyUsed ?? b.daily_used ?? 0));
  return usable.map((a) => String(a.id || '')).filter(Boolean);
}

async function helperPickAccount() {
  const ids = await helperCandidates();
  return ids[0];
}

function toDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

/* 豆包助手是 JSON 传图，太大容易卡在 body 上；超过 700KB 先压成 720p JPEG */
function shrinkForHelper(p, maxBytes = 700 * 1024) {
  try {
    const st = fs.statSync(p);
    if (st.size <= maxBytes) return p;
    if (!FFMPEG) return p;
    const out = path.join(OUT_DIR, `small_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`);
    spawnSync(FFMPEG, ['-hide_banner', '-y', '-i', p, '-vf', 'scale=720:-2', '-q:v', '5', out], { windowsHide: true, stdio: 'ignore' });
    if (fs.existsSync(out) && fs.statSync(out).size > 0 && fs.statSync(out).size < st.size) {
      log(`参考图压缩 ${(st.size / 1024).toFixed(0)}KB → ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
      return out;
    }
  } catch (e) {
    log('参考图压缩失败', e.message);
  }
  return p;
}

async function createViaHelper({ prompt, ratio, duration, images, model, videoResultTimeoutMs }, optAccountId) {
  const dur = Math.max(1, Math.min(30, Math.floor(Number(duration) || 6)));
  const rat = String(ratio || '16:9');
  // 前端档案里的 model 本来就是助手认识的模型 id（doubao-seedance-2-0-fast / -mini / -2-0），
  // 原样传过去，助手会在创作面板里映射成「Seedance 2.0 Fast」并自动点选，不要改成自然语言。
  const modelId = String(model || 'doubao-seedance-2-0-fast');
  const imgs = [];
  let list = images;
  if (typeof list === 'string') {
    // 前端模板会把 {{imagePaths}} 原样塞进来，可能是 JSON 数组字符串
    try { const j = JSON.parse(list); list = Array.isArray(j) ? j : [list]; } catch { list = list ? [list] : []; }
  }
  if (!Array.isArray(list)) list = list ? [list] : [];
  // 工作台的提示词常引用「图1…图5」（图5 多半是站位/分镜母版），早期这里只取前 3 张，
  // 后两张根本没上传到豆包，模型只能靠文字猜画面。助手本身没有张数上限，这里放宽到 6 张。
  for (const it of list.slice(0, 6)) {
    const p = await materializeImage(it, imgs.length);
    const d = p ? toDataUrl(shrinkForHelper(p)) : '';
    if (d) imgs.push(d);
  }
  log(`助手参考图 ${imgs.length} 张 / 传入 ${Array.isArray(list) ? list.length : 1} 张`);

  /* 走助手的 /generate（runCdpTask）而不是 /chat-generate-video（chat 入口）：
   *   /generate            → 打开 /chat/create-image（AI 创作）→ 点「视频」tab → 选模型/画幅/时长
   *                          → 上传参考图 → 填提示词 → 点生成 → 等视频 URL
   *   /chat-generate-video → 强制跳回普通 /chat 对话框，只把文字发给豆包。
   * 豆包 2026-11 已明确回复「当前对话窗口不能直接触发 Seedance 视频生成任务，需前往视频生成创作面板」，
   * 所以 chat 入口必然只回一段文字，出不了片。面板模式下比例/时长/模型走独立字段，
   * 提示词保持工作台原文，不要再塞「请生成视频」这类口语指令（会混进画面描述）。 */
  /* 账号由调用方（reserveAccount）先占好再传进来：一个分镜只交给一个账号，
   * 这样每个分镜各自开自己的豆包窗口并行跑，不会两个分镜挤同一个账号排队。 */
  let accountId = String(optAccountId || '');
  if (!accountId) {
    const candidates = await helperCandidates();
    accountId = candidates[0];
  }
  const j = await helperCall('/generate', 'POST', {
    prompt,
    images: imgs,
    aspect_ratio: rat,
    duration: String(dur),
    model: modelId,
    accountId,
    profileAccountId: accountId,
    /* 助手按这个值决定等视频结果等多久（内部夹在 1~60 分钟，缺省 10 分钟）。
     * 四种写法都给：助手 HTTP 层只认 sec 那两个字段（ms 会被结构体丢掉），
     * 注入脚本那边 ms/sec 都认。不传 = 设置里的分钟数形同虚设。 */
    videoResultTimeoutMs,
    video_result_timeout_ms: videoResultTimeoutMs,
    videoResultTimeoutSec: Math.round(Number(videoResultTimeoutMs) / 1000),
    video_result_timeout_sec: Math.round(Number(videoResultTimeoutMs) / 1000),
  }, 180000);
  const id = j && (j.task_id || j.id || (j.data && (j.data.task_id || j.data.id)));
  if (id) return String(id);
  throw new Error(String((j && (j.error || j.message)) || '豆包未返回任务 id：' + JSON.stringify(j).slice(0, 160)));
}

/* 助手错误里带整段堆栈（doubao://doubao-cdp-driver.js:4085 之类），先剥掉堆栈行和
 * doubao:// 引用，只留「人话」那一段，否则 /CDP/i 会把额度、登录这类业务错误全误判成窗口中断。 */
function errorLine(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*at\s/.test(l))
    .join(' ')
    .replace(/doubao:\/\/\S+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function friendlyError(raw) {
  const s = errorLine(raw) || '豆包任务失败';
  if (/quota|额度|免费次数|次数用完|次数已用完/i.test(s)) return '豆包账号今日免费次数已用完，请换一个账号或明天再试。';
  if (/未登录|login|登录态/i.test(s)) return '豆包账号未登录：请在「豆包插件」页点「打开豆包」登录后重试。';
  if (/正在执行其他任务|busy|locked/i.test(s)) return '该豆包账号正在跑别的任务，请稍后再试。';
  if (/视频 tab 未就绪|找不到视频|未找到视频|video tab/i.test(s)) {
    return '豆包创作面板里没找到「视频」入口（页面可能改版了）。请看一下自动弹出的豆包页面是否还有「视频生成」，'
      + '并把这段报错发我，我按新界面适配选择器。';
  }
  if (/当前不在 \/chat\/create-image|create-image 页面/i.test(s)) {
    return '豆包创作面板没打开成功（页面被导航走了）。请保持自动弹出的窗口不被关闭、不刷新，然后重试。';
  }
  if (/页面跳转打断|未解析到豆包对话|CDP\s*(WebSocket|连接|已关闭|断开)|WebSocket\s*已关闭|chrome exit|被导航打断/i.test(s)) {
    return '生成被中断：上传参考图后豆包页面发生了跳转/重载，或自动弹出的窗口被关闭，提示词没能发送完成。'
      + '请在出片全程保持那个豆包窗口打开（不要关、不要刷新），然后重新点「生成视频」。';
  }
  return s;
}

/* 只有「窗口/连接被打断」这类偶发故障才自动重试一次；额度、登录、内容审核等失败不重试。
 *
 * 注意：助手失败时 rawError 里带整段堆栈（doubao://doubao-cdp-driver.js:4085 之类），
 * 早先直接 /CDP/i 匹配会把「免费额度已用完」「未登录」这些业务错误也当成窗口中断，
 * 于是自动重试 → 豆包窗口被重新打开、同一个分镜又生成一遍（用户看到的「取消了还在生成」）。
 * 所以先剥掉堆栈行、去掉 doubao:// 引用，再排除业务类错误，最后才认真正的导航中断。 */
function isInterrupted(task) {
  const line = errorLine(task.rawError);
  const msg = String(task.error || '');
  if (/quota|额度|次数|未登录|login|审核|风控|敏感|busy|locked|正在执行|任务不存在|not_found/i.test(line)) return false;
  return /页面跳转打断|未解析到豆包对话|CDP\s*(WebSocket|连接|已关闭|断开)|WebSocket\s*已关闭|chrome exit/i.test(line)
    || /^生成被中断/.test(msg);
}

/* 取消一个还没跑完的任务：标记状态 + 真去通知助手把那条 CDP 任务停掉。
 * 前端「取消生成」只 abort 自己这边的 fetch，网关不同步掐掉的话，
 * 助手会继续占着豆包页面把这一单跑完（甚至继续生成同一个分镜）。 */
function cancelTask(task, reason) {
  if (!task) return false;
  if (task.cancelRequested) return false;
  if (task.status === 'success' || task.status === 'failed') return false;
  task.cancelRequested = true;
  task.status = 'failed';
  task.error = '已取消生成';
  log('取消任务', task.id, reason || '', task.helperId || '(尚未提交到助手)');
  if (task.helperId) {
    helperCall(`/tasks/${encodeURIComponent(task.helperId)}/cancel`, 'POST', {}, 8000)
      .then((j) => log('助手已取消', task.helperId, JSON.stringify(j || {}).slice(0, 120)))
      .catch((e) => log('助手取消失败', task.helperId, String((e && e.message) || e)));
  }
  return true;
}

/* ⚠ 这里原来是「15 秒没人来问就把助手任务掐掉」。2026-11-13 23:19 就是这么把一条
 * 已经提交成功、豆包正在生成的视频误杀的：前端 10 秒一轮询，只要渲染进程被节流或卡住
 * 十几秒（实测那次卡了 52 秒），看门狗就判「用户不要了」→ 调助手 /tasks/{id}/cancel →
 * 豆包页面真的取消，视频作废、次数照扣，日志还写着「前端已停止轮询」。
 *
 * 现在改成「脱管」：只标记前端不在了，助手任务继续跑，pollHelper 继续轮询到出片并落盘，
 * 前端回来 GET /tasks/{id} 照样能拿到结果。真取消只走显式 /cancel（壳层
 * jimeng.cancelVideo → 网关 /cancel），不再靠空闲猜。 */
const ORPHAN_IDLE_MS = Number(process.env.VG_ORPHAN_IDLE_MS || process.env.VG_CANCEL_IDLE_MS || 120000);
setInterval(() => {
  const now = Date.now();
  for (const t of tasks.values()) {
    if (t.status !== 'processing' || !t.polledOnce || t.cancelRequested || t.orphaned) continue;
    if (now - t.lastPollAt > ORPHAN_IDLE_MS) {
      t.orphaned = true;
      log('前端停止轮询，任务转入后台托管（不取消豆包任务）', t.id, t.helperId || '');
    }
  }
}, 3000).unref();


/* ---------------- 成片取回（豆包页面出片 → 软件真正收下） ----------------
 * 反复出现的现场是「豆包页面上视频已经能看了，软件进度还停在 87%」，最后视频没进软件。
 * 87% 只是网关心跳的估算值，背后有两段真实耗时：
 *   a) 助手的 CDP 脚本还在等「生成完成」信号，页面其实已经能预览成片；
 *   b) 助手给出 CDN 地址后，网关要把 8MB 左右的文件下载到本地，这期间进度完全不动。
 * 更糟的是日志里出现过「助手出片完成 0.0MB」：CDN 返回错误页/空响应，旧代码照样标
 * success，前端拿这个假文件去保存，于是「视频没进软件」。
 * 这里把三件事补齐：严格校验文件、失败自动补抓、超时主动去页面把成片取回来。 */
const MIN_VIDEO_BYTES = 100 * 1024;

function isRealVideo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_VIDEO_BYTES) return false;
  const head = buf.slice(0, 16).toString('latin1');
  // mp4/mov: ....ftyp / webm/mkv: 1A 45 DF A3
  return /ftyp/.test(head.slice(4, 8))
    || (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3);
}

async function downloadVideo(url, task) {
  let last = '';
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!isRealVideo(buf)) {
        throw new Error('不是有效视频（' + buf.length + 'B，头=' + JSON.stringify(buf.slice(0, 12).toString('latin1')) + '）');
      }
      return buf;
    } catch (e) {
      last = String((e && e.message) || e);
      log('取回成片失败', task.id, '第' + (i + 1) + '次', last.slice(0, 130));
      if (i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('下载豆包视频失败：' + last);
}

async function saveVideo(task, url, note) {
  if (task.status === 'success' && task.videoUrl) return;
  const buf = await downloadVideo(url, task);
  const out = path.join(OUT_DIR, task.id + '.mp4');
  fs.writeFileSync(out, buf);
  task.remoteVideoUrl = url;
  task.videoUrl = 'http://127.0.0.1:' + PORT + '/files/' + path.basename(out);
  task.status = 'success';
  task.progress = 100;
  task.stage = 'done';
  task.message = '成片已就绪';
  log('助手出片完成', task.id, (buf.length / 1048576).toFixed(1) + 'MB', note || '');
}

/* 补抓：让助手导航到那条豆包会话，把页面上已经出现的 <video> 抓回来。
 * 关键：助手任务 id 是 tsk_xxx，网关任务 id 是 vg_xxx，两者不是同一个东西。
 * 前端以前直接 POST 8787/tasks/{vg_xxx}/refetch-video → 必然 404，补抓从来没生效过。
 * 现在由网关用 task.helperId 转发，并起一个后台收割协程把结果翻回网关任务的 success。 */
const reaping = new Set();
function startReap(task, why) {
  if (!task || !task.helperId || reaping.has(task.id)) return false;
  reaping.add(task.id);
  task.stage = 'refetching';
  task.message = '豆包已出片，正在补抓到软件…';
  if (task.progress < 92) task.progress = 92;
  log('开始补抓成片', task.id, why, 'helper=' + task.helperId);
  helperCall('/tasks/' + encodeURIComponent(task.helperId) + '/refetch-video', 'POST', {
    videoResultTimeoutMs: Math.min(180000, Math.max(60000, Number(task.resultTimeoutMs) || 180000)),
    videoResultTimeoutSec: 120,
  }, 120000)
    .then((j) => log('补抓请求返回', task.id, JSON.stringify(j || {}).slice(0, 160)))
    .catch((e) => log('补抓请求异常', task.id, String((e && e.message) || e).slice(0, 120)));
  (async () => {
    const deadline = Date.now() + 8 * 60 * 1000;
    let reDup = 0;
    try {
      while (Date.now() < deadline && task.status !== 'success') {
        await new Promise((r) => setTimeout(r, 3000));
        let j;
        try { j = await helperCall('/tasks/' + encodeURIComponent(task.helperId), 'GET', undefined, 15000); }
        catch { continue; }
        const t = (j && (j.task || j.data)) || j || {};
        const url = String(t.video_url || t.videoUrl || t.url || '');
        if (!/^https?:\/\//i.test(url)) continue;
        /* 补抓是助手针对「本任务那条豆包会话」去取的，可信度比普通轮询高。
         * 先给 2 轮机会等页面换成新片；连续 3 轮还是同一地址就按本单收下。
         * 否则几个分镜并行补抓时会互相判成串台，谁都收不到、一直挂到超时。 */
        let dup = false;
        for (const o of tasks.values()) {
          if (o !== task && o.remoteVideoUrl && o.remoteVideoUrl === url) { dup = true; break; }
        }
        if (dup) {
          reDup += 1;
          if (reDup <= 2) { log('补抓拿到的是别单的成片，再等一轮', task.id, url.slice(0, 80)); continue; }
          log('补抓连续拿到同一地址，按本单成片收下', task.id, url.slice(0, 80));
        }
        try { await saveVideo(task, url, '(补抓)'); break; }
        catch (e) { log('补抓成片取回失败', task.id, String((e && e.message) || e).slice(0, 120)); }
      }
    } finally {
      reaping.delete(task.id);
      if (task.status !== 'success') log('补抓结束（未拿到成片）', task.id);
    }
  })();
  return true;
}

async function pollHelper(task) {
  const t0 = Date.now();
  const limit = Math.max(60 * 1000, Number(task.resultTimeoutMs) || DEFAULT_RESULT_TIMEOUT_MS);
  /* 串台保护：豆包每次生成都会给一条全新的 video_url。若本任务拿到的地址
   * 跟别的任务已经收过的一模一样，说明页面还残留着上一单的成片，先不收、继续等。 */
  let dupHits = 0;
  const dupLimit = 15; // 15 轮 × 4 秒 ≈ 1 分钟
  let saveFails = 0;
  while (Date.now() - t0 < limit) {
    if (task.cancelRequested) return;
    await new Promise((r) => setTimeout(r, 4000));
    if (task.cancelRequested) return;
    if (task.status === 'success') return; // 补抓协程已经先一步收下了
    let j;
    try { j = await helperCall('/tasks/' + encodeURIComponent(task.helperId)); } catch (e) { continue; }
    const t = (j && (j.task || j.data)) || j || {};
    const st = String(t.status || '').toLowerCase();
    const pct = Number(t.progress || 0);
    if (pct) task.progress = Math.min(95, Math.max(task.progress, pct));
    if (t.remote_task_id || t.remoteTaskId) task.remoteTaskId = String(t.remote_task_id || t.remoteTaskId);

    /* 豆包助手全程只报 status、不报进度，界面会像钉死在 12%。按预计时长做心跳，
     * 但上限压在 88：88~95 这一段留给「豆包已出片、正在取回」，不再让用户误以为
     * 87% 是「还差一点点就生成完」。 */
    const expected = Number(task.expectedMs) || 240000;
    const elapsed = Date.now() - t0;
    const beat = Math.round(12 + Math.min(0.96, elapsed / expected) * 78);
    if (beat > task.progress && task.progress < 88) task.progress = Math.min(88, beat);
    if (task.progress < 92) {
      task.stage = 'generating';
      task.message = elapsed > expected * 0.9 ? '豆包生成中，正在确认成片…' : '豆包正在生成视频…';
    }

    /* 已经超过预估出片时间还没结果：页面多半已经有片子，只是助手脚本没判定完成。
     * 主动让助手去那条会话把 <video> 抓回来，别让用户干等到 25 分钟超时。
     * startReap 自带去重，且只在超过预估时长后触发，不会打断正常生成。 */
    if (elapsed > expected + 30000 && task.progress < 92 && !reaping.has(task.id)) {
      startReap(task, '超过预估出片时间仍未回报');
    }

    if (st === 'failed' || st === 'error') {
      const raw = String(t.error || t.error_message || '豆包任务失败');
      /* 豆包页面常常已经出片、只是脚本判了失败。先补抓一次，真没片子再报错。 */
      if (!reaping.has(task.id) && (task.reapOnFailCount || 0) < 1) {
        task.reapOnFailCount = (task.reapOnFailCount || 0) + 1;
        startReap(task, '助手报失败但可能有成片');
        await new Promise((r) => setTimeout(r, 10000));
        if (task.status === 'success') return;
      }
      task.status = 'failed';
      task.rawError = raw;
      task.error = friendlyError(raw);
      log('助手任务失败', task.helperId, raw.slice(0, 180));
      return;
    }
    if (st === 'cancelled' || st === 'canceled') {
      if (!reaping.has(task.id) && !task.cancelRequested) {
        startReap(task, '助手任务被取消但可能有成片');
        await new Promise((r) => setTimeout(r, 10000));
        if (task.status === 'success') return;
      }
      task.status = 'failed';
      task.error = '任务被取消';
      return;
    }

    const url = String(t.video_url || t.videoUrl || t.url || '');
    /* 只要拿到成片地址就取回，不必再等助手把 status 翻成 success —— 这正是
     * 「豆包页面已经有视频、软件还在 87%」最常见的那段时间差。 */
    const done = !!(url && /^https?:\/\//i.test(url))
      || st === 'success' || st === 'completed' || st === 'done';
    if (!done) continue;
    if (!url) { task.status = 'failed'; task.error = '助手完成任务但没有返回视频地址'; return; }
    const reused = [...tasks.values()].some((o) => o !== task && o.remoteVideoUrl && o.remoteVideoUrl === url);
    if (reused && dupHits < dupLimit) {
      dupHits += 1;
      if (dupHits === 1) log('疑似串台：拿到的视频地址和别的任务相同，继续等新片', task.id, url.slice(0, 90));
      if (dupHits >= dupLimit) log('串台保护到期，仍返回同一地址，按此结果收下', task.id);
      else continue;
    }
    task.progress = 95;
    task.stage = 'downloading';
    task.message = '豆包已出片，正在取回成片…';
    log('豆包已出片，开始取回', task.id, url.slice(0, 90));
    try {
      await saveVideo(task, url, dupHits ? '(串台重试 ' + dupHits + ' 次后拿到新片)' : '');
      return;
    } catch (e) {
      saveFails += 1;
      log('成片取回失败', task.id, '第' + saveFails + '轮', String((e && e.message) || e).slice(0, 140));
      /* CDN 地址过期/被限流时，让助手重新去页面抓一条新地址，然后继续轮询。
       * 旧代码这里直接判 failed，视频就彻底丢了。 */
      startReap(task, '成片地址取回失败');
      task.progress = 92;
      task.stage = 'retry';
      task.message = '成片地址暂时取不到，正在重试…';
      if (saveFails >= 3) {
        task.status = 'failed';
        task.error = String((e && e.message) || e);
        return;
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  if (task.status !== 'success') {
    task.status = 'failed';
    task.error = '豆包出片超时（' + Math.round((Number(task.resultTimeoutMs) || DEFAULT_RESULT_TIMEOUT_MS) / 60000) + ' 分钟）';
    startReap(task, '超时后兜底补抓');
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const LOG_FILE = path.join(process.env.APPDATA || os.homedir(), 'MJStudio', 'logs', 'video-gateway.log');

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* ignore */ }
}

process.on('uncaughtException', (e) => {
  log('未捕获异常', String((e && e.stack) || e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('未处理的 Promise 拒绝', String((e && e.stack) || e));
});

function findFfmpeg() {
  const cands = [
    process.env.MJ_FFMPEG,
    path.join(__dirname, 'ffmpeg.exe'),
    'D:/漫剧分镜台-A方案分享版/无限想象/resources/ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (c === 'ffmpeg' || fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return '';
}

const FFMPEG = findFfmpeg();

/* ------------------------------ 任务表 ------------------------------ */
const tasks = new Map(); // id -> {id,status,progress,videoUrl,error,createdAt,prompt}

/* 前端「获取视频结果超时」真正落地的地方：
 *   前端 body 里带 videoResultTimeoutMs（设置页 25 分钟 → 1500000），网关必须把它
 *   1) 原样转给助手，2) 用同一个值做自己轮询助手的上限。
 * 以前这两处都没接，助手只会用默认 10 分钟、网关又写死 15 分钟，
 * 所以用户把设置改成 25/45 分钟其实一直没生效。 */
const DEFAULT_RESULT_TIMEOUT_MS = 30 * 60 * 1000;

function newTask(prompt, resultTimeoutMs) {
  const id = 'vg_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const t = {
    id,
    status: 'processing',
    progress: 10,
    videoUrl: '',
    error: '',
    createdAt: Date.now(),
    prompt: String(prompt || '').slice(0, 80),
    helperId: '',
    accountId: '',
    accountName: '',
    queued: false,
    waitNote: '',
    rawError: '',
    lastPollAt: 0,
    polledOnce: false,
    cancelRequested: false,
    orphaned: false,
    resultTimeoutMs: Math.min(60 * 60 * 1000, Math.max(60 * 1000, Number(resultTimeoutMs) || DEFAULT_RESULT_TIMEOUT_MS)),
  };
  tasks.set(id, t);
  return t;
}

/* ------------------- 分镜 ⇄ 豆包账号 分配（一个分镜一个窗口） -------------------
 * 助手的模型是「一个账号一个 Chrome 窗口」：每个账号有自己的 profile 目录和调试端口
 * （portForAccount），同一账号同一时刻只能跑一条，不同账号可以同时跑。
 * 以前这里要么全局串行、要么只按「今天用得最少」挑账号，结果几个分镜同时点下去全挤在
 * 同一个账号上排队，排在后面的还会把前一条的成片端回来（用户看到「生成的都是同一个」）。
 *
 * 现在改成按账号占位：
 *   · 每个分镜进来先领一个「还有次数、当前没被别的分镜占用」的账号 → 各自开自己的窗口并行跑；
 *   · 次数用完 / 冷却中 / 停用的账号直接跳过，用还有次数的；
 *   · 一个还有次数的都没有 → 立刻报错，不再白等 25 分钟；
 *   · 有次数但都在跑 → 等空位，界面上显示「等空闲豆包账号」。 */
const accountHolders = new Map();   // accountId -> taskId（谁占着这个账号的窗口）
const accountSkipUntil = new Map(); // accountId -> 时间戳（助手明确报次数用完/未登录时先避开）

function numOf(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function accountIdOf(a) { return String((a && (a.id || a.accountId)) || ''); }

function accountUsable(a) {
  if (!a) return false;
  const id = accountIdOf(a);
  if (!id) return false;
  const st = String(a.status || 'active').toLowerCase();
  if (st && st !== 'active') return false;
  if (numOf(a.cooldownUntil ?? a.cooldown_until) > Date.now()) return false;
  const used = numOf(a.dailyUsed ?? a.daily_used ?? a.usedCount ?? a.used_count);
  const limit = numOf(a.dailyLimit ?? a.daily_limit ?? a.totalLimit ?? a.total_limit);
  if (limit > 0 && used >= limit) return false;
  if (numOf(accountSkipUntil.get(id)) > Date.now()) return false;
  return true;
}

async function helperAccountList() {
  const j = await helperCall('/accounts', 'GET', undefined, 6000);
  return (j && (j.accounts || j.data)) || [];
}

/* 领一个账号：优先今天用得最少的，其次最久没动过的 */
async function reserveAccount(task) {
  const waitBudget = Math.min(8 * 60 * 1000, Math.max(3 * 60 * 1000, task.resultTimeoutMs * 0.4));
  const startedAt = Date.now();
  let lastNote = '';
  for (;;) {
    if (task.cancelRequested) throw new Error('已取消生成');
    let list = [];
    try { list = await helperAccountList(); } catch (e) {
      throw new Error('读取豆包账号失败：' + String((e && e.message) || e));
    }
    if (!list.length) throw new Error('豆包助手还没有账号，请先在「豆包插件」页添加并登录豆包账号。');
    const usable = list.filter(accountUsable);
    if (!usable.length) {
      const limits = list.map((a) => numOf(a.dailyLimit ?? a.daily_limit)).filter((n) => n > 0);
      const total = limits.length ? limits.reduce((s, n) => s + n, 0) : 0;
      const used = list.reduce((s, a) => s + numOf(a.dailyUsed ?? a.daily_used), 0);
      const e = new Error(`豆包账号今天的次数都用完了（${list.length} 个账号，今日共 ${total || '?'} 次，已用 ${used} 次）。`
        + '请在「豆包插件」页添加账号 / 重置次数 / 调高每日次数后再点生成。');
      e.fatal = true; // 换账号也没用，别再重试
      throw e;
    }
    const free = usable.filter((a) => {
      const holder = accountHolders.get(accountIdOf(a));
      return !holder || holder === task.id;
    });
    if (free.length) {
      free.sort((x, y) => (numOf(x.dailyUsed ?? x.daily_used) - numOf(y.dailyUsed ?? y.daily_used))
        || (numOf(x.lastUsedAt ?? x.last_used_at) - numOf(y.lastUsedAt ?? y.last_used_at)));
      const pick = free[0];
      const id = accountIdOf(pick);
      accountHolders.set(id, task.id);
      task.accountId = id;
      task.accountName = String(pick.name || id);
      task.queued = false;
      task.waitNote = '';
      if (lastNote) log(`等到空账号「${task.accountName}」，继续提交`, task.id);
      return id;
    }
    const waited = Date.now() - startedAt;
    if (waited > waitBudget) {
      throw new Error(`当前 ${usable.length} 个还有次数的豆包账号都在生成中，等了 ${Math.round(waited / 60000)} 分钟仍没空出来，先跳过这个分镜。`);
    }
    if (!task.queued) log(`还有次数的账号都在跑（${usable.length} 个），本单等空位`, task.id);
    task.queued = true;
    task.waitNote = `等空闲豆包账号（${usable.length} 个都在跑）`;
    task.progress = Math.min(20, 8 + Math.floor(waited / 15000));
    lastNote = task.waitNote;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function releaseAccount(task) {
  const id = String(task.accountId || '');
  if (id && accountHolders.get(id) === task.id) accountHolders.delete(id);
  task.accountId = '';
  task.accountName = '';
  task.queued = false;
  task.waitNote = '';
}

/* 账号级故障（次数用完 / 未登录 / 账号被占用）——换号才有意义，其它失败不重试 */
function isAccountProblem(msg) {
  return /次数|额度|quota|未登录|登录态|login|账号.*(忙|不可用|异常|删除)|busy|locked/i.test(String(msg || ''));
}
function markAccountProblem(accountId, task, raw) {
  if (!accountId) return;
  const s = String(raw || '');
  /* 「这个账号正被别的任务占着」不算账号坏，只是这次错开了，下次照样能用 */
  if (/正在执行其他任务|账号.*忙|busy|locked/i.test(s) && !/次数|额度|quota/i.test(s)) {
    log(`账号「${task.accountName || accountId}」正被别的任务占着，换一个`, task.id);
    return;
  }
  accountSkipUntil.set(accountId, Date.now() + 10 * 60 * 1000);
  log(`账号「${task.accountName || accountId}」暂时避开 10 分钟`, task.id, s.slice(0, 60));
}

/* --------------------------- 图片素材准备 --------------------------- */
async function materializeImage(entry, idx) {
  if (!entry) return '';
  const s = String(entry).trim();
  if (!s) return '';
  try {
    if (s.startsWith('data:')) {
      const m = s.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) return '';
      const ext = /jpe?g/.test(m[1]) ? '.jpg' : /webp/.test(m[1]) ? '.webp' : '.png';
      const p = path.join(OUT_DIR, `src_${Date.now()}_${idx}${ext}`);
      fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
      return p;
    }
    if (/^https?:\/\//i.test(s)) {
      const r = await fetch(s);
      if (!r.ok) return '';
      const buf = Buffer.from(await r.arrayBuffer());
      const p = path.join(OUT_DIR, `src_${Date.now()}_${idx}.png`);
      fs.writeFileSync(p, buf);
      return p;
    }
    const p = s.replace(/\\\\/g, '\\');
    if (fs.existsSync(p)) return p;
    // 前端有时把路径数组 JSON 化后当字符串塞进来
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr[0]) return await materializeImage(arr[0], idx);
    } catch { /* ignore */ }
  } catch (e) {
    log('materializeImage 失败:', e.message);
  }
  return '';
}

async function firstImage(images) {
  if (!images) return '';
  let list = images;
  if (typeof list === 'string') {
    try { const j = JSON.parse(list); list = Array.isArray(j) ? j : [list]; } catch { list = [list]; }
  }
  if (!Array.isArray(list)) list = [list];
  for (let i = 0; i < list.length; i += 1) {
    const p = await materializeImage(list[i], i);
    if (p) return p;
  }
  return '';
}

/* --------------------------- mock 出片 --------------------------- */
function ratioToSize(ratio) {
  const r = String(ratio || '16:9');
  if (/^9:16/.test(r)) return [720, 1280];
  if (/^1:1/.test(r)) return [1024, 1024];
  if (/^4:3/.test(r)) return [1024, 768];
  if (/^3:4/.test(r)) return [768, 1024];
  return [1280, 720];
}

function renderMock(imgPath, durationSec, ratio, taskId) {
  return new Promise((resolve, reject) => {
    const [W, H] = ratioToSize(ratio);
    const secs = Math.max(2, Math.min(15, Number(durationSec) || 6));
    const frames = Math.round(secs * 25);
    const out = path.join(OUT_DIR, `${taskId}.mp4`);
    const bigW = W * 2;
    const bigH = H * 2;
    const vf = imgPath
      ? `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},` +
        `zoompan=z='min(zoom+${(0.16 / frames).toFixed(6)},1.16)':d=${frames}:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=25,format=yuv420p`
      : `zoompan=z='min(zoom+0.0006,1.12)':d=${frames}:s=${W}x${H}:fps=25,format=yuv420p`;

    const args = imgPath
      ? ['-hide_banner', '-y', '-i', imgPath, '-vf', vf, '-t', String(secs), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
      : ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=0x1b2430:s=${W}x${H}:d=${secs}:r=25`, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-movflags', '+faststart', out];

    log('ffmpeg 渲染', imgPath ? path.basename(imgPath) : '(无参考图，纯色)', `${W}x${H}`, secs + 's');
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error('ffmpeg 失败 code=' + code + ' ' + err.slice(-300)));
    });
  });
}

/* --------------------------- proxy 出片 --------------------------- */
async function proxyCreate(prompt, ratio, duration, images) {
  const body = {
    model: UP_MODEL,
    prompt,
    aspect_ratio: ratio || '16:9',
    seconds: String(duration || 6),
    resolution: '768p',
  };
  const r = await fetch(UPSTREAM + '/v1/videos', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  return j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
}

/* --------------------------- HTTP --------------------------- */
function send(res, code, obj) {
  const buf = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(buf);
}

function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  const total = st.size;
  const range = req.headers.range;
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : total - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': total });
    fs.createReadStream(file).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  if (p !== '/health') log(`${req.method} ${p}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (p === '/health') return send(res, 200, { ok: true, service: 'xingyuan-video-gateway', mode: MODE, ffmpeg: FFMPEG, tasks: tasks.size, out: OUT_DIR });

  if (p === '/generate' || p === '/chat-generate-video' || p === '/v1/videos') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      const prompt = String(body.prompt || '');
      const ratio = String(body.aspect_ratio || body.ratio || '16:9');
      const dm = String(body.duration || body.seconds || '6').match(/(\d+(?:\.\d+)?)/);
      const duration = dm ? Number(dm[1]) : 6;
      const reqTimeoutMs = Number(body.videoResultTimeoutMs || body.video_result_timeout_ms)
        || Number(body.videoResultTimeoutSec || body.video_result_timeout_sec) * 1000
        || 0;
      const task = newTask(prompt, reqTimeoutMs);
      /* 15 秒的片子实测约 230 秒出片，按 15s/秒 估个心跳节奏（最短 2 分钟） */
      task.expectedMs = Math.max(120000, duration * 15000);
      const eff = await effectiveMode();
      log(`接到任务 ${task.id} mode=${eff} model=${body.model || '-'} ${ratio} ${duration}s images=${Array.isArray(body.images) ? body.images.length : typeof body.images} 结果超时=${Math.round(task.resultTimeoutMs / 60000)}分钟`);

      if (eff === 'proxy') {
        try {
          const upId = await proxyCreate(prompt, ratio, duration, body.images);
          task.upstreamId = upId;
          log('上游任务', upId);
        } catch (e) {
          task.status = 'failed';
          task.error = e.message;
          log('上游失败', e.message);
        }
      } else if (eff === 'helper') {
        const params = { prompt, ratio, duration, images: body.images, model: body.model, videoResultTimeoutMs: task.resultTimeoutMs };
        (async () => {
          /* 每个分镜独占一个账号 → 各自开自己的豆包窗口并行跑；
           * 只有「账号级故障」才换号重试，超时/内容审核这类不浪费第二次次数。 */
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (task.cancelRequested) break;
            try {
              const accountId = await reserveAccount(task);
              log(`分镜用账号「${task.accountName || accountId}」开窗口`, task.id, attempt ? '(换号重试)' : '');
              const helperId = await createViaHelper(params, accountId);
              task.helperId = helperId;
              // 提交过程中用户点了取消：这一单刚在助手那边起来，立刻掐掉，别让它继续跑
              if (task.cancelRequested) {
                task.status = 'failed';
                task.error = '已取消生成';
                helperCall(`/tasks/${encodeURIComponent(helperId)}/cancel`, 'POST', {}, 8000)
                  .then(() => log('助手已取消（提交中取消）', helperId))
                  .catch((e) => log('助手取消失败', helperId, String((e && e.message) || e)));
                break;
              }
              task.progress = 12;
              task.status = 'processing';
              task.error = '';
              log('助手任务', helperId, '账号', accountId, attempt ? '(换号重试)' : '');
              await pollHelper(task);
              if (task.status !== 'failed') break;
              if (!isAccountProblem(task.rawError || task.error)) break;
              markAccountProblem(accountId, task, task.rawError || task.error);
            } catch (e) {
              const msg = String((e && e.message) || e);
              task.status = 'failed';
              task.rawError = msg;
              task.error = friendlyError(msg);
              log('助手提交失败', task.error);
              if (e && e.fatal) break;
              if (task.cancelRequested) break;
              if (!isAccountProblem(msg)) break;
              markAccountProblem(task.accountId, task, msg);
            } finally {
              releaseAccount(task);
            }
            if (attempt < 1) log('换下一个还有次数的账号重试', task.id);
          }
        })();
      } else {
        (async () => {
          try {
            const img = await firstImage(body.images);
            task.progress = 30;
            const out = await renderMock(img, duration, ratio, task.id);
            task.videoUrl = `http://127.0.0.1:${PORT}/files/${path.basename(out)}`;
            task.status = 'success';
            task.progress = 100;
            log('出片完成', task.id, path.basename(out), (fs.statSync(out).size / 1048576).toFixed(1) + 'MB');
          } catch (e) {
            task.status = 'failed';
            task.error = String(e.message || e);
            log('出片失败', task.error);
          }
        })();
      }
      return send(res, 200, { task_id: task.id, id: task.id, status: task.status });
    });
    return;
  }

  /* 前端「视频补抓」入口：POST /tasks/{vgId}/refetch-video
   * 这里用网关任务 id，由网关翻译成助手的 tsk_xxx 再转发。以前前端直接拿 vg_xxx 去
   * 请求 8787（助手），助手查不到这个任务 → 404，补抓形同虚设。 */
  const rm = /^\/tasks\/(.+)\/refetch-video$/.exec(p);
  if (rm && req.method === 'POST') {
    const t = tasks.get(decodeURIComponent(rm[1]));
    if (!t) return send(res, 404, { error: 'task_not_found' });
    const started = startReap(t, '前端请求补抓');
    return send(res, 200, { ok: true, started, id: t.id, helperId: t.helperId || '' });
  }

  // 取消：/tasks/{id}/cancel；批量取消：/cancel（前端以后接上就能真取消，目前靠「停止轮询」兜底）
  const cm = /^\/tasks\/(.+)\/cancel$/.exec(p);
  if (cm) {
    const t = tasks.get(decodeURIComponent(cm[1]));
    if (!t) return send(res, 404, { error: 'task_not_found' });
    const ok = cancelTask(t, '接口取消');
    return send(res, 200, { id: t.id, task_id: t.id, status: t.status, cancelled: ok });
  }
  if (p === '/cancel') {
    let n = 0;
    for (const t of tasks.values()) if (cancelTask(t, '接口批量取消')) n += 1;
    return send(res, 200, { cancelled: n, tasks: tasks.size });
  }

  const tm = /^\/tasks\/(.+)$/.exec(p);
  if (tm) {
    const t = tasks.get(decodeURIComponent(tm[1]));
    if (!t) return send(res, 404, { error: 'task_not_found' });
    t.lastPollAt = Date.now();
    t.polledOnce = true;
    return send(res, 200, {
      id: t.id,
      task_id: t.id,
      status: t.status,
      progress: t.progress,
      video_url: t.videoUrl,
      url: t.videoUrl,
      error: t.error || null,
      stage: t.stage || '',
      message: t.message || '',
      helper_id: t.helperId || '',
      remote_task_id: t.remoteTaskId || '',
    });
  }

  const fm = /^\/files\/(.+)$/.exec(p);
  if (fm) return serveFile(req, res, path.join(OUT_DIR, decodeURIComponent(fm[1])));

  return send(res, 404, { error: 'unknown path ' + p });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用，直接退出（可能是外部豆包插件在跑）`);
    process.exit(0);
  }
  log('服务异常', String((e && e.stack) || e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`本地视频网关已启动 http://127.0.0.1:${PORT}  mode=${MODE}`);
  log('ffmpeg =', FFMPEG || '(未找到，mock 模式不可用)');
  log('输出目录 =', OUT_DIR);
});
