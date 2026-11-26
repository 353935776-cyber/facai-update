'use strict';
/**
 * 按分镜顺序把一集视频拼成整集 MP4
 *
 * 用法：
 *   node episode-concat.cjs <草稿目录>              输出 <草稿目录的上级>\成片_<名称>.mp4
 *   node episode-concat.cjs <草稿目录> --out x.mp4
 *   node episode-concat.cjs <草稿目录> --dir-out     强制输出到草稿目录内部
 *
 * 两种模式：
 *   1) 参数一致（同分辨率/帧率/编码）→ -c copy 无损拼接，秒级完成；
 *   2) 参数不一致 → 按第一镜统一 scale+pad / fps / aac 转码后再拼，保证能连着播。
 *
 * 说明：
 *   剪映 6.0+ 的 draft_content.json 是加密的，第三方写的明文草稿 8.x 不认，
 *   所以「写草稿」这条路在新版剪映上不可靠。直接把镜头按顺序拼成整集再进剪映，
 *   顺序天然正确，也不会因为剪映升级而失效。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

/* 异步跑 ffmpeg，避免转码时阻塞 Electron 主进程（界面卡死） */
function run(ffmpeg, args) {
  return new Promise((resolve) => {
    let err = '';
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, err: String((e && e.message) || e) });
    }
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 200000) err = err.slice(-100000); });
    child.on('error', (e) => resolve({ code: -1, err: String((e && e.message) || e) }));
    child.on('close', (code) => resolve({ code, err }));
  });
}

const FFMPEG_CANDS = [
  process.env.FFMPEG_PATH,
  path.join(__dirname, 'ffmpeg.exe'),
  path.join(__dirname, '..', '..', 'ffmpeg.exe'),
].filter(Boolean);

