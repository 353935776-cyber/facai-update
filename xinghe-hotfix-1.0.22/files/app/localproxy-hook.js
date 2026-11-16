/* 全局请求出口统一走本地代理（星核AIGC 壳层补丁）
 *
 * 原因：原版前端有一批请求（Gemini 非流式、提示词优化、违规检测、转 H3、
 * 小说各环节等）直接用裸 fetch 打供应商域名，绕过了 window.localProxy.rewrite，
 * 于是既拿不到壳层的秘钥注入、也走不到 Gemini→OpenAI 协议翻译，一律报「无效的令牌」。
 * 这里在页面世界挂一层 fetch / XMLHttpRequest 钩子，凡是绝对 http(s) 地址都交给
 * localProxy.rewrite 判定（它自己会跳过已代理的 URL），本机回环地址一律不动。
 */
(function () {
  if (window.__MJ_PROXY_HOOK__) return;
  window.__MJ_PROXY_HOOK__ = true;

  var LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

  function rewrite(u) {
    try {
      if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return u;
      if (LOCAL.test(u)) return u;
      var lp = window.localProxy;
      if (!lp || typeof lp.rewrite !== 'function') return u;
      var out = lp.rewrite(u);
      return typeof out === 'string' && out ? out : u;
    } catch (e) {
      return u;
    }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = rewrite(input);
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          var next = rewrite(input.url);
          if (next !== input.url) {
            try { input = new Request(next, input); } catch (e) { input = next; }
          }
        }
      } catch (e) {
        /* 保底：钩子自身出错时按原样发出去 */
      }
      return origFetch.call(this, input, init);
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    var origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof url === 'string') args[1] = rewrite(url);
      } catch (e) {
        /* ignore */
      }
      return origOpen.apply(this, args);
    };
  }
})();
