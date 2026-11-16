'use strict';
/**
 * 跨集资产修复（历史数据兜底）
 *
 * 背景：早期版本「导入分镜」把分镜里的 @role_xxx 直接写成本集的角色表，
 * 只带了 ID，姓名和描述是空的 —— 角色设置里显示成一串 role_dong_zhen，
 * 参考图、音色、出图都接不上；第 1 集正常、第 2 集一导入就"断"。
 *
 * 这里在启动时按「同一个作品」汇总别集的实体，**只回填名字**（name 像 role_xxx 时）。
 * 描述词、图片一律不跨集回填 —— 每一集必须自己重新上传或重新提取描述词
 * （见 stripCrossEpisodeAssets 的每集独立规则）。早期版本这里连 description 一起补，
 * 重启一次就把别集描述灌回本集，保存时又被当成「本集原有」放行，隔离就此失效；2026-11-16 修正。
 * 幂等：重复执行不会再产生改动。
 */

const EXTRA_ID_RE = /^@/;

function looksLikeId(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  /* 编号的写法不止下划线：前端按拼音生成过 role-dong-zhen / ROLE_DONGZHEN，
   * 只认 <kind>_ 会把 role-dong-zhen 当成人名留下来，界面继续显示编号。 */
  return EXTRA_ID_RE.test(s) || /^(role|scene|prop|audio)[-_]/i.test(s);
}

/* 取两个名字里更"像人名"的那个：非 ID 优先；都像人名时取短的（"董震" 优于 "董震（青年）"） */
function pickName(cur, pool) {
  const a = String(cur || '').trim();
  const b = String(pool || '').trim();
  if (!a) return b;
  if (!b) return a;
  const ai = looksLikeId(a);
  const bi = looksLikeId(b);
  if (ai && !bi) return b;
  if (!ai && bi) return a;
  return b.length < a.length ? b : a;
}

/* 描述：只补空，不覆盖已有内容 */
function pickDesc(cur, pool) {
  const a = String(cur || '').trim();
  return a || String(pool || '').trim();
}

function keyOf(item, kind) {
  if (!item || typeof item !== 'object') return '';
  const idFields = kind === 'role'
    ? ['role_id', 'roleId', 'tokenId', 'token_id', 'id', 'name', 'role_name']
    : kind === 'scene'
      ? ['scene_id', 'sceneId', 'tokenId', 'token_id', 'id', 'name', 'scene_name']
      : ['prop_id', 'propId', 'tokenId', 'token_id', 'id', 'name', 'prop_name'];
  for (const f of idFields) {
    const v = String(item[f] || '').trim();
    if (v) return v.replace(/^@+/, '').toLowerCase();
  }
  return '';
}

function assetsOf(ep, kind) {
  const sj = (ep && ep.script_json) || {};
  if (kind === 'role') return Array.isArray(sj.updated_roles) ? sj.updated_roles : [];
  if (kind === 'scene') return Array.isArray(sj.updated_scenes) ? sj.updated_scenes : [];
  return Array.isArray(sj.updated_props) ? sj.updated_props : (Array.isArray(sj.updated_prop) ? sj.updated_prop : []);
}

function collectPool(episodes, kind) {
  const pool = new Map();
  for (const ep of episodes) {
    for (const item of assetsOf(ep, kind)) {
      const k = keyOf(item, kind);
      if (!k) continue;
      const prev = pool.get(k);
      if (!prev) { pool.set(k, item); continue; }
      pool.set(k, {
        ...prev,
        name: pickName(prev.name, item.name),
        description: pickDesc(prev.description, item.description),
      });
    }
  }
  return pool;
}

/**
 * @param {Array} jobs 作品列表（jobs.json 里的 jobs）
 * @returns {{changed:boolean, jobs:Array, stats:object}}
 */
function repairJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const stats = { series: 0, episodes: 0, roles: 0, scenes: 0, props: 0 };

  /* 按作品分组：分集的 parentId 就是所属系列 */
  const groups = new Map();
  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    if (String(job.kind || '') !== 'episode') continue;
    const pid = String(job.parentId || '').trim();
    if (!pid) continue;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(job);
  }

  const replacements = new Map(); /* jobId -> 新的 script_json */

  for (const [pid, episodes] of groups) {
    stats.series += 1;
    stats.episodes += episodes.length;
    const pools = {
      role: collectPool(episodes, 'role'),
      scene: collectPool(episodes, 'scene'),
      prop: collectPool(episodes, 'prop'),
    };

    for (const ep of episodes) {
      let touched = false;
      const sj = { ...(ep.script_json || {}) };

      for (const kind of ['role', 'scene', 'prop']) {
        const field = kind === 'role' ? 'updated_roles' : kind === 'scene' ? 'updated_scenes' : 'updated_props';
        const arr = assetsOf(ep, kind);
        if (!arr.length) continue;
        const pool = pools[kind];
        let changedArr = false;
        const next = arr.map((item) => {
          const k = keyOf(item, kind);
          const src = k ? pool.get(k) : null;
          if (!src) return item;
          const name = looksLikeId(item.name) ? pickName(item.name, src.name) : item.name;
          /* 只回填名字，绝不回填描述词：每一集必须自己重新上传/重新提取描述。
           * 以前这里连 description 一起补，重启一次就把别集的描述灌回本集，
           * 保存时又被当成「本集原有」放行 —— 隔离就此失效。 */
          if (String(name || '') === String(item.name || '')) return item;
          changedArr = true;
          stats[kind === 'role' ? 'roles' : kind === 'scene' ? 'scenes' : 'props'] += 1;
          return { ...item, name };
        });
        if (changedArr) {
          sj[field] = next;
          /* 老数据可能用的是 updated_prop 单数，保持同步免得两处不一致 */
          if (kind === 'prop' && Array.isArray(sj.updated_prop)) sj.updated_prop = next;
          touched = true;
        }
      }

      if (touched) replacements.set(String(ep.id || ''), sj);
    }
  }

  const changed = replacements.size > 0;
  const out = changed
    ? list.map((job) => {
      const id = String((job && job.id) || '');
      const sj = replacements.get(id);
      return sj ? { ...job, script_json: sj } : job;
    })
    : list;

  return { changed, jobs: out, stats };
}