function findFfmpeg() {
  for (const p of FFMPEG_CANDS) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return '';
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function naturalOrder(a, b) {
  const na = Number((a.match(/^(\d+)/) || [])[1] || 1e9);
  const nb = Number((b.match(/^(\d+)/) || [])[1] || 1e9);
  return na - nb;
}

function probe(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const t = String(r.stderr || '');
  const d = t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = t.match(/Stream #\d+:\d+.*?Video:\s*([a-z0-9]+).*?(\d{2,5})x(\d{2,5})/i);
  const f = t.match(/(\d+(?:\.\d+)?)\s*fps/);
  const a = t.match(/Stream #\d+:\d+.*?Audio:\s*([a-z0-9]+).*?(\d{4,6})\s*Hz,\s*(mono|stereo)/i);
  const dur = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  return {
    duration: dur,
    vcodec: v ? v[1].toLowerCase() : '',
    width: v ? Number(v[2]) : 0,
    height: v ? Number(v[3]) : 0,
    fps: f ? Math.round(Number(f[1])) : 0,
    acodec: a ? a[1].toLowerCase() : '',
    sampleRate: a ? Number(a[2]) : 0,
    channels: a ? (a[3].toLowerCase() === 'mono' ? 1 : 2) : 0,
    hasAudio: !!a,
  };
}

function signature(p) {
  return `${p.vcodec}|${p.width}x${p.height}|${p.fps}|${p.acodec}|${p.sampleRate}|${p.channels}`;
}

function listClips(videoDir) {
  return fs.readdirSync(videoDir)
    .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
    // 排除之前生成过的成片，避免把成片又拼进去
    .filter((f) => !/^成片[_-]/.test(f) && !/_成片\.mp4$/i.test(f))
    .sort(naturalOrder);
}

function writeList(files, videoDir) {
  const listFile = path.join(os.tmpdir(), `concat-${process.pid}-${Date.now()}.txt`);
  const body = files.map((f) => {
    const abs = path.join(videoDir, f).replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${abs}'`;
  }).join('\n');
  fs.writeFileSync(listFile, body, 'utf8');
  return listFile;
}

async function concatCopy(ffmpeg, files, videoDir, out) {
  const listFile = writeList(files, videoDir);
  const t0 = Date.now();
  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart',
    out,
  ]);
  try { fs.unlinkSync(listFile); } catch { /* ignore */ }
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { ok: false, err: String(r.err || '').slice(-400), seconds: Math.round((Date.now() - t0) / 1000) };
  }
  return { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
}

async function concatReencode(ffmpeg, files, videoDir, out, base, probes) {
  const t0 = Date.now();
  const W = (base.width % 2 === 0 ? base.width : base.width + 1) || 1280;
  const H = (base.height % 2 === 0 ? base.height : base.height + 1) || 720;
  const FPS = base.fps || 24;
  const AR = base.sampleRate || 44100;
  // 只要有任意一镜是立体声就统一成立体声，避免整集被压成单声道
  const CH = probes.some((p) => p.channels >= 2) ? 2 : 1;

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  files.forEach((f) => args.push('-i', path.join(videoDir, f)));

  const parts = [];
  const labels = [];
  probes.forEach((p, i) => {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
    );
    if (p.hasAudio) {
      parts.push(`[${i}:a]aresample=${AR},aformat=sample_fmts=fltp:channel_layouts=${CH === 1 ? 'mono' : 'stereo'}[a${i}]`);
    } else {
      const d = Math.max(0.1, p.duration || 3).toFixed(3);
      parts.push(`anullsrc=r=${AR}:cl=${CH === 1 ? 'mono' : 'stereo'},atrim=0:${d},asetpts=N/SR/TB[a${i}]`);
    }
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${files.length}:v=1:a=1[vout][aout]`);

  args.push('-filter_complex', parts.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', String(AR), '-ac', String(CH));
  args.push('-movflags', '+faststart', out);

  const r = await run(ffmpeg, args);
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { ok: false, err: String(r.err || '').slice(-400), seconds: Math.round((Date.now() - t0) / 1000) };
  }
  return { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
}

async function concat(draftDir, outFile, name, opts = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('找不到 ffmpeg.exe');
  const videoDir = path.join(draftDir, 'video');
  if (!fs.existsSync(videoDir)) throw new Error('目录里没有 video 子文件夹：' + videoDir);

  const files = listClips(videoDir);
  if (!files.length) throw new Error('video 文件夹里没有视频：' + videoDir);

  let out;
  if (outFile) out = path.resolve(outFile);
  else if (opts.dirOut) out = path.join(draftDir, `成片_${name || path.basename(draftDir)}.mp4`);
  else out = path.join(path.dirname(path.resolve(draftDir)), `成片_${name || path.basename(draftDir)}.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const probes = files.map((f) => probe(ffmpeg, path.join(videoDir, f)));
  const sigs = [...new Set(probes.map(signature))];
  const mixed = sigs.length > 1;
  const base = probes.find((p) => p.width && p.height) || { width: 1280, height: 720, fps: 24, sampleRate: 44100, channels: 2 };

  let mode = 'copy';
  let r = { ok: false };
  if (!mixed) r = await concatCopy(ffmpeg, files, videoDir, out);
  if (!r.ok) {
    // 参数不一致，或 -c copy 被容器/编码细节卡住 → 转码兜底
    mode = 'reencode';
    r = await concatReencode(ffmpeg, files, videoDir, out, base, probes);
  }
  if (!r.ok) throw new Error(`ffmpeg 合成失败（${mode}）：` + r.err);

  const dur = probe(ffmpeg, out).duration;
  const sizeMb = (fs.statSync(out).size / 1048576).toFixed(1);
  return {
    out,
    count: files.length,
    files,
    mode,
    mixed,
    seconds: r.seconds,
    duration: dur,
    sizeMb,
  };
}

if (require.main === module) {
  (async () => {
    try {
      const draftDir = arg('--video-dir', '') ? path.dirname(path.resolve(arg('--video-dir'))) : process.argv[2];
      if (!draftDir || draftDir.startsWith('--')) throw new Error('请传入草稿目录，例如：node episode-concat.cjs "D:\\剪映草稿\\某作品- 第1集"');
      const name = arg('--name', path.basename(path.resolve(draftDir)));
      const r = await concat(path.resolve(draftDir), arg('--out', ''), name, { dirOut: hasFlag('--dir-out') });
      console.log(`已合成 ${r.count} 个镜头 → ${r.out}`);
      console.log(`模式 ${r.mode}${r.mixed ? '（镜头参数不一致，已统一转码）' : '（无损直拼）'}，时长 ${Math.floor(r.duration / 60)}分${String(Math.round(r.duration % 60)).padStart(2, '0')}秒，${r.sizeMb} MB，耗时 ${r.seconds}s`);
    } catch (e) {
      console.error('失败：' + e.message);
      process.exit(1);
    }
  })();
}

module.exports = { concat, findFfmpeg, probe };
