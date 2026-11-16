/* 资产名显示兜底（1.0.22）
 *
 * 主进程已经在「读 / 写 / 启动」三处把 name=role_xxx 的空壳修掉了，
 * 这个脚本只兜住最后一种情况：用户在页面里刚导入/刚提取，数据还没保存，
 * 界面先把编号当名字显示出来（红色 role_dong_zhen），看起来就像又复发了。
 *
 * 只改显示、不改数据：找到形如 role_xxx / scene-xxx / @prop_xxx 的纯文本，
 * 在同一行的提示词里找「中文名（同一个编号）」，能反查到就换成中文名，
 * 原编号放到 title 里，鼠标悬停仍可查。观察器会跟着 React 重渲染重跑。
 */
(function () {
  if (window.__mjAssetNameGuard) return;
  window.__mjAssetNameGuard = true;

  var ID_RE = /^@?(role|scene|prop)[_-][A-Za-z0-9_-]{2,60}$/i;
  var PAIR_RE = /([\u4e00-\u9fff][\u4e00-\u9fff0-9A-Za-z·]{0,15})\s*[（(]\s*@?((?:role|scene|prop)[_-][A-Za-z0-9_-]{2,60})/gi;

  function looseBody(id) {
    return String(id).replace(/^@/, '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  }

  function namesIn(text) {
    var map = {};
    var m;
    PAIR_RE.lastIndex = 0;
    while ((m = PAIR_RE.exec(text))) {
      var key = looseBody(m[2]);
      if (!map[key]) map[key] = m[1].replace(/^(角色|人物|场景|道具)/, '').trim();
    }
    return map;
  }

  /* 纯函数，便于单测：给一个编号和一段上下文，返回可显示的中文名 */
  function resolveName(idText, contextText) {
    var text = String(idText || '').trim();
    if (!ID_RE.test(text)) return '';
    var map = namesIn(String(contextText || ''));
    return map[looseBody(text)] || '';
  }

  /* 取节点前后紧邻的一小段文字（跨兄弟节点、最多上溯 4 层） */
  function nearText(node, dir) {
    var out = '';
    var n = node;
    for (var up = 0; up < 4 && n; up++) {
      var s = dir < 0 ? n.previousSibling : n.nextSibling;
      while (s) {
        var t = s.nodeType === 3 ? s.nodeValue : (s.nodeType === 1 ? (s.textContent || '') : '');
        out = dir < 0 ? t + out : out + t;
        if (out.length >= 12) return dir < 0 ? out.slice(-12) : out.slice(0, 12);
        s = dir < 0 ? s.previousSibling : s.nextSibling;
      }
      n = n.parentElement;
    }
    return dir < 0 ? out.slice(-12) : out.slice(0, 12);
  }

  /* 提示词正文里的「中文名 ( @id )」是【标注位】，编号必须原样显示。
   * 这里换成中文名就会变成「后院月亮门（后院月亮门）」，用户看到的就是“编号又丢了”。 */
  function isAnnotation(before, after) {
    var b = String(before || '').replace(/\s+$/, '');
    var a = String(after || '').replace(/^\s+/, '');
    if (!/[（(]$/.test(b)) return false;
    return /^@?[）)]/.test(a) || /^@?[A-Za-z0-9_-]{2,60}\s*[）)]/.test(a);
  }

  function fixNode(node) {
    var el = node.parentElement;
    if (!el || el.closest('input,textarea,[contenteditable="true"]')) return;
    var raw = node.nodeValue;
    var text = String(raw || '').trim();
    if (!text || text.length > 64 || !ID_RE.test(text)) return;
    /* 括号里 = 提示词标注位，保留编号，不动 */
    if (isAnnotation(nearText(node, -1), nearText(node, 1))) return;

    /* 同一行/同一张卡片里找提示词，最多往上 10 层 */
    var box = el;
    var name = '';
    for (var i = 0; i < 10 && box; i++) {
      var t = box.innerText || '';
      if (t.length > text.length + 20) {
        name = resolveName(text, t);
        if (name) break;
      }
      box = box.parentElement;
    }
    if (!name || name === text) return;

    var pad = raw.match(/^\s*/)[0];
    var tail = raw.match(/\s*$/)[0];
    node.nodeValue = pad + name + tail;
    el.setAttribute('title', text);
    el.setAttribute('data-mj-name-from-id', text);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 && root.nodeType !== 9) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var batch = [];
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && ID_RE.test(String(n.nodeValue).trim())) batch.push(n);
    }
    for (var i = 0; i < batch.length; i++) {
      try { fixNode(batch[i]); } catch (e) { /* 单点失败不影响其它 */ }
    }
  }

  var roots = [];
  var timer = 0;
  function schedule(root) {
    if (root && root.nodeType === 1) roots.push(root);
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      var list = roots.slice(0, 30);
      roots.length = 0;
      if (!list.length) list = [document.body];
      for (var i = 0; i < list.length; i++) {
        try { scan(list[i]); } catch (e) { /* 单块失败不影响其它 */ }
      }
    }, 200);
  }

  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length && i < 40; i++) {
        var m = muts[i];
        if (m.type === 'characterData' && m.target && m.target.parentElement) {
          schedule(m.target.parentElement);
        } else if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length && j < 8; j++) {
            var n = m.addedNodes[j];
            if (n && n.nodeType === 1) schedule(n);
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  } catch (e) { /* 老内核没有 MutationObserver 就算了 */ }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { schedule(document.body); });
  } else {
    schedule(document.body);
  }

  /* 供自动化检查使用（不影响页面） */
  window.__mjAssetNameResolve = resolveName;
  window.__mjIsAnnotation = isAnnotation;
  window.__mjFix = fixNode;
})();