/* ------------------------------------------------------------------
 * 保存时保护图片引用（2026-11-13 晚「扣费了但图片不进软件」的根因）
 *
 * 前端每个页面各自持有一份作品对象，保存时把整条 job 丢给 job:create。
 * 某个页面（剧本页自动保存 / 分镜页 / 角色设置页）手里的 script_json 是旧的，
 * 里面 updated_roles[i].imageUrl 还是空的 —— 一保存就把刚生成好的图覆盖没了。
 * 表现就是：模型后台扣了钱、磁盘上图片明明在，界面上却一直是空的。
 *
 * 这里在写盘前做一次「只补不删」的合并：入参某字段是空的、盘上同 ID 实体有值、
 * 且引用的文件确实存在 → 保留盘上的值。用户主动换图/改名字仍然生效。
 * ------------------------------------------------------------------ */
const ASSET_REF_FIELDS = [
  'imageUrl', 'image_url', 'imgUrl', 'img_url',
  'selectRolePath', 'rolePathList', 'selectRoleRefPath', 'roleRefPathList',
  'selectScenePath', 'scenePathList', 'selectSceneRefPath', 'sceneRefPathList',
  'selectPropPath', 'propPathList', 'selectPropRefPath', 'propRefPathList',
  'gridImageUrl', 'grid_image_url', 'gridImagePath', 'gridImagePathList',
  'threeViewPath', 'threeViewPathList', 'viewPath', 'viewPathList',
];

const SCRIPT_ARRAYS = [
  { field: 'updated_roles', kind: 'role' },
  { field: 'updated_scenes', kind: 'scene' },
  { field: 'updated_props', kind: 'prop' },
  { field: 'updated_prop', kind: 'prop' },
];

