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

  function fixNode(node) {
    var el = node.parentElement;
    if (!el || el.closest('input,textarea,[contenteditable="true"]')) return;
    var raw = node.nodeValue;
    var text = String(raw || '').trim();
    if (!text || text.length > 64 || !ID_RE.test(text)) return;

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
})();
