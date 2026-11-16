'use strict';
/**
 * 一次性历史数据迁移（1.0.19）
 *
 * 1.0.19 之前，前端有两条「把兄弟集资产整表并进本集」的链路：
 *   - Il()：AI 分解结果应用（1.0.16 已断）
 *   - pk()/Kv()：导入分镜保存（1.0.19 已断）
 * 代码修好后，已经落盘的老数据不会自己消失（例如第 4 集里塞了第 1~3 集
 * 全部角色/场景/道具，还带着别集的图片路径）。这里在启动时跑一次，
 * 把这些历史残留清掉，让「每一集独立」对老作品也成立。
 *
 * 安全：
 *   - 只跑一次（数据目录里留标记文件），以后新建的分集由前端 + 主进程守卫保证干净
 *   - 写盘前备份 jobs.json
 *   - 删掉的条目整条放进该分集自带的回收站，可随时恢复
 *   - 只删「本集分镜/脚本没引用」且「与兄弟集同源或带别集图片」的条目；
 *     本集新解析的、用户手动新增的、指向资产库的图片一律不动
 */
const fs = require('fs');
const path = require('path');

const FIELDS = [
  ['role', 'updated_roles'], ['scene', 'updated_scenes'], ['prop', 'updated_props'],
];
const ID_KEYS = ['id', 'tokenId', 'token_id', 'role_id', 'scene_id', 'prop_id', 'entityId'];
const REF_KEYS = ['role_ids', 'prop_ids', 'scene_ids', 'role_id', 'scene_id', 'prop_id'];
const IMG_FIELDS = [
  'selectRolePath', 'rolePathList', 'selectRoleRefPath', 'roleRefPathList',
  'selectScenePath', 'scenePathList', 'selectSceneRefPath', 'sceneRefPathList',
  'selectPropPath', 'propPathList', 'selectPropRefPath', 'propRefPathList',
  'imageUrl', 'image_url', 'mediaPath', 'cover', 'coverPath',
];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function keysOf(it) {
  const out = new Set();
  for (const k of ID_KEYS) {
    const v = String((it && it[k]) || '').trim().replace(/^@+/, '');
    if (v) out.add(v);
  }
  return out;
}

function pathsOf(it) {
  const out = [];
  for (const f of IMG_FIELDS) {
    const v = it && it[f];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}

function clearImages(it) {
  for (const f of IMG_FIELDS) {
    const v = it[f];
    if (Array.isArray(v)) { if (v.length) it[f] = []; }
    else if (typeof v === 'string' && v) it[f] = '';
  }
}

/* 本集引用：分镜表 + 剧本文本；排除资产表自身与回收站，避免自引用 */
function collectRefs(ep) {
  const ids = new Set();
  const texts = [];
  const walk = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'string') { texts.push(v); return; }
    if (typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (REF_KEYS.includes(k)) {
        for (const x of (typeof val === 'string' ? [val] : (Array.isArray(val) ? val : []))) {
          if (typeof x === 'string' && x.trim()) ids.add(x.trim().replace(/^@+/, ''));
        }
      }
      walk(val);
    }
  };
  walk(ep.storyboard_json || {});
  const sj = ep.script_json || {};
  for (const [k, v] of Object.entries(sj)) {
    if (k.startsWith('updated_')) continue;
    walk(v);
  }
  const blob = texts.join(' ');
  for (const m of blob.matchAll(/@([A-Za-z0-9_-]{3,})/g)) ids.add(m[1]);
  return { ids, blob };
}

/**
 * @param {string} jobsFile  jobs.json 绝对路径
 * @param {string} dataDir   数据目录（放备份与标记）
 * @param {Function} log     日志函数
 */