/* ------------------------------------------------------------------
 * 【保存后把服务端结果同步回界面内存】
 *
 * 分镜导入时前端是自己拼的资产表（只有 @role_xxx 编号、没有描述），
 * 主进程保存时会补名、补描述，但返回值过去被丢掉了 —— 页面内存里仍然是
 * 编号 + 空描述，于是「角色设置」里看到 role_guobaocai、描述空白，
 * 看起来像老的空壳 bug，其实盘上已经修好，只是没人把它同步回来。
 *
 * 这里按编号（唯一可信的匹配键）把服务端的 name / description 合并回内存：
 *   - 只在本地为空或仍是编号时才写，用户刚改的内容不会被覆盖；
 *   - 只碰 name / description，图片、音色、形态一律不动。
 * ------------------------------------------------------------------ */
(function () {
  function kid(v) { return String(v || '').trim().replace(/^@+/, '').toLowerCase(); }
  function looksId(v) { return /^@?(role|scene|prop|audio)[_-][A-Za-z0-9_-]+$/i.test(String(v || '').trim()); }
  function rowsOf(job, field) {
    var sj = (job && job.script_json) || {};
    return Array.isArray(sj[field]) ? sj[field] : [];
  }
  function indexRows(list, kind) {
    var map = {};
    for (var i = 0; i < (list || []).length; i++) {
      var it = list[i] || {};
      var keys = [it.id, it[kind + '_id'], it.tokenId, it.token_id];
      for (var j = 0; j < keys.length; j++) {
        var k = kid(keys[j]);
        if (k && !map[k]) map[k] = it;
      }
    }
    return map;
  }
  function syncOne(arr, saved, kind) {
    if (!arr || !arr.length || !saved || !saved.length) return 0;
    var map = indexRows(saved, kind);
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || typeof it !== 'object') continue;
      var k = kid(it.id || it[kind + '_id'] || it.tokenId || it.token_id);
      var s = k ? map[k] : null;
      if (!s) continue;
      var sname = String(s.name || s[kind + '_name'] || '').trim();
      var cur = String(it.name || '').trim();
      if (sname && !looksId(sname) && (!cur || looksId(cur))) {
        it.name = sname;
        var nameField = kind + '_name';
        if (nameField in it) it[nameField] = sname;
        n += 1;
      }
      if (!String(it.description || '').trim() && String(s.description || '').trim()) {
        it.description = String(s.description).trim();
        n += 1;
      }
    }
    return n;
  }
  window.__mjSyncSavedAssets = function (job, roles, scenes, props) {
    try {
      if (!job || !job.script_json) return 0;
      var n = 0;
      n += syncOne(roles, rowsOf(job, 'updated_roles'), 'role');
      n += syncOne(scenes, rowsOf(job, 'updated_scenes'), 'scene');
      n += syncOne(props, rowsOf(job, 'updated_props'), 'prop');
      return n;
    } catch (e) { return 0; }
  };
})();
