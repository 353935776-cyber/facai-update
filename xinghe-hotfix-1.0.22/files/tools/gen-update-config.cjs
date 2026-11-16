#!/usr/bin/env node
'use strict';
/**
 * 生成「GitHub 主源 + 国内镜像」的多地址 update.json。
 *
 * 用法：
 *   node tools/gen-update-config.cjs --repo 你的用户名/仓库名 [--branch main] [--out 客户交付/update.json] [--pages]
 *
 * 生成的 update.json 和 setup-update.bat 放在同一目录一起发给客户：
 * 客户双击 bat 即自动安装配置，连网址都不用粘贴。
 */
const fs = require('fs');
const path = require('path');

function arg(name, dft) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dft;
}
function has(name) { return process.argv.includes(`--${name}`); }

const repo = String(arg('repo', '')).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
const branch = String(arg('branch', 'main')).trim();
const dir = String(arg('dir', 'hotfix')).trim().replace(/^\/+|\/+$/g, '');
const out = path.resolve(String(arg('out', '客户交付/update.json')));

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error('[错误] 请用 --repo 用户名/仓库名，例如 --repo zhangsan/xinghe-hotfix');
  process.exit(1);
}
const [user, name] = repo.split('/');
const rel = `${dir}/latest.json`;
const urls = [
  `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${rel}`,      // 国内 CDN，最快
  `https://raw.githubusercontent.com/${repo}/${branch}/${rel}`, // 实时无缓存，用来破 CDN 旧缓存
  `https://fastly.jsdelivr.net/gh/${repo}@${branch}/${rel}`,    // 备用 CDN 节点
  `https://gcore.jsdelivr.net/gh/${repo}@${branch}/${rel}`,     // 备用 CDN 节点
];
if (has('pages')) urls.splice(1, 0, `https://${user}.github.io/${name}/${rel}`);

/* 关键兼容：已发出的 1.0.13 客户端读配置用的是 String(f.url).trim()，
 * 若 url 写成数组会被拼成逗号串，变成一个无效网址，客户将永远更不了。
 * 所以主地址必须是【单个字符串】，其余备用地址放 mirrors：
 *   - 1.0.13 只读 url，拿到国内 CDN，能正常更新；
 *   - 1.0.15+ 的 cfgUrls() 会合并 url + urls + mirrors，自动变成多源切换。
 * 客户升到新版后，界面里手动保存地址时才会写成数组，那时已无老版本负担。 */
const cfg = { url: urls[0], mirrors: urls.slice(1), auto: true };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

console.log(`已写出 : ${out}`);
console.log(`更新源 : ${urls.length} 个`);
urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
console.log(`
接下来（只做一次，网页拖拽即可，不用装 git）：
  1) 打开 https://github.com/${repo} （必须是【公开】仓库，jsDelivr 才能加速）
  2) 把 D:/dist/star-aigc-hotfix-*.zip 里那个 ${dir}/ 文件夹【整个拖进】网页的
     Add file → Upload files（注意拖文件夹，不要只选文件，否则目录结构会平铺）
  3) 拉到底点 Commit changes。等 1~2 分钟，浏览器能打开上面第 1 个地址看到 JSON 即成功。
  4) 把 ${path.basename(out)} 和 setup-update.bat 放一起发给客户，双击 bat 即可。

以后发版：重新跑 publish-hotfix.cjs 生成新目录，覆盖仓库里的 ${dir}/ 再 commit，
         然后访问一次 https://purge.jsdelivr.net/gh/${repo}@${branch}/${rel} 清缓存。

注意：公开仓库里的 ${dir}/ 会包含前端与脚本源码，已自动剔除含密钥的 electron/license.cjs。
      介意源码公开的话，改用腾讯云 COS / 阿里云 OSS 私有托管。`);
