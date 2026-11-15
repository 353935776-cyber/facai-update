/* 界面右下角常驻的「检查更新」入口。
 * 为什么用注入而不是改压缩后的 Vue chunk：前端是打包产物，改一处要重排整个 chunk，
 * 风险高且每次升级都可能被覆盖。这里用 shadow DOM 独立挂载，前端框架重渲染也影响不到。
 * 由 main.cjs 在 did-finish-load 时读文件后 executeJavaScript 注入。
 */
(function () {
  'use strict';
  if (document.getElementById('__mj_update_host')) return;
  var api = window.electronAPI && window.electronAPI.app;
  if (!api || typeof api.updateInfo !== 'function') return;

  var C = {
    bg: 'rgba(18,24,38,.94)', border: 'rgba(120,150,210,.28)', text: '#e8edf8',
    dim: '#93a2bd', accent: '#5b9dff', ok: '#4cc38a', warn: '#e8b45a', err: '#f07a7a',
  };
  function css(el, o) { for (var k in o) el.style[k] = o[k]; return el; }
  function mk(tag, o, txt) {
    var e = document.createElement(tag);
    if (o) css(e, o);
    if (txt != null) e.textContent = txt;
    return e;
  }

  var host = mk('div', {
    position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
    fontFamily: '-apple-system,"Microsoft YaHei",system-ui,sans-serif',
    fontSize: '13px', color: C.text, userSelect: 'none',
  });
  host.id = '__mj_update_host';
  var root = host.attachShadow({ mode: 'open' });

  var panel = mk('div', {
    width: '292px', marginBottom: '10px', background: C.bg, backdropFilter: 'blur(14px)',
    border: '1px solid ' + C.border, borderRadius: '12px', padding: '14px 15px 13px',
    boxShadow: '0 14px 40px rgba(0,0,0,.45)', display: 'none',
  });
  var title = mk('div', { fontSize: '14px', fontWeight: '600', marginBottom: '10px' }, '软件更新');
  var rows = mk('div', { lineHeight: '1.9', color: C.dim, fontSize: '12px' });
  var lineVer = mk('div');
  var lineSrc = mk('div');
  var lineLast = mk('div');
  rows.appendChild(lineVer); rows.appendChild(lineSrc); rows.appendChild(lineLast);

  var hint = mk('div', {
    marginTop: '10px', padding: '9px 10px', borderRadius: '8px', fontSize: '12px',
    lineHeight: '1.65', background: 'rgba(232,180,90,.10)', color: C.warn,
    border: '1px solid rgba(232,180,90,.25)', display: 'none',
  });
  var result = mk('div', {
    marginTop: '10px', fontSize: '12px', lineHeight: '1.6', color: C.dim, display: 'none',
  });
  var btn = mk('button', {
    width: '100%', marginTop: '12px', padding: '9px 12px', borderRadius: '8px',
    border: '1px solid rgba(91,157,255,.55)', background: 'rgba(91,157,255,.16)',
    color: '#cfe1ff', fontSize: '13px', cursor: 'pointer', fontWeight: '600',
  }, '立即检查更新');
  btn.onmouseenter = function () { btn.style.background = 'rgba(91,157,255,.28)'; };
  btn.onmouseleave = function () { btn.style.background = 'rgba(91,157,255,.16)'; };

  /* 配置更新地址：已发安装包里 url 为空，配一次即可永久在线热更 */
  var canSet = typeof api.updateSetUrl === 'function';
  var cfgSaving = false;
  var autoOpened = false;
  var cfgLink = mk('div', {
    marginTop: '10px', fontSize: '12px', color: C.accent, cursor: 'pointer',
    textAlign: 'center', display: canSet ? 'block' : 'none',
  }, '设置更新地址');
  var cfgBox = mk('div', { marginTop: '8px', display: 'none' });
  var cfgInput = document.createElement('textarea');
  css(cfgInput, {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '7px',
    border: '1px solid ' + C.border, background: 'rgba(0,0,0,.28)', color: C.text,
    fontSize: '12px', outline: 'none', resize: 'vertical', minHeight: '58px',
    fontFamily: 'inherit', lineHeight: '1.5',
  });
  cfgInput.rows = 2;
  cfgInput.placeholder = 'https://cdn.jsdelivr.net/gh/用户名/仓库@main/hotfix/latest.json';
  cfgInput.spellcheck = false;
  var cfgTip = mk('div', { marginTop: '6px', fontSize: '11px', lineHeight: '1.6', color: C.dim },
    '一行一个地址：国内镜像放第一个，GitHub 直连放后面，会自动切换。也可填本机/共享盘目录。保存后立即生效。');
  var cfgBtn = mk('button', {
    width: '100%', marginTop: '8px', padding: '7px 12px', borderRadius: '8px',
    border: '1px solid rgba(76,195,138,.5)', background: 'rgba(76,195,138,.14)',
    color: '#b9ecd2', fontSize: '12px', cursor: 'pointer', fontWeight: '600',
  }, '保存并立即检查');
  cfgBox.appendChild(cfgInput); cfgBox.appendChild(cfgTip); cfgBox.appendChild(cfgBtn);
  cfgLink.onclick = function () {
    var open = cfgBox.style.display === 'none';
    cfgBox.style.display = open ? 'block' : 'none';
    cfgLink.textContent = open ? '收起设置' : '设置更新地址';
    if (open && info) cfgInput.value = cfgText(info);
  };

  panel.appendChild(title); panel.appendChild(rows); panel.appendChild(hint);
  panel.appendChild(result); panel.appendChild(btn);
  panel.appendChild(cfgLink); panel.appendChild(cfgBox);

  var fab = mk('div', {
    display: 'flex', alignItems: 'center', gap: '7px', marginLeft: 'auto',
    width: 'fit-content', padding: '7px 13px', borderRadius: '999px',
    background: C.bg, border: '1px solid ' + C.border, cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0,0,0,.35)', fontSize: '12px', color: C.dim,
  });
  var dot = mk('span', {
    width: '7px', height: '7px', borderRadius: '50%', background: C.dim,
    display: 'inline-block',
  });
  var fabText = mk('span', null, '检查更新');
  fab.appendChild(dot); fab.appendChild(fabText);
  fab.onmouseenter = function () { fab.style.borderColor = 'rgba(120,150,210,.6)'; };
  fab.onmouseleave = function () { fab.style.borderColor = C.border; };

  root.appendChild(panel); root.appendChild(fab);
  (document.body || document.documentElement).appendChild(host);

  var info = null;
  var busy = false;
  function setDot(color) { dot.style.background = color; }
  function cfgText(i) {
    return (i && i.urls && i.urls.length) ? i.urls.join('\n') : String((i && i.url) || '');
  }

  function refresh() {
    return Promise.resolve(api.updateInfo()).then(function (r) {
      info = (r && r.data) ? r.data : (r || {});
      var v = info.version || '—';
      lineVer.textContent = '当前版本：v' + v;
      fabText.textContent = '更新  v' + v;
      if (info.configured) {
        var src = { env: '环境变量', userData: '本机配置', bundle: '随包配置', builtin: '内置地址' }[info.source] || info.source || '已配置';
        lineSrc.textContent = '更新源：' + src +
          (info.urls && info.urls.length > 1 ? '（' + info.urls.length + ' 个，自动切换）' : '');
        setDot(C.ok);
        hint.style.display = 'none';
        hint.textContent = '';
        btn.disabled = false;
        btn.style.opacity = '1';
      } else {
        lineSrc.textContent = '更新源：未配置';
        setDot(C.warn);
        hint.textContent = canSet
          ? '还没有配置更新地址，不会自动检查新版。在下方填一次地址即可，之后升级都不用再发安装包。'
          : '还没有配置更新地址，所以不会自动检查新版。这不影响正常使用；需要在线更新时联系作者配置一次即可。';
        hint.style.display = 'block';
      }
      if (canSet) {
        if (cfgBox.style.display === 'none') cfgInput.value = cfgText(info);
        if (!info.configured && !autoOpened) {
          autoOpened = true;
          cfgBox.style.display = 'block';
          cfgLink.textContent = '收起设置';
        }
      }
      var h = info.hotfix;
      if (h && h.appliedAt) {
        var d = String(h.appliedAt).replace('T', ' ').slice(0, 16);
        lineLast.textContent = '最近更新：' + d + (h.rolledBack ? '（已回滚）' : '');
      } else {
        lineLast.textContent = '最近更新：无（当前为安装包版本）';
      }
      return info;
    }).catch(function (e) {
      lineSrc.textContent = '状态读取失败：' + ((e && e.message) || e);
      setDot(C.err);
      return {};
    });
  }

  function showResult(ok, text) {
    result.style.display = 'block';
    result.style.color = ok ? C.ok : C.err;
    result.textContent = text;
  }

  fab.onclick = function () {
    var open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) refresh();
  };

  btn.onclick = function () {
    if (busy) return;
    if (!info || !info.configured) {
      showResult(false, '未配置更新地址，暂不能在线检查。');
      return;
    }
    busy = true;
    btn.textContent = '正在检查…';
    btn.disabled = true;
    btn.style.opacity = '.65';
    result.style.display = 'none';
    Promise.resolve(api.updateCheck()).then(function (r) {
      var x = (r && r.data) ? r.data : (r || {});
      if (x.ok && x.upToDate) showResult(true, '已是最新版本 v' + (x.version || info.version));
      else if (x.ok && x.skipped) showResult(true, '已选择稍后更新');
      else if (x.ok && (x.applied || x.restarted)) showResult(true, '已更新到 v' + (x.version || '') + '，即将重启');
      else if (x.ok) showResult(true, x.message || '检查完成');
      else showResult(false, x.message || '检查失败，请稍后重试');
    }).catch(function (e) {
      showResult(false, '检查失败：' + ((e && e.message) || e));
    }).then(function () {
      busy = false;
      btn.textContent = '立即检查更新';
      btn.disabled = false;
      btn.style.opacity = '1';
      refresh();
    });
  };

  cfgBtn.onclick = function () {
    if (!canSet || cfgSaving) return;
    cfgSaving = true;
    cfgBtn.textContent = '正在保存…';
    cfgBtn.disabled = true;
    Promise.resolve(api.updateSetUrl(cfgInput.value)).then(function (r) {
      var x = (r && r.data) ? r.data : (r || {});
      if (!x.ok) { showResult(false, x.message || '保存失败'); return null; }
      showResult(true, '更新地址已保存，正在检查…');
      return refresh();
    }).then(function (i) {
      if (!i || !i.configured) return null;
      return api.updateCheck();
    }).then(function (r) {
      if (!r) return;
      var x = (r && r.data) ? r.data : (r || {});
      if (x.ok && x.upToDate) showResult(true, '已连接更新源，当前已是最新版本 v' + (x.version || ''));
      else if (x.ok && (x.applied || x.restarted)) showResult(true, '已更新到 v' + (x.version || '') + '，即将重启');
      else if (x.ok) showResult(true, x.message || '检查完成');
      else showResult(false, x.message || '检查失败，请检查地址是否正确');
    }).catch(function (e) {
      showResult(false, '保存失败：' + ((e && e.message) || e));
    }).then(function () {
      cfgSaving = false;
      cfgBtn.textContent = '保存并立即检查';
      cfgBtn.disabled = false;
    });
  };

  /* SPA 路由切换不会重新加载文档，但若前端整块替换了 body，这里补挂一次 */
  var mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(function () {
    if (!document.body.contains(host)) (document.body || document.documentElement).appendChild(host);
  }) : null;
  if (mo) mo.observe(document.documentElement, { childList: true, subtree: false });

  refresh();
})();
