#!/usr/bin/env node
'use strict';
/**
 * 生成热更新包（免安装包发版）
 *
 * 用法：
 *   node tools/publish-hotfix.cjs --from release13/win-unpacked/resources/app --out D:\dist\hotfix --version 1.0.12 --notes "修复资产归并"
 *
 * 产物：
 *   <out>/files/...        实际文件（按相对路径平铺，只上传变过的）
 *   <out>/latest.json      清单（客户端读这个）
 *
 * 之后把 <out> 整个目录丢到任意静态托管（OSS/COS/Nginx/GitHub+jsDelivr），
 * 把 <地址>/latest.json 填进客户端的 data/update.json（或 %APPDATA%\MJStudio\update.json）。
 * 没有服务器也行：把 <out> 整个目录发给客户放到本机，url 直接填那个目录路径。
 *
 * 说明：清单列【全量文件】，客户端逐文件比 sha256，只下不同的 —— 任何旧版本都能一步升到最新。
 * data/update.json 不会被列进清单，热更永远不会覆盖客户自己填的更新地址。
 */

const fs = require('fs');
const path = require('path');
const core = require('../electron/updater-core.cjs');

/* 与 electron-builder 的 files 规则对齐：备份/日志/临时文件不进包 */
/* dev.json 是「作者本机 = 开发者版」的标记，绝不能进更新包/公开仓库；
 * update.json 是客户各自的更新地址，同理不能被覆盖。 */
const SKIP_FILE = [/\.log$/i, /\.bak$/i, /\.bak-/i, /\.orig-backup/i, /\.hotfix-tmp$/i, /\.part$/i, /^\.DS_Store$/, /^update\.json$/i, /^dev\.json$/i];
/* 随安装包的静态图片/字体/音视频不进热更清单。
 * 客户端 diffFiles 本来就因 hash 一致跳过它们（客户本机必然有、不会下载），
 * 而 GitHub 公开仓库 / 文件推送接口只能承载文本。剔除后「清单」与「上传目录」
 * 完全一致，不会出现清单列了、源上却没有的文件，公开仓库体积也砍掉一半。
 * 以后真要热更换图，把对应扩展名从这里去掉即可。 */
const SKIP_BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|woff2?|ttf|eot|otf|mp3|mp4|wav|avi|mov)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', '.cache']);
/* 推到 GitHub 公开仓库时，这几个文件绝不能上传：license.cjs 内嵌了激活码与
 * 更新清单共用的 HMAC 密钥碎片，公开后任何人都能造激活码/伪造更新。
 * 客户端本机一直有这个文件，清单里不列它不影响功能，只是以后不能热更它。
 * gen-dev-token.cjs 是作者给自己开开发者版的工具，也不该下发。 */
const SKIP_SECRET_PATH = new Set([
  'electron/license.cjs',
  'tools/gen-dev-token.cjs',
]);

function arg(name, dft) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dft;
}
function has(name) { return process.argv.includes(`--${name}`); }

function walk(root, rel, out) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(root, r, out);
    } else if (e.isFile()) {
      if (SKIP_FILE.some((re) => re.test(e.name))) continue;
      if (SKIP_BINARY_EXT.test(e.name)) continue;
      if (SKIP_SECRET_PATH.has(r)) continue;
      out.push(r);
    }
  }
}

