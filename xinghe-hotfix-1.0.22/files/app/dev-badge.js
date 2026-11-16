/* 开发者版专属角标 + 小控制台（左下角）。
 * 只在「本机数据目录里有合法开发者标记」时由 main.cjs 注入；
 * 客户机上没有标记，这个文件即使存在于包里也不会被加载，界面完全不变。
 * 用 shadow DOM 独立挂载，不受 Vue 重渲染影响；与右下角的更新胶囊互不遮挡。
 */
(function () {
  'use strict';
  if (document.getElementById('__mj_dev_host')) return;
  var api = window.electronAPI && window.electronAPI.app;
  if (!api || typeof api.devInfo !== 'function') return;

  var C = {
    bg: 'rgba(22,20,14,.96)', border: 'rgba(232,180,90,.34)', text: '#f4ecd8',
    dim: '#b6a889', gold: '#e8b45a', goldDim: 'rgba(232,180,90,.14)',
    ok: '#7fd6a2', err: '#f08c8c',
  };
  function css(el, o) { for (var k in o) el.style[k] = o[k]; return el; }
  function mk(tag, o, txt) {
    var e = document.createElement(tag);
    if (o) css(e, o);
    if (txt != null) e.textContent = txt;
    return e;
  }
  function btn(label, fn) {
    var b = mk('button', {
      flex: '1 1 46%', minWidth: '118px', padding: '8px 9px', borderRadius: '7px',
      border: '1px solid rgba(232,180,90,.34)', background: C.goldDim,
      color: '#f0dcae', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
    }, label);
    b.onmouseenter = function () { b.style.background = 'rgba(232,180,90,.26)'; };
    b.onmouseleave = function () { b.style.background = C.goldDim; };
    b.onclick = fn;
    return b;
  }

  var host = mk('div', {
    position: 'fixed', left: '18px', bottom: '18px', zIndex: '2147483646',
    fontFamily: '-apple-system,"Microsoft YaHei",system-ui,sans-serif',
    fontSize: '13px', color: C.text, userSelect: 'none',
  });
  host.id = '__mj_dev_host';
  var root = host.attachShadow({ mode: 'open' });

  var panel = mk('div', {
    width: '306px', marginBottom: '10px', boxSizing: 'border-box',
    background: C.bg, backdropFilter: 'blur(14px)',
    border: '1px solid ' + C.border, borderRadius: '12px', padding: '14px 15px 13px',
    boxShadow: '0 14px 40px rgba(0,0,0,.5)', display: 'none',
  });
  var title = mk('div', { fontSize: '14px', fontWeight: '700', color: C.gold, marginBottom: '3px' },
    '◆ 开发者版控制台');
  var sub = mk('div', { fontSize: '11px', color: C.dim, lineHeight: '1.6', marginBottom: '10px' },
    '仅作者自用。客户包不含开发者标记，界面为正式版。');
  panel.appendChild(title); panel.appendChild(sub);

  var rows = mk('div', { lineHeight: '1.85', fontSize: '12px', color: C.dim, wordBreak: 'break-all' });
  var lineVer = mk('div'), lineChan = mk('div'), lineSrc = mk('div');
  var lineData = mk('div'), lineLast = mk('div');
  rows.appendChild(lineVer); rows.appendChild(lineChan); rows.appendChild(lineSrc);
  rows.appendChild(lineData); rows.appendChild(lineLast);
  panel.appendChild(rows);

  var grid = mk('div', { display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '12px' });
  panel.appendChild(grid);

  var result = mk('div', {
    marginTop: '10px', fontSize: '12px', lineHeight: '1.6', color: C.dim, display: 'none',
  });
  panel.appendChild(result);

  var capsule = mk('div', {
    display: 'inline-flex', alignItems: 'center', gap: '7px', cursor: 'pointer',
    padding: '7px 12px', borderRadius: '999px', background: C.bg,
    border: '1px solid ' + C.border, boxShadow: '0 6px 20px rgba(0,0,0,.42)',
    fontSize: '12px', fontWeight: '700', color: C.gold, letterSpacing: '.3px',
  });
  var dot = mk('span', {
    width: '7px', height: '7px', borderRadius: '50%', background: C.gold,
    boxShadow: '0 0 8px ' + C.gold,
  });
  var capText = mk('span', null, 'DEV 开发者版');
  capsule.appendChild(dot); capsule.appendChild(capText);
  capsule.onclick = function () {
    var open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) refresh();
  };

  root.appendChild(panel);
  root.appendChild(capsule);

  var info = null;
  function showResult(ok, msg) {
    result.style.display = 'block';
    result.style.color = ok ? C.ok : C.err;
    result.textContent = msg;
  }
  function run(p, okMsg) {
    Promise.resolve(p).then(function (r) {
      var x = (r && r.data && typeof r.data === 'object' && 'success' in r.data) ? r.data : (r || {});
      if (x.success === false || x.ok === false) showResult(false, x.error || x.message || '操作失败');
      else showResult(true, okMsg || '已执行');
    }).catch(function (e) { showResult(false, String((e && e.message) || e)); });
  }

  grid.appendChild(btn('开发者工具 (F12)', function () { run(api.devOpenTools(), '已打开开发者工具'); }));
  grid.appendChild(btn('复制诊断信息', function () {
    run(api.devCopyDiag(), '诊断信息已复制到剪贴板，可直接发我');
  }));
  grid.appendChild(btn('打开数据目录', function () { run(api.devOpenPath('data'), '已打开数据目录'); }));
  grid.appendChild(btn('打开日志目录', function () { run(api.devOpenPath('logs'), '已打开日志目录'); }));
  grid.appendChild(btn('打开程序目录', function () { run(api.devOpenPath('app'), '已打开程序目录'); }));
  grid.appendChild(btn('立即检查更新', function () {
    if (typeof api.updateCheck !== 'function') { showResult(false, '此版本没有更新接口'); return; }
    run(api.updateCheck(), '已触发检查更新');
  }));

  function refresh() {
    Promise.resolve(api.devInfo()).then(function (r) {
      var i = (r && r.data) ? r.data : (r || {});
      if (i.success === false || i.enabled === false) { host.style.display = 'none'; return; }
      info = i;
      var u = i.update || {};
      lineVer.textContent = '版本：v' + (i.displayVersion || i.version || '?') + '  ·  Electron ' + (i.electron || '?');
      lineChan.textContent = '渠道：' + (i.label || '开发者版') + '  ·  ' + (i.source || '');
      lineSrc.textContent = '更新源：' + (u.configured
        ? ((u.urls && u.urls.length ? u.urls.length + ' 个' : '已配置') + '（' + (u.source || '') + '）')
        : '未配置');
      lineData.textContent = '数据目录：' + (i.dataDir || '?');
      var h = u.hotfix;
      lineLast.textContent = '最近热更：' + (h
        ? ('v' + (h.version || h.to || '?') + ' @ ' + (h.at || h.time || ''))
        : '暂无');
      capText.textContent = 'DEV 开发者版 v' + (i.displayVersion || i.version || '');
      return null;
    }).catch(function (e) { showResult(false, String((e && e.message) || e)); });
  }

  /* 前端整块替换 body 时补挂一次 */
  var mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(function () {
    if (!document.body.contains(host)) (document.body || document.documentElement).appendChild(host);
  }) : null;
  if (mo) mo.observe(document.documentElement, { childList: true, subtree: false });

  (document.body || document.documentElement).appendChild(host);
  refresh();
})();
