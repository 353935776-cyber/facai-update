'use strict';
/**
 * 资产库匹配索引（纯函数，不依赖 electron / fs，便于单测与真实数据回放）。
 *
 * 资源改成「按每集」之后，资产库是唯一的跨集来源，匹配规则集中放这里：
 *  - 本作品（本集 id / 父作品 id）的母版优先，避免两个作品的同名角色串图；
 *  - 中文名与原始编号（aliases：role_id / tokenId 等）都作为匹配键；
 *  - 本作品没命中才回退全局，兼容早期 workId 为空或写错的老数据。
 *
 * @param {Array<{disk:string, workId?:string, keys:Array<string>|string}>} entries
 * @param {string[]} scopeIds 本集 id、父作品 id
 * @returns {(key:string)=>string} 取磁盘路径，取不到返回空串
 */
function normName(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

function buildLookup(entries, scopeIds) {
  const scope = new Set((Array.isArray(scopeIds) ? scopeIds : [])
    .map((v) => String(v || '').trim()).filter(Boolean));
  const exact = new Map();
  const fallback = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.disk) continue;
    const wid = String(e.workId || '').trim();
    const inScope = !scope.size || !wid || scope.has(wid);
    const keys = (Array.isArray(e.keys) ? e.keys : [e.keys]).map(normName).filter(Boolean);
    for (const k of keys) {
      if (inScope && !exact.has(k)) exact.set(k, e.disk);
      if (!fallback.has(k)) fallback.set(k, e.disk);
    }
  }
  return (key) => {
    const k = normName(key);
    return (k && exact.get(k)) || (k && fallback.get(k)) || '';
  };
}

module.exports = { normName, buildLookup };