function migrate(jobsFile, dataDir, log) {
  const say = typeof log === 'function' ? log : () => {};
  const flag = path.join(dataDir, 'migrate-isolate-v2.json');
  if (fs.existsSync(flag)) return { skipped: true, reason: 'already-done' };

  const data = readJson(jobsFile, null);
  const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
  const eps = jobs.filter((x) => x && x.kind === 'episode');
  const result = { skipped: false, jobs: jobs.length, episodes: eps.length, removed: 0, cleared: 0, perEpisode: [] };

  for (const ep of eps) {
    const sj = ep.script_json;
    if (!sj || typeof sj !== 'object') continue;
    const series = String(ep.parentId || ep.id || '');
    const siblings = eps.filter((x) => x !== ep && String(x.parentId || x.id || '') === series);
    const otherIds = siblings.map((x) => String(x.id || '').trim()).filter((v) => v.length >= 8);
    const sibKeys = new Set();
    const sibNames = new Set();
    for (const other of siblings) {
      const osj = other.script_json || {};
      for (const [, field] of FIELDS) {
        for (const it of (Array.isArray(osj[field]) ? osj[field] : [])) {
          for (const k of keysOf(it)) sibKeys.add(k);
          const nm = String((it && it.name) || '').trim();
          if (nm) sibNames.add(nm);
        }
      }
    }
    const { ids: refs, blob } = collectRefs(ep);
    const rb = ep.recycle_bin && typeof ep.recycle_bin === 'object' ? ep.recycle_bin : { version: 1, items: [] };
    if (!Array.isArray(rb.items)) rb.items = [];
    ep.recycle_bin = rb;
    const stamp = Date.now();
    let removed = 0;
    let cleared = 0;

    /* 先只做判定，不动数据：因为「要不要顺手清掉保留条目上的别集图片」
     * 取决于这一集是不是真的被整表复制过（即有没有删掉的条目）。 */
    const buckets = [];
    let dropCount = 0;
    for (const [kind, field] of FIELDS) {
      if (!Array.isArray(sj[field])) continue;
      const list = [];
      for (const it of sj[field]) {
        if (!it || typeof it !== 'object') { list.push({ it, drop: false, crossImg: false }); continue; }
        const keys = keysOf(it);
        const nm = String(it.name || '').trim();
        const used = [...keys].some((k) => refs.has(k)) || !!(nm && nm.length >= 2 && blob.indexOf(nm) >= 0);
        const paths = pathsOf(it);
        const crossImg = paths.some((p) => otherIds.some((id) => p.indexOf(id) >= 0));
        const same = [...keys].some((k) => sibKeys.has(k)) || !!(nm && sibNames.has(nm));
        const drop = !used && (same || crossImg);
        if (drop) dropCount++;
        list.push({ it, drop, crossImg });
      }
      buckets.push({ kind, field, list });
    }
    /* 只有「本次确实删掉了跨集实体」的分集（典型是新建集被整表复制），
     * 才把保留条目上残留的别集图片也清掉，交给用户自己从资产库匹配。
     * 像第 1~3 集这种资产表本身干净、只是几张图指向别集目录的历史数据，
     * 一个字都不动 —— 免得用户觉得「我的图怎么没了」。 */
    const doClear = dropCount > 0;
    let seq = 0;
    for (const { kind, field, list } of buckets) {
      const kept = [];
      for (const d of list) {
        const it = d.it;
        if (d.drop) {
          rb.items.push({
            binId: `recycle_isolate_${stamp}_${kind}_${seq++}`,
            kind,
            entityId: String((it && (it.id || it.tokenId || it.name)) || ''),
            snapshot: JSON.parse(JSON.stringify(it)),
            deletedAt: stamp,
            reason: '1.0.19 每集独立：清理跨集带入资产',
          });
          removed++;
          continue;
        }
        if (doClear && d.crossImg) { clearImages(it); cleared++; }
        kept.push(it);
      }
      sj[field] = kept;
      if (field === 'updated_props' && Array.isArray(sj.updated_prop)) sj.updated_prop = kept;
    }
    if (removed || cleared) {
      result.perEpisode.push({ episodeNo: ep.episodeNo, removed, cleared });
      result.removed += removed;
      result.cleared += cleared;
    }
  }

  if (result.removed || result.cleared) {
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.copyFileSync(jobsFile, path.join(dataDir, `jobs.json.bak-before-isolate-v2-${stamp}`));
    } catch (e) { say('[isolate] 备份失败（不阻断）', e && e.message); }
    fs.writeFileSync(jobsFile, JSON.stringify({ ...data, jobs }, null, 0), 'utf8');
    say('[isolate] 历史跨集资产已清理', JSON.stringify(result.perEpisode));
  }
  try { fs.writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), ...result }), 'utf8'); }
  catch { /* 标记写不了就下次再跑一次，逻辑幂等 */ }
  return result;
}

module.exports = { migrate, collectRefs, keysOf, pathsOf, clearImages };