function isEmptyVal(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/* 引用是否还“有东西”—— 文件没了就别保留，免得把死链又塞回去 */
function refAlive(v) {
  const one = (x) => {
    const s = String(x || '').trim();
    if (!s) return false;
    if (/^(https?:|data:)/i.test(s)) return true;
    const p = s.replace(/^xingyuan-file:\/\/\/?/i, '').replace(/\//g, '\\');
    try { return require('fs').existsSync(p); } catch { return false; }
  };
  if (Array.isArray(v)) return v.some(one);
  return one(v);
}

/* 单个实体：空字段从盘上补回来 */
function mergeEntity(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return existing;
  const out = { ...incoming };
  for (const f of ASSET_REF_FIELDS) {
    if (!isEmptyVal(out[f])) continue;            /* 入参有值：尊重它 */
    if (isEmptyVal(existing[f])) continue;
    if (!refAlive(existing[f])) continue;          /* 盘上也是死链：不补 */
    out[f] = existing[f];
  }
  /* 名字被 ID 覆盖（导入分镜的典型症状）时保留原名 */
  if (looksLikeId(out.name) && !looksLikeId(existing.name)) out.name = existing.name;
  if (isEmptyVal(out.description) && !isEmptyVal(existing.description)) out.description = existing.description;
  return out;
}

function mergeArray(existingArr, incomingArr, kind) {
  const prev = Array.isArray(existingArr) ? existingArr : [];
  const next = Array.isArray(incomingArr) ? incomingArr : null;
  if (!next) return prev;
  /* 整表被清空多半是前端没加载到，不当成用户删光 */
  if (!next.length) return prev.length ? prev : next;
  const byKey = new Map();
  for (const it of prev) {
    const k = keyOf(it, kind);
    if (k) byKey.set(k, it);
  }
  return next.map((it) => {
    const k = keyOf(it, kind);
    const old = k ? byKey.get(k) : null;
    return old ? mergeEntity(old, it) : it;
  });
}

/**
 * 保存前把「盘上已有的资产引用」并进入参，避免旧页面把新图覆盖掉。
 * @param {object} existing 盘上的同 ID 作品
 * @param {object} incoming 前端提交的作品
 */
function mergeJobOnSave(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return existing;
  const out = { ...existing, ...incoming };

  const oldSj = existing.script_json || {};
  const newSj = incoming.script_json;
  if (newSj && typeof newSj === 'object') {
    const sj = { ...oldSj, ...newSj };
    for (const { field, kind } of SCRIPT_ARRAYS) {
      if (!(field in newSj)) continue;
      sj[field] = mergeArray(oldSj[field], newSj[field], kind);
    }
    /* updated_props / updated_prop 两份别名保持一致 */
    if (Array.isArray(sj.updated_props) && Array.isArray(newSj.updated_prop)) sj.updated_prop = sj.updated_props;
    else if (Array.isArray(sj.updated_prop) && Array.isArray(newSj.updated_props)) sj.updated_props = sj.updated_prop;
    out.script_json = sj;
  }

  /* 分镜表被清空同理（导入失败会写空数组） */
  if (Array.isArray(incoming.storyboard_json)) {
    const prevSb = existing.storyboard_json;
    if (!incoming.storyboard_json.length && Array.isArray(prevSb) && prevSb.length) out.storyboard_json = prevSb;
  }
  return out;
}

/* ------------------------------------------------------------------
 * 图片引用完整性兜底（启动时跑一次）
 *
 * 前端不同页面写同一条资产时用的字段不一样：
 *   生成流程写 selectRolePath + rolePathList + imageUrl + image_url 四个，
 *   剧本页/分镜页保存时只留 selectRolePath + rolePathList，
 *   imageUrl 被抹成空 → 角色卡片/场景卡片取不到缩略图，看着像"图没上传"。
 * 这里把两套字段互相补齐，并优先指向磁盘上真实存在的文件。
 * ------------------------------------------------------------------ */
const REF_KINDS = [
  { kind: 'role', arr: ['updated_roles'], select: 'selectRolePath', list: 'rolePathList' },
  { kind: 'scene', arr: ['updated_scenes'], select: 'selectScenePath', list: 'scenePathList' },
  { kind: 'prop', arr: ['updated_props', 'updated_prop'], select: 'selectPropPath', list: 'propPathList' },
];

const toFileUrl = (p) => 'xingyuan-file:///' + String(p).replace(/\\/g, '/');
const toFsPath = (s) => String(s || '').replace(/^xingyuan-file:\/\/\/?/i, '').replace(/\//g, '\\');

function existsFile(p) {
  try { return !!p && require('fs').existsSync(toFsPath(p)); } catch { return false; }
}

function buildFileIndex(assetsRoot) {
  const fs = require('fs');
  const path = require('path');
  const idx = new Map();
  for (const { kind } of REF_KINDS) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(assetsRoot, kind)); } catch { continue; }
    for (const sub of subs) {
      const m = /^([^_]+)_(.+)$/.exec(sub);
      if (!m) continue;
      const abs = path.join(assetsRoot, kind, sub);
      let files = [];
      try {
        files = fs.readdirSync(abs)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .map((f) => {
            const p = path.join(abs, f);
            let t = 0;
            try { t = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
            return { p, t };
          })
          .filter((x) => x.t > 0)
          .sort((a, b) => b.t - a.t);
      } catch { continue; }
      if (!files.length) continue;
      const key = `${kind}|${String(m[2]).replace(/^@+/, '').toLowerCase()}`;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(...files);
    }
  }
  for (const [, list] of idx) list.sort((a, b) => b.t - a.t);
  return idx;
}

/**
 * @param {Array} jobs 作品列表
 * @param {string} assetsRoot 数据目录下的 assets
 */
function fillAssetRefs(jobs, assetsRoot) {
  const list = Array.isArray(jobs) ? jobs : [];
  const fs = require('fs');
  const idx = assetsRoot && fs.existsSync(assetsRoot) ? buildFileIndex(assetsRoot) : new Map();
  const stats = { role: 0, scene: 0, prop: 0 };
  let changed = false;

  const out = list.map((job) => {
    if (!job || String(job.kind || '') !== 'episode' || !job.script_json) return job;
    let touched = false;
    const sj = { ...job.script_json };
    for (const { kind, arr, select, list: listField } of REF_KINDS) {
      for (const field of arr) {
        const items = sj[field];
        if (!Array.isArray(items) || !items.length) continue;
        let arrTouched = false;
        const next = items.map((it) => {
          if (!it || typeof it !== 'object') return it;
          const curSel = String(it[select] || '').trim();
          const curUrl = String(it.imageUrl || it.image_url || '').trim();
          const curList = Array.isArray(it[listField]) ? it[listField].filter(Boolean) : [];
          const disk = idx.get(`${kind}|${String(keyOf(it, kind)).toLowerCase()}`) || [];
          const diskPaths = disk.map((d) => d.p);

          /* 挑一个真实存在的文件当主图 */
          let best = '';
          if (existsFile(curUrl)) best = toFsPath(curUrl);
          else if (existsFile(curSel)) best = curSel;
          else if (curList.some(existsFile)) best = curList.find(existsFile);
          else if (diskPaths.length) best = diskPaths[0];
          if (!best) return it;

          const needSel = !curSel || !existsFile(curSel);
          const needUrl = !curUrl || !existsFile(curUrl);
          const needList = !curList.length || !curList.some(existsFile);
          if (!needSel && !needUrl && !needList) return it;

          const allPaths = Array.from(new Set([
            best,
            ...curList.filter(existsFile),
            ...diskPaths,
          ]));
          arrTouched = true;
          stats[kind] += 1;
          return {
            ...it,
            [select]: best,
            [listField]: allPaths,
            imageUrl: toFileUrl(best),
            image_url: toFileUrl(best),
          };
        });
        if (arrTouched) {
          sj[field] = next;
          touched = true;
          if (kind === 'prop') {
            const alias = field === 'updated_props' ? 'updated_prop' : 'updated_props';
            if (Array.isArray(sj[alias])) sj[alias] = next;
          }
        }
      }
    }
    if (!touched) return job;
    changed = true;
    return { ...job, script_json: sj };
  });

  return { changed, jobs: out, stats };
}

/* ==================================================================
 * 同名归并 + 资产库联动（保存时执行，幂等）
 *
 * 背景：AI 续写剧本时会给同一角色起新 id（老刀 @role_laodao → @role_old_dao），
 * 而资产表只按 id 去重，于是同一个人变成两条：一条有图、一条没图，
 * 100 集下来会膨胀成几十条。这里在保存前按「名字」再归并一次，
 * 并把分镜/提示词里的旧 id 引用一起改写。
 * ================================================================== */

const ASSET_SPECS = [
  { kind: 'role', field: 'updated_roles', alias: null, select: 'selectRolePath', list: 'rolePathList' },
  { kind: 'scene', field: 'updated_scenes', alias: null, select: 'selectScenePath', list: 'scenePathList' },
  { kind: 'prop', field: 'updated_props', alias: 'updated_prop', select: 'selectPropPath', list: 'propPathList' },
];

function normAssetName(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

/* 图片路径归一化，只用于判断"是不是同一张图" */
function normAssetPath(v) {
  return String(v || '').trim().replace(/\\/g, '/').toLowerCase();
}

function assetHasImage(it, spec) {
  if (!it || typeof it !== 'object') return false;
  if (String(it[spec.select] || '').trim()) return true;
  const arr = it[spec.list];
  return Array.isArray(arr) && arr.some((p) => String(p || '').trim());
}

function firstAssetPath(it, spec) {
  if (!it || typeof it !== 'object') return '';
  const sel = String(it[spec.select] || '').trim();
  if (sel) return sel;
  const arr = Array.isArray(it[spec.list]) ? it[spec.list] : [];
  const hit = arr.find((p) => String(p || '').trim());
  return String(hit || '');
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* 全量改写 @role_xxx / @scene_xxx / @prop_xxx；带右边界，避免 @role_old 命中 @role_old_dao */
function replaceAssetRefs(node, mapping) {
  if (typeof node === 'string') {
    let out = node;
    for (const oldId of Object.keys(mapping)) {
      if (!oldId) continue;
      out = out.replace(new RegExp(escRe(oldId) + '(?![\\w])', 'g'), mapping[oldId]);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((v) => replaceAssetRefs(v, mapping));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = replaceAssetRefs(node[k], mapping);
    return out;
  }
  return node;
}

/**
 * 同名归并 + @id 引用重写。
 * 【按每集模式】调用方传 others=[]：只在当前分集内部去重，绝不把兄弟集的
 * 条目并进本集，也不把本集的 @id 改写成别集的 id。跨集复用一律走资产库补图。
 * @param {object} job      待保存的分集
 * @param {object[]} others 其它分集；传空数组即「每集独立」
 * @returns {{job:object, merged:Array}}
 */
function dedupeJobAssets(job, others) {
  if (!job || !job.script_json || typeof job.script_json !== 'object') return { job, merged: [] };
  const pool = { role: new Map(), scene: new Map(), prop: new Map() };
  for (const sib of (Array.isArray(others) ? others : [])) {
    if (!sib || sib === job || !sib.script_json) continue;
    for (const spec of ASSET_SPECS) {
      const arr = sib.script_json[spec.field] || sib.script_json[spec.alias || spec.field];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const key = normAssetName(it && it.name);
        if (!key) continue;
        if (!pool[spec.kind].has(key)) pool[spec.kind].set(key, []);
        pool[spec.kind].get(key).push(it);
      }
    }
  }

  const mapping = {};
  const merged = [];
  const sj = job.script_json;

  for (const spec of ASSET_SPECS) {
    const arr = sj[spec.field];
    if (!Array.isArray(arr) || !arr.length) continue;
    const kept = [];
    const local = new Map();          /* 本集内部同名兜底 */
    for (const it of arr) {
      if (!it || typeof it !== 'object') { kept.push(it); continue; }
      const id = String(it.id || '');
      const key = normAssetName(it.name);
      let target = null;

      const selfImg = assetHasImage(it, spec);
      const selfPath = normAssetPath(firstAssetPath(it, spec));
      const cands = (pool[spec.kind].get(key) || []).filter((c) => c && String(c.id || '') && String(c.id) !== id);
      if (cands.length) {
        const withImg = cands.filter((c) => assetHasImage(c, spec));
        if (!selfImg) {
          /* 本集这条还没出图 → 并到别集有图的那条，省一次出图 */
          if (withImg.length === 1) target = withImg[0];
          else if (!withImg.length && cands.length === 1) target = cands[0];
        } else {
          /* 本集这条已经有图（换装 / 战损 / 变体 / 用户单独重出）：
           * 只有在"就是同一张图"时才归并；否则保留本集的图，
           * 绝不能把新造型打回上集的旧图。 */
          const sameImg = withImg.filter((c) => selfPath && normAssetPath(firstAssetPath(c, spec)) === selfPath);
          if (sameImg.length === 1) target = sameImg[0];
        }
      }
      if (!target && key && local.has(key)) {
        /* 本集内部同名：同样只在"这条没图"时并到前一条，已有图的一律保留 */
        if (!selfImg) target = local.get(key);
      }

      if (target && String(target.id || '') !== id) {
        /* 统一到「有图的那条」：图缺了就从被合并项搬过去 */
        if (!assetHasImage(target, spec) && assetHasImage(it, spec)) {
          target[spec.list] = Array.isArray(it[spec.list]) ? [...it[spec.list]] : [];
          target[spec.select] = String(it[spec.select] || '') || (target[spec.list] || [])[0] || '';
          if (it.imageUrl) target.imageUrl = it.imageUrl;
          if (it.image_url) target.image_url = it.image_url;
        }
        mapping[id] = String(target.id);
        merged.push({ kind: spec.kind, name: String(it.name || ''), from: id, to: String(target.id), item: it });
        continue;
      }

      if (key && !local.has(key)) local.set(key, it);
      kept.push(it);
    }
    sj[spec.field] = kept;
    if (spec.alias && Array.isArray(sj[spec.alias])) sj[spec.alias] = kept;
  }

  if (!merged.length) return { job, merged };

  let out = replaceAssetRefs(job, mapping);

  /* 被合并掉的条目进回收站，可恢复 */
  const rb = (out.recycle_bin && typeof out.recycle_bin === 'object') ? out.recycle_bin : { version: 1, items: [] };
  const items = Array.isArray(rb.items) ? rb.items.slice() : [];
  const now = new Date().toISOString();
  for (const m of merged) {
    items.unshift({
      binId: `recycle_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      kind: m.kind,
      entityId: m.from,
      snapshot: m.item,
      originalIndex: 0,
      deletedAt: now,
      deletedFrom: '自动同名归并',
    });
  }
  out = { ...out, recycle_bin: { ...rb, version: 1, items } };
  return { job: out, merged };
}

/** 本集里「已有图」的资产清单，供写入资产库 */
function listAssetsWithImages(job) {
  const out = [];
  const sj = (job && job.script_json) || {};
  for (const spec of ASSET_SPECS) {
    const arr = sj[spec.field] || sj[spec.alias || spec.field];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const p = firstAssetPath(it, spec);
      if (!p) continue;
      const name = String((it && it.name) || '').trim();
      if (!name) continue;
      out.push({ kind: spec.kind, name, path: p, item: it });
    }
  }
  return out;
}

/**
 * 按名字从资产库补图（只补空，不覆盖已有图）。
 * @param {function(string,string):string} lookup (kind, name) -> 磁盘路径
 */
function fillAssetsFromLibrary(job, lookup) {
  if (typeof lookup !== 'function') return 0;
  let n = 0;
  const sj = (job && job.script_json) || {};
  for (const spec of ASSET_SPECS) {
    const arr = sj[spec.field] || sj[spec.alias || spec.field];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it || typeof it !== 'object' || assetHasImage(it, spec)) continue;
      /* 变体/换装/战损形态不套用母版图，否则新造型会被补成旧图 */
      const variant = String(it.variant_name || '').trim();
      if (variant && variant !== '默认形态') continue;
      /* 按每集之后不再从兄弟集带实体，匹配键要更全：
       * 中文名 / 资产 id / role_id 等编号 / tokenId，命中任意一个即可补图。 */
      const keys = [
        it.name, it.id, it[`${spec.kind}_id`], it.tokenId, it.token_id,
      ].map((v) => String(v || '').trim()).filter(Boolean);
      let hit = '';
      for (const k of keys) {
        try { hit = lookup(spec.kind, k) || ''; } catch { hit = ''; }
        if (hit) break;
      }
      if (!hit) continue;
      it[spec.select] = hit;
      it[spec.list] = [hit];
      it.imageUrl = toFileUrl(hit);
      it.image_url = it.imageUrl;
      n += 1;
    }
  }
  return n;
}

/* ==================================================================
 * 资产身份归一化 + 引用完整性（1.0.22，根治 role_xxx 空壳）
 *
 * 为什么以前修了还会犯：同一个人/场景/道具在不同链路里会拿到不同写法
 * 的编号 —— AI 给 @role_dongzhen、前端按拼音生成 role_dong_zhen、
 * 导入分镜写 role_dongzhen、旧数据是 @role_dong_zhen。以前所有补名逻辑
 * 都按「字符串全等」找兄弟集，换个写法就找不到；而且只在「保存」时补，
 * 读出来给界面用的仍是空壳；分镜里的 id 指向表里不存在的行时，界面
 * 就直接把 id 当名字显示（红色 role_xxx）。
 *
 * 这里立一条不变量，读、写、启动三处都过同一个函数：
 *   1) 本集资产表每一行都必须有「不像编号」的名字；
 *   2) 分镜 role_ids/scene_ids/prop_ids 必须能在本集资产表里命中。
 * 归一化键把 @、大小写、下划线/连字符差异全部抹平，因此
 * role_dong_zhen / role_dongzhen / @role_dong_zhen 视为同一个实体。
 * 幂等：修完再跑一遍不会产生任何改动。
 * ================================================================== */
const NORM_KINDS = [
  ['role', 'updated_roles'],
  ['scene', 'updated_scenes'],
  ['prop', 'updated_props'],
];
const SHOT_REF_FIELDS = [
  ['role', 'role_ids', 'roleIds'],
  ['scene', 'scene_ids', 'sceneIds'],
  ['prop', 'prop_ids', 'propIds'],
];

function bareAssetId(v) {
  return String(v || '').trim().replace(/^@+/, '');
}

/* 归一化键：去掉 @ / 类型前缀 / 大小写 / 下划线 / 连字符 / 空格。
 * role_dong_zhen、@role_dongzhen、ROLE-DONG-ZHEN -> dongzhen
 * 中文名保持原样，用于「按名字找回编号」。 */
function canonAssetKey(v) {
  let s = bareAssetId(v).toLowerCase();
  s = s.replace(/^(role|scene|prop|audio)[_-]?/, '');
  return s.replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
}

/* 编号的宽松正则：每个字母数字之间允许 _ - 空格，兼容所有历史写法 */
function idLoosePattern(raw) {
  const chars = bareAssetId(raw).replace(/[^0-9a-z]/gi, '').split('');
  if (!chars.length) return '';
  return chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*');
}

/**
 * 从「董震（role_dong_zhen）」「董震 ( @role_dongzhen )」这类文本里取中文名。
 * 与编号写法无关，只要求括号里是同一个编号。
 */
function nameFromPromptText(text, rawId) {
  const t = String(text || '');
  const pat = idLoosePattern(rawId);
  if (!t || !pat) return '';
  const re = new RegExp(
    `([\\u4e00-\\u9fff][\\u4e00-\\u9fff0-9A-Za-z·]{0,15})\\s*[（(]\\s*@?${pat}(?![\\w-])`,
    'i',
  );
  const m = re.exec(t);
  if (!m) return '';
  return String(m[1]).replace(/^(角色|人物|场景|道具)/, '').trim();
}

/* 本集可用于反查名字的全部文本：分镜提示词 + 剧本正文。
 * 刻意跳过 updated_* 资产表自身，避免「自己引用自己」的假命中。 */
function jobPromptText(job) {
  const parts = [JSON.stringify((job && job.storyboard_json) || {})];
  const sj = (job && job.script_json) || {};
  for (const [k, v] of Object.entries(sj)) {
    if (k.startsWith('updated_')) continue;
    parts.push(typeof v === 'string' ? v : JSON.stringify(v || ''));
  }
  return parts.join('\n');
}

/**
 * 汇总「归一化编号 -> 中文名」。
 * 名字来源优先级：本集已有名字 > 兄弟集已有名字 > 提示词里的「中文名（编号）」。
 * 名字是身份信息，允许跨集复用；描述词与图片仍然绝不跨集。
 */
function collectAssetNameMap(episodes) {
  const maps = { role: new Map(), scene: new Map(), prop: new Map() };
  const put = (kind, key, name) => {
    if (!kind || !key || !name || looksLikeId(name)) return;
    const m = maps[kind];
    if (m && !m.has(key)) m.set(key, name);
  };
  for (const ep of (Array.isArray(episodes) ? episodes : [])) {
    if (!ep || typeof ep !== 'object') continue;
    for (const [kind, field] of NORM_KINDS) {
      for (const it of assetsOf(ep, kind)) {
        const nm = String(it.name || it[`${kind}_name`] || '').trim();
        if (!nm || looksLikeId(nm)) continue;
        for (const v of [it.id, it[`${kind}_id`], it.tokenId, it.token_id, nm]) {
          put(kind, canonAssetKey(v), nm);
        }
      }
    }
    /* 提示词里的配对：中文名（编号），编号写法不限 */
    const text = jobPromptText(ep);
    const re = /([\u4e00-\u9fff][\u4e00-\u9fff0-9A-Za-z·]{0,15})\s*[（(]\s*@?((?:role|scene|prop)[_-][A-Za-z0-9_-]+)/gi;
    let m;
    while ((m = re.exec(text))) {
      const id = m[2];
      const kind = /^role/i.test(id) ? 'role' : /^scene/i.test(id) ? 'scene' : 'prop';
      const nm = String(m[1]).replace(/^(角色|人物|场景|道具)/, '').trim();
      put(kind, canonAssetKey(id), nm);
    }
  }
  return maps;
}

/**
 * 补齐本集资产表的显示名（只改名，不动描述词/图片/音色）。
 * 修的是「name 为空或等于编号」的行；已有中文名的一律不碰。
 */
function repairAssetNames(job, siblings) {
  const out = { fixed: [], unresolved: [] };
  const sj = (job && job.script_json) || null;
  if (!sj) return out;
  const maps = collectAssetNameMap([job, ...(Array.isArray(siblings) ? siblings : [])]);
  const text = jobPromptText(job);
  for (const [kind, field] of NORM_KINDS) {
    const arr = sj[field];
    if (!Array.isArray(arr) || !arr.length) continue;
    let touched = false;
    const next = arr.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const cur = String(it.name || '').trim();
      if (cur && !looksLikeId(cur)) return it;
      const keys = [it.id, it[`${kind}_id`], it.tokenId, it.token_id, cur]
        .map(canonAssetKey).filter(Boolean);
      let nm = '';
      for (const k of keys) { nm = maps[kind].get(k) || ''; if (nm) break; }
      if (!nm && cur) nm = nameFromPromptText(text, cur);
      if (!nm) {
        out.unresolved.push(`${kind}:${cur || keys[0] || '?'}`);
        return it;
      }
      touched = true;
      out.fixed.push(`${kind}:${cur || keys[0]}->${nm}`);
      const copy = { ...it, name: nm };
      copy[`${kind}_name`] = nm;
      return copy;
    });
    if (touched) sj[field] = next;
  }
  return out;
}

function tableIndexOf(job, kind) {
  const byId = new Map();
  const byCanon = new Map();
  const byName = new Map();
  for (const it of assetsOf(job, kind)) {
    const id = bareAssetId(it.id || it[`${kind}_id`] || it.tokenId || it.token_id);
    const name = String(it.name || '').trim();
    if (id) {
      byId.set(id.toLowerCase(), id);
      byCanon.set(canonAssetKey(id), id);
    }
    if (name) {
      byName.set(name, id);
      byCanon.set(canonAssetKey(name), id);
    }
  }
  return { byId, byCanon, byName };
}

/* 递归找分镜对象（兼容 storyboards / updated_storyboards / 任意嵌套） */
function walkShots(node, cb, depth) {
  const d = depth || 0;
  if (!node || typeof node !== 'object' || d > 8) return;
  if (Array.isArray(node)) { for (const x of node) walkShots(x, cb, d + 1); return; }
  cb(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkShots(v, cb, d + 1);
  }
}

/**
 * 分镜引用对齐：把 role_ids/scene_ids/prop_ids 里「表里不存在的写法」
 * 改成本集资产表里的正式编号；表里完全没有、但提示词能反查出中文名的，
 * 补一行只有名字的空资产（本集独立，不继承别集描述/图片）。
 * 这样界面不会再把编号当名字显示。
 */
function relinkShotRefs(job) {
  const out = { relinked: [], created: [], dangling: [] };
  const sj = (job && job.script_json) || null;
  if (!sj || !job.storyboard_json) return out;
  const idx = {};
  for (const [kind] of SHOT_REF_FIELDS) idx[kind] = tableIndexOf(job, kind);

  /* 补空资产行：只补名字，描述与图片留空，等用户按集重新上传/匹配 */
  const ensureRow = (kind, rid, nm) => {
    const field = kind === 'role' ? 'updated_roles' : kind === 'scene' ? 'updated_scenes' : 'updated_props';
    if (!Array.isArray(sj[field])) sj[field] = [];
    const id = `@${bareAssetId(rid)}`;
    const row = { id, name: nm };
    row[`${kind}_id`] = id;
    row[`${kind}_name`] = nm;
    sj[field].push(row);
    const t = tableIndexOf(job, kind);
    idx[kind] = t;
    out.created.push(`${kind}:${nm}(${bareAssetId(rid)})`);
    return bareAssetId(rid);
  };

  walkShots(job.storyboard_json, (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const prompt = String(obj.prompt || obj.text || obj.promptText || '');
    for (const [kind, snake, camel] of SHOT_REF_FIELDS) {
      for (const f of [snake, camel]) {
        const list = obj[f];
        if (!Array.isArray(list) || !list.length) continue;
        const seen = new Set();
        const next = [];
        for (const raw of list) {
          const rid = bareAssetId(raw);
          if (!rid) continue;
          const t = idx[kind];
          let hit = t.byId.get(rid.toLowerCase()) || t.byCanon.get(canonAssetKey(rid)) || '';
          if (!hit) {
            const nm = nameFromPromptText(prompt, rid);
            if (nm) {
              hit = t.byName.get(nm) || t.byCanon.get(canonAssetKey(nm)) || '';
              if (!hit) hit = ensureRow(kind, rid, nm);
            }
          }
          if (!hit) { out.dangling.push(`${kind}:${rid}`); continue; }
          const val = String(raw).startsWith('@') ? `@${bareAssetId(hit)}` : bareAssetId(hit);
          if (bareAssetId(hit) !== rid) out.relinked.push(`${kind}:${rid}->${bareAssetId(hit)}`);
          if (seen.has(val)) continue;
          seen.add(val);
          next.push(val);
        }
        if (next.length !== list.length || next.some((v, i) => v !== list[i])) obj[f] = next;
      }
    }
  });
  return out;
}

/** 读/写/启动共用的唯一入口：先把本集资产身份修齐，再对齐分镜引用 */
function normalizeEpisodeAssets(job, siblings) {
  const names = repairAssetNames(job, siblings);
  const refs = relinkShotRefs(job);
  /* 兼容旧字段：有些页面读 updated_prop，有些读 updated_props */
  const sj = (job && job.script_json) || {};
  if (Array.isArray(sj.updated_props) && Array.isArray(sj.updated_prop)) {
    sj.updated_prop = sj.updated_props;
  }
  const changed = names.fixed.length + refs.relinked.length + refs.created.length > 0;
  return { job, changed, names, refs };
}

/* ------------------------------------------------------------------
 * 每集独立硬守卫（1.0.19）
 *
 * 前端历史上有两条「把兄弟集资产并进本集」的链路：1.0.16 断了 Il()
 * （AI 分解结果应用），1.0.19 断了 pk()/Kv()（导入分镜保存）。这里在主进程
 * 保存时再兜一层：不管前端以后又从哪条路径带过来，只要是「本次新出现」的
 * 条目，带着别的分集的图片路径，或与兄弟集同源、本集分镜又没引用，就不落盘。
 *
 * 安全设计：只处理相对盘上旧对象（prev）新增的条目。用户手动新增的行、
 * 手动「从资产库匹配图片」改的是已有条目，一律不动；历史遗留数据也不动，
 * 由一次性清理脚本单独处理（带备份 + 回收站）。
 * ------------------------------------------------------------------ */
const CROSS_IMG_FIELDS = [
  'selectRolePath', 'rolePathList', 'selectRoleRefPath', 'roleRefPathList',
  'selectScenePath', 'scenePathList', 'selectSceneRefPath', 'sceneRefPathList',
  'selectPropPath', 'propPathList', 'selectPropRefPath', 'propRefPathList',
  'imageUrl', 'image_url', 'mediaPath', 'cover', 'coverPath',
];
const CROSS_SCRIPT_ARRAYS = [
  ['role', 'updated_roles'], ['scene', 'updated_scenes'], ['prop', 'updated_props'],
];

function crossPathStrings(it) {
  const out = [];
  for (const f of CROSS_IMG_FIELDS) {
    const v = it[f];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}

/* 每集独立 v3：描述词同样不允许跨集沿用。新集可以重新上传/重新提取，
 * 但不能带着别集的描述词落地（客户截图里那种 role_xxx 空壳行就是这么来的）。 */
const CROSS_DESC_FIELDS = [
  'description', 'visualPrompt', 'prompt', 'remark', 'desc', 'appearance',
  'outfit', 'promptText', 'descText', 'feature', 'features', 'visual_prompt',
];

function clearCrossImages(it) {
  for (const f of CROSS_IMG_FIELDS) {
    const v = it[f];
    if (Array.isArray(v)) it[f] = [];
    else if (typeof v === 'string' && v) it[f] = '';
  }
}

function clearCrossDescriptions(it) {
  for (const f of CROSS_DESC_FIELDS) {
    if (typeof it[f] === 'string' && it[f]) it[f] = '';
  }
}

/* 从分镜里的「郭宝才 ( @role_guobaocai )」这种标注反查中文名。
 * 1.0.22 起统一走宽松匹配，编号写法（下划线/连字符/@）不同也能命中。 */
function nameFromPrompt(text, key) {
  return nameFromPromptText(text, key);
}

function stripCrossEpisodeAssets(job, prev, others) {
  const result = { job, removed: [], cleared: [], renamed: [], unresolved: [] };
  const sj = job && job.script_json;
  if (!sj || typeof sj !== 'object') return result;

  const eps = (Array.isArray(others) ? others : []).filter((x) => x && x.kind === 'episode');
  const otherIds = eps.map((x) => String(x.id || '').trim()).filter((v) => v.length >= 8);
  if (!otherIds.length) return result;

  /* 兄弟集资产索引：key -> 描述集合（描述逐字相同 = 从别集复制来的强证据）
   * 另建 nameIndex：key -> 兄弟集里的中文名，只用来给「name=role_xxx」的空壳补名 —
   * 名字是身份，不是本集内容；描述词和图片永远不跨集。 */
  const index = { role: new Map(), scene: new Map(), prop: new Map() };
  const nameIndex = { role: new Map(), scene: new Map(), prop: new Map() };
  for (const ep of eps) {
    for (const [kind] of CROSS_SCRIPT_ARRAYS) {
      for (const it of assetsOf(ep, kind)) {
        const k = keyOf(it, kind);
        /* 同一实体在别集可能是另一种编号写法（role_dong_zhen / role_dongzhen），
         * 索引同时登记归一化键，否则「跨集同源」永远判不出来，也会被当成新实体落盘。 */
        const ck = canonAssetKey(it.id || it[`${kind}_id`] || it.tokenId || it.token_id || k);
        const keys = [k, ck].filter(Boolean);
        if (!keys.length) continue;
        const d = String(it.description || it.visualPrompt || it.prompt || '').trim();
        const nm = String(it.name || '').trim();
        for (const key of keys) {
          if (!index[kind].has(key)) index[kind].set(key, new Set());
          if (d) index[kind].get(key).add(d);
          if (nm && !looksLikeId(nm) && !nameIndex[kind].has(key)) nameIndex[kind].set(key, nm);
        }
      }
    }
  }

  /* 本集引用文本：分镜表 + 剧本文本，排除资产表自身与回收站，避免自引用 */
  const parts = [JSON.stringify(job.storyboard_json || {})];
  for (const [k, v] of Object.entries(sj)) {
    if (k.startsWith('updated_')) continue;
    parts.push(typeof v === 'string' ? v : JSON.stringify(v || ''));
  }
  const blob = parts.join(' ');

  const referenced = (it) => {
    const ids = [it.id, it.tokenId, it.token_id, it.role_id, it.scene_id, it.prop_id]
      .map((v) => String(v || '').trim().replace(/^@+/, '')).filter((v) => v.length >= 3);
    if (ids.some((v) => blob.indexOf(v) >= 0)) return true;
    const nm = String(it.name || '').trim();
    return !!(nm && nm.length >= 2 && blob.indexOf(nm) >= 0);
  };
  const siblingSet = (kind, keys) => {
    for (const key of keys) {
      const set = index[kind].get(key);
      if (set) return set;
    }
    return null;
  };
  const sameAsSibling = (it, kind, keys) => {
    const set = siblingSet(kind, keys);
    if (!set) return false;
    const d = String(it.description || it.visualPrompt || it.prompt || '').trim();
    return !d || !set.size || set.has(d);
  };
  const prevKeys = { role: new Set(), scene: new Set(), prop: new Set() };
  for (const [kind] of CROSS_SCRIPT_ARRAYS) {
    for (const it of assetsOf(prev || {}, kind)) {
      const k = keyOf(it, kind);
      const ck = canonAssetKey(it.id || it[`${kind}_id`] || it.tokenId || it.token_id || k);
      if (k) prevKeys[kind].add(k);
      if (ck) prevKeys[kind].add(ck);
    }
  }

  for (const [kind, field] of CROSS_SCRIPT_ARRAYS) {
    if (!Array.isArray(sj[field])) continue;
    const kept = [];
    for (const it of sj[field]) {
      if (!it || typeof it !== 'object') { kept.push(it); continue; }
      const k = keyOf(it, kind);
      const ck = canonAssetKey(it.id || it[`${kind}_id`] || it.tokenId || it.token_id || k);
      const keys = [k, ck].filter(Boolean);
      /* 本集原有的条目一律放行：不删、不清图，避免动用户已配好的资产 */
      if (keys.some((key) => prevKeys[kind].has(key))) { kept.push(it); continue; }
      /* 【每集完全独立 v3】新集首次落盘：凡是跟兄弟集同源的实体（同名/同编号，
       * 且描述词为空或与别集逐字相同），一律不沿用别集的描述词与图片。
       * 本集分镜/剧本没提到 -> 直接移除；提到了 -> 留一个空行，
       * 由用户重新上传描述词、再从资产库匹配图片或重新生成。
       * 本集自己重新提取且描述词不同的实体不受影响（sameAsSibling 为 false）。 */
      if ((!prev || !prev.script_json) && keys.length && siblingSet(kind, keys) && sameAsSibling(it, kind, keys)) {
        if (!referenced(it)) {
          result.removed.push(`${kind}:${String(it.name || k)}`);
          continue;
        }
        const blank = { ...it };
        clearCrossDescriptions(blank);
        clearCrossImages(blank);
        result.cleared.push(`${kind}:${String(it.name || k)}`);
        kept.push(blank);
        continue;
      }
      const paths = crossPathStrings(it);
      const crossPath = paths.some((p) => otherIds.some((id) => p.indexOf(id) >= 0));
      /* 本集分镜/脚本根本没提到、又跟兄弟集同源的实体，不写进本集 */
      if (keys.length && siblingSet(kind, keys) && sameAsSibling(it, kind, keys) && !referenced(it)) {
        result.removed.push(`${kind}:${String(it.name || k)}`);
        continue;
      }
      let out = it;
      if (crossPath) {
        out = { ...it };
        clearCrossImages(out);   /* 只改副本，不碰内存里其它作品对象 */
        result.cleared.push(`${kind}:${String(it.name || k)}`);
      }
      kept.push(out);
    }
    sj[field] = kept;
    if (field === 'updated_props' && Array.isArray(sj.updated_prop)) sj.updated_prop = kept;
  }

  /* 【资产名回填】统一走 repairAssetNames（同一个归一化键、同一套提示词反查），
   * 避免「守卫里补名」和「读取时补名」两套规则各修一半、互相打架。 */
  const named = repairAssetNames(job, eps);
  result.renamed.push(...named.fixed);
  result.unresolved.push(...named.unresolved);
  return result;
}

module.exports = {
  repairJobs, keyOf, looksLikeId, pickName, pickDesc,
  mergeJobOnSave, mergeEntity, isEmptyVal, refAlive, fillAssetRefs,
  dedupeJobAssets, listAssetsWithImages, fillAssetsFromLibrary, normAssetName, replaceAssetRefs,
  stripCrossEpisodeAssets,
  /* 1.0.22 资产身份归一化 + 引用完整性（读/写/启动共用） */
  canonAssetKey, nameFromPromptText, collectAssetNameMap,
  repairAssetNames, relinkShotRefs, normalizeEpisodeAssets,
};