function main() {
  const from = path.resolve(arg('from', 'release13/win-unpacked/resources/app'));
  const out = path.resolve(arg('out', 'hotfix-out'));
  const version = String(arg('version', '')).trim();
  const notes = String(arg('notes', '')).trim();
  const secret = String(arg('secret', '')).trim() || require('../electron/license.cjs').secret();

  if (!fs.existsSync(path.join(from, 'package.json'))) {
    console.error(`[错误] ${from} 不像应用目录（缺 package.json）`);
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error('[错误] 必须用 --version 指定版本号，例如 --version 1.0.12');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
  /* electron-builder 会把包内 package.json 的 build 字段剥掉。热更若把这个剥离版
   * 写回本机源码目录，下次打包就会丢配置。--pkg 指到源码里的完整 package.json 即可。 */
  let publishPkg = pkg;
  const pkgArg = String(arg('pkg', '')).trim();
  if (pkgArg) {
    try {
      publishPkg = JSON.parse(fs.readFileSync(path.resolve(pkgArg), 'utf8'));
    } catch (e) {
      console.error(`[错误] 读不到 --pkg 指定的文件：${pkgArg} (${e.message})`);
      process.exit(1);
    }
  }
  console.log(`源目录 : ${from}`);
  console.log(`版本   : ${pkg.version || '(未知)'} -> ${version}`);
  console.log(`配置源 : ${pkgArg ? path.resolve(pkgArg) : '(同发布源)'}`);

  /* 1. 收集文件（只收集白名单目录下的） */
  const all = [];
  walk(from, '', all);
  const files = [];
  const copied = [];
  const kept = [];
  let totalBytes = 0;

  for (const rel of all) {
    const chk = core.checkRelPath(rel);
    if (!chk.ok) continue;
    const abs = path.join(from, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    const sha = core.sha256File(abs);
    if (!sha) continue;
    const entry = { path: chk.path, size: st.size, sha256: sha };
    /* package.json 里的版本号要改成新版，否则重启后界面还显示旧号 */
    if (chk.path === 'package.json') {
      const next = { ...publishPkg, version };
      const buf = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8');
      entry.size = buf.length;
      entry.sha256 = require('crypto').createHash('sha256').update(buf).digest('hex');
      entry.__buf = buf;
    }
    files.push(entry);
    totalBytes += entry.size;

    /* 2. 拷到 out/files，sha 相同的保留不动（省得上传整包） */
    const dst = path.join(out, 'files', chk.path);
    const oldSha = fs.existsSync(dst) ? core.sha256File(dst) : '';
    if (oldSha === entry.sha256) { kept.push(chk.path); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (entry.__buf) fs.writeFileSync(dst, entry.__buf);
    else fs.copyFileSync(abs, dst);
    copied.push(chk.path);
  }

  if (!files.length) {
    console.error('[错误] 没有收集到任何文件');
    process.exit(1);
  }

  /* 2.5 清掉 out/files 里已不在清单中的历史残留。
   * 这个目录是原样推到公开仓库的，留一个旧的 license.cjs 就等于密钥泄露。 */
  const allowed = new Set(files.map((f) => f.path));
  const pruned = [];
  (function prune(dir, rel) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        prune(abs, r);
        try { fs.rmdirSync(abs); } catch { /* 非空就留着 */ }
      } else if (e.isFile() && !allowed.has(r)) {
        try { fs.unlinkSync(abs); pruned.push(r); } catch { /* ignore */ }
      }
    }
  })(path.join(out, 'files'), '');
  if (pruned.length) console.log(`已清理历史残留 ${pruned.length} 个：${pruned.join(', ')}`);

  /* 3. 清单 + 签名 */
  const manifest = {
    version,
    notes: notes || `${version} 更新`,
    pubDate: new Date().toISOString(),
    fileBase: 'files/',
    files: files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 })),
  };
  manifest.sig = core.signManifest(manifest, secret);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));

  /* 4. 自检：签一遍再验一遍，防止自己发出去一个验不过的包 */
  const vr = core.verifyManifest(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')), secret);
  if (!vr.ok) {
    console.error(`[错误] 清单自检失败：${vr.reason}`);
    process.exit(1);
  }

  const mb = (totalBytes / 1048576).toFixed(1);
  console.log('');
  console.log(`文件总数 : ${files.length} 个，${mb} MB`);
  console.log(`新拷贝   : ${copied.length} 个`);
  console.log(`已最新   : ${kept.length} 个（跳过上传）`);
  console.log(`清单     : ${path.join(out, 'latest.json')}`);
  console.log(`签名     : ${manifest.sig.slice(0, 16)}…`);
  console.log('');
  console.log('下一步：把整个目录同步到静态托管，确保能访问 <地址>/latest.json');
}

main();
