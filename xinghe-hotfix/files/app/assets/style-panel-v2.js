/* ===== 注入：风格选择面板增强 V2（风格设置 + 新增作品） ===== */
/* ===== 风格选择面板增强 V2：题材分组折叠 + 搜索 + 画风筛选（只改展示，不动数据） =====
 * 同时接管两个弹窗：
 *   1) 漫剧制作页「风格设置」      .dialog-card.create-style-card → .style-list-field
 *   2) 作品列表「新增作品」风格选择 .dialog-card.create-dialog-card → .style-field
 */
(function () {
  if (window.__MJX_STYLE_PANEL_V2__) return;
  window.__MJX_STYLE_PANEL_V2__ = true;

  var MAP = {"国漫仙侠漫剧3D风格":"legacy",
  "国漫都市漫剧3D风格":"legacy",
  "国漫仙侠漫剧2D风格":"legacy",
  "国风水墨漫剧风格":"legacy",
  "古装权谋漫剧风格":"legacy",
  "都市情感漫剧风格":"legacy",
  "武侠江湖3D风格":"legacy",
  "科幻赛博3D风格":"legacy",
  "西方奇幻3D风格":"legacy",
  "Q版萌系漫剧风格":"legacy",
  "电影写实漫剧风格":"legacy",
  "悬疑惊悚漫剧风格":"legacy",
  "皮克斯3D漫剧风格":"legacy",
  "古风Q版漫剧风格":"legacy",
  "真人古代风格":"legacy",
  "现代真人风格":"legacy",
  "【真人】都市生活电影风":"city",
  "【2D漫剧】都市生活电影风":"city",
  "【真人】豪门轻奢甜宠风":"city",
  "【2D漫剧】豪门轻奢甜宠风":"city",
  "【真人】职场商战冷峻风":"city",
  "【2D漫剧】职场商战冷峻风":"city",
  "【真人】娱乐圈时尚风":"city",
  "【2D漫剧】娱乐圈时尚风":"city",
  "【真人】都市逆袭爽感风":"city",
  "【2D漫剧】都市逆袭爽感风":"city",
  "【真人】都市神医鉴宝风":"city",
  "【2D漫剧】都市神医鉴宝风":"city",
  "【真人】都市硬派动作风":"city",
  "【2D漫剧】都市硬派动作风":"city",
  "【真人】清透校园青春风":"school",
  "【2D漫剧】清透校园青春风":"school",
  "【真人】大学校园文艺风":"school",
  "【2D漫剧】大学校园文艺风":"school",
  "【真人】校园轻喜剧风":"school",
  "【2D漫剧】校园轻喜剧风":"school",
  "【真人】校园悬疑异能风":"school",
  "【2D漫剧】校园悬疑异能风":"school",
  "【真人】家庭生活写实风":"family",
  "【2D漫剧】家庭生活写实风":"family",
  "【真人】先婚后爱温柔风":"family",
  "【2D漫剧】先婚后爱温柔风":"family",
  "【真人】女性成长冷暖风":"family",
  "【2D漫剧】女性成长冷暖风":"family",
  "【真人】萌宝亲子治愈风":"family",
  "【2D漫剧】萌宝亲子治愈风":"family",
  "【真人】田园生活治愈风":"rural",
  "【2D漫剧】田园生活治愈风":"rural",
  "【真人】乡村创业现实风":"rural",
  "【2D漫剧】乡村创业现实风":"rural",
  "【真人】乡村民俗纪实风":"rural",
  "【2D漫剧】乡村民俗纪实风":"rural",
  "【真人】清雅古偶甜宠风":"romance",
  "【2D漫剧】清雅古偶甜宠风":"romance",
  "【真人】宫廷浓颜爱情风":"romance",
  "【2D漫剧】宫廷浓颜爱情风":"romance",
  "【真人】宅院细腻情感风":"romance",
  "【2D漫剧】宅院细腻情感风":"romance",
  "【真人】江湖唯美爱情风":"romance",
  "【2D漫剧】江湖唯美爱情风":"romance",
  "【真人】宫廷宅斗暗金风":"court",
  "【2D漫剧】宫廷宅斗暗金风":"court",
  "【真人】世家宅斗雅冷风":"court",
  "【2D漫剧】世家宅斗雅冷风":"court",
  "【真人】朝堂历史厚重风":"history",
  "【3D漫剧】朝堂历史厚重风":"history",
  "【真人】乱世战争史诗风":"history",
  "【3D漫剧】乱世战争史诗风":"history",
  "【真人】古代市井经营风":"history",
  "【2D漫剧】古代市井经营风":"history",
  "【真人】古装探案悬疑风":"history",
  "【2D漫剧】古装探案悬疑风":"history",
  "【真人】写实硬派武侠风":"wuxia",
  "【2D漫剧】写实硬派武侠风":"wuxia",
  "【真人】水墨诗意武侠风":"wuxia",
  "【2D漫剧】水墨诗意武侠风":"wuxia",
  "【真人】玄幻热血三维风":"fantasy",
  "【3D漫剧】玄幻热血三维风":"fantasy",
  "【真人】修仙清冷仙气风":"fantasy",
  "【3D漫剧】修仙清冷仙气风":"fantasy",
  "【真人】暗黑修仙魔道风":"fantasy",
  "【3D漫剧】暗黑修仙魔道风":"fantasy",
  "【真人】东方神话重彩风":"fantasy",
  "【2D漫剧】东方神话重彩风":"fantasy",
  "【真人】都市异能觉醒风":"power",
  "【2D漫剧】都市异能觉醒风":"power",
  "【真人】民俗灵异悬疑风":"horror",
  "【2D漫剧】民俗灵异悬疑风":"horror",
  "【真人】规则怪谈冷调风":"horror",
  "【2D漫剧】规则怪谈冷调风":"horror",
  "【真人】中式诡异美学风":"horror",
  "【2D漫剧】中式诡异美学风":"horror",
  "【真人】末世废土求生风":"apocalypse",
  "【3D漫剧】末世废土求生风":"apocalypse",
  "【真人】未来科幻机甲风":"scifi",
  "【3D漫剧】未来科幻机甲风":"scifi",
  "【真人】年代重生烟火风":"era",
  "【2D漫剧】年代重生烟火风":"era",
  "【3D漫剧】都市生活电影风":"city",
  "【3D漫剧】豪门轻奢甜宠风":"city",
  "【3D漫剧】职场商战冷峻风":"city",
  "【3D漫剧】娱乐圈时尚风":"city",
  "【3D漫剧】都市逆袭爽感风":"city",
  "【3D漫剧】都市神医鉴宝风":"city",
  "【3D漫剧】都市硬派动作风":"city",
  "【3D漫剧】清透校园青春风":"school",
  "【3D漫剧】大学校园文艺风":"school",
  "【3D漫剧】校园轻喜剧风":"school",
  "【3D漫剧】校园悬疑异能风":"school",
  "【3D漫剧】家庭生活写实风":"family",
  "【3D漫剧】先婚后爱温柔风":"family",
  "【3D漫剧】女性成长冷暖风":"family",
  "【3D漫剧】萌宝亲子治愈风":"family",
  "【3D漫剧】田园生活治愈风":"rural",
  "【3D漫剧】乡村创业现实风":"rural",
  "【3D漫剧】乡村民俗纪实风":"rural",
  "【3D漫剧】清雅古偶甜宠风":"romance",
  "【3D漫剧】宫廷浓颜爱情风":"romance",
  "【3D漫剧】宅院细腻情感风":"romance",
  "【3D漫剧】江湖唯美爱情风":"romance",
  "【3D漫剧】宫廷宅斗暗金风":"court",
  "【3D漫剧】世家宅斗雅冷风":"court",
  "【2D漫剧】朝堂历史厚重风":"history",
  "【2D漫剧】乱世战争史诗风":"history",
  "【3D漫剧】古代市井经营风":"history",
  "【3D漫剧】古装探案悬疑风":"history",
  "【3D漫剧】写实硬派武侠风":"wuxia",
  "【3D漫剧】水墨诗意武侠风":"wuxia",
  "【2D漫剧】玄幻热血风":"fantasy",
  "【2D漫剧】修仙清冷仙气风":"fantasy",
  "【2D漫剧】暗黑修仙魔道风":"fantasy",
  "【3D漫剧】东方神话重彩风":"fantasy",
  "【3D漫剧】都市异能觉醒风":"power",
  "【3D漫剧】民俗灵异悬疑风":"horror",
  "【3D漫剧】规则怪谈冷调风":"horror",
  "【3D漫剧】中式诡异美学风":"horror",
  "【2D漫剧】末世废土求生风":"apocalypse",
  "【2D漫剧】未来科幻机甲风":"scifi",
  "【3D漫剧】年代重生烟火风":"era",
  "【真人】韩国·都市浪漫韩剧风":"intl:kr",
  "【2D漫剧】韩国·都市浪漫韩剧风":"intl:kr",
  "【3D漫剧】韩国·都市浪漫韩剧风":"intl:kr",
  "【真人】韩国·财阀职场冷奢风":"intl:kr",
  "【2D漫剧】韩国·财阀职场冷奢风":"intl:kr",
  "【3D漫剧】韩国·财阀职场冷奢风":"intl:kr",
  "【真人】韩国·都市犯罪悬疑风":"intl:kr",
  "【2D漫剧】韩国·都市犯罪悬疑风":"intl:kr",
  "【3D漫剧】韩国·都市犯罪悬疑风":"intl:kr",
  "【真人】日本·清透青春日漫风":"intl:jp",
  "【2D漫剧】日本·清透青春日漫风":"intl:jp",
  "【3D漫剧】日本·清透青春日漫风":"intl:jp",
  "【真人】日本·生活治愈日剧风":"intl:jp",
  "【2D漫剧】日本·生活治愈日剧风":"intl:jp",
  "【3D漫剧】日本·生活治愈日剧风":"intl:jp",
  "【真人】日本·热血战斗番风":"intl:jp",
  "【2D漫剧】日本·热血战斗番风":"intl:jp",
  "【3D漫剧】日本·热血战斗番风":"intl:jp",
  "【真人】美国·商业电影都市风":"intl:us",
  "【2D漫剧】美国·商业电影都市风":"intl:us",
  "【3D漫剧】美国·商业电影都市风":"intl:us",
  "【真人】美国·合家欢卡通电影风":"intl:us",
  "【2D漫剧】美国·合家欢卡通电影风":"intl:us",
  "【3D漫剧】美国·合家欢卡通电影风":"intl:us",
  "【真人】美国·超级英雄漫画电影风":"intl:us",
  "【2D漫剧】美国·超级英雄漫画电影风":"intl:us",
  "【3D漫剧】美国·超级英雄漫画电影风":"intl:us",
  "【真人】西班牙·都市浓彩情感风":"intl:es",
  "【2D漫剧】西班牙·都市浓彩情感风":"intl:es",
  "【3D漫剧】西班牙·都市浓彩情感风":"intl:es",
  "【真人】西班牙·都市悬疑惊悚风":"intl:es",
  "【2D漫剧】西班牙·都市悬疑惊悚风":"intl:es",
  "【3D漫剧】西班牙·都市悬疑惊悚风":"intl:es",
  "【真人】西班牙·地中海暖阳田园风":"intl:es",
  "【2D漫剧】西班牙·地中海暖阳田园风":"intl:es",
  "【3D漫剧】西班牙·地中海暖阳田园风":"intl:es",
  "【真人】法国·都市文艺电影风":"intl:fr",
  "【2D漫剧】法国·都市文艺电影风":"intl:fr",
  "【3D漫剧】法国·都市文艺电影风":"intl:fr",
  "【真人】法国·手绘童话田园风":"intl:fr",
  "【2D漫剧】法国·手绘童话田园风":"intl:fr",
  "【3D漫剧】法国·手绘童话田园风":"intl:fr",
  "【真人】英国·年代庄园典雅风":"intl:gb",
  "【2D漫剧】英国·年代庄园典雅风":"intl:gb",
  "【3D漫剧】英国·年代庄园典雅风":"intl:gb",
  "【真人】英国·冷峻侦探悬疑风":"intl:gb",
  "【2D漫剧】英国·冷峻侦探悬疑风":"intl:gb",
  "【3D漫剧】英国·冷峻侦探悬疑风":"intl:gb",
  "【真人】意大利·暖色生活电影风":"intl:it",
  "【2D漫剧】意大利·暖色生活电影风":"intl:it",
  "【3D漫剧】意大利·暖色生活电影风":"intl:it",
  "【真人】意大利·时装都市优雅风":"intl:it",
  "【2D漫剧】意大利·时装都市优雅风":"intl:it",
  "【3D漫剧】意大利·时装都市优雅风":"intl:it",
  "【真人】泰国·明亮青春校园风":"intl:th",
  "【2D漫剧】泰国·明亮青春校园风":"intl:th",
  "【3D漫剧】泰国·明亮青春校园风":"intl:th",
  "【真人】泰国·热带民俗悬疑风":"intl:th",
  "【2D漫剧】泰国·热带民俗悬疑风":"intl:th",
  "【3D漫剧】泰国·热带民俗悬疑风":"intl:th"};

  var THEMES = [["city", "都市生活"], ["school", "校园青春"], ["family", "家庭情感"], ["rural", "乡村田园"],
    ["romance", "古装爱情"], ["court", "宫廷宅斗"], ["history", "历史朝堂"], ["wuxia", "武侠江湖"],
    ["fantasy", "玄幻修仙"], ["power", "异能热血"], ["horror", "悬疑灵异"], ["apocalypse", "末世废土"],
    ["scifi", "科幻未来"], ["era", "年代怀旧"]];
  var COUNTRIES = [["kr", "海外 · 韩国"], ["jp", "海外 · 日本"], ["us", "海外 · 美国"], ["es", "海外 · 西班牙"],
    ["fr", "海外 · 法国"], ["gb", "海外 · 英国"], ["it", "海外 · 意大利"], ["th", "海外 · 泰国"]];

  var GROUP_LABEL = {}, GROUP_ORDER = [];
  THEMES.forEach(function (p) { GROUP_LABEL[p[0]] = p[1]; GROUP_ORDER.push(p[0]); });
  COUNTRIES.forEach(function (p) { GROUP_LABEL["intl:" + p[0]] = p[1]; GROUP_ORDER.push("intl:" + p[0]); });
  GROUP_LABEL.legacy = "经典内置"; GROUP_ORDER.push("legacy");
  GROUP_LABEL.custom = "其他 / 自定义"; GROUP_ORDER.push("custom");

  var KIND_LABEL = { live: "真人", "2d": "2D", "3d": "3D", other: "通用" };
  var KIND_ORDER = { live: 0, "2d": 1, "3d": 2, other: 3 };
  var KIND_BADGE = { live: "sx-b-live", "2d": "sx-b-2d", "3d": "sx-b-3d", other: "sx-b-other" };

  var LS_KEY = "mjx.stylePanel.v2";
  function loadState(key) {
    var st = { q: "", chip: "all", open: {} };
    try {
      var raw0 = window.localStorage.getItem(LS_KEY + "." + key);
      if (raw0) {
        var o0 = JSON.parse(raw0);
        if (o0 && typeof o0 === "object") {
          st.chip = o0.chip || "all";
          st.open = o0.open && typeof o0.open === "object" ? o0.open : {};
        }
      }
    } catch (e) { }
    return st;
  }
  function saveState(key, st) {
    try { window.localStorage.setItem(LS_KEY + "." + key, JSON.stringify({ chip: st.chip, open: st.open })); } catch (e) { }
  }

  var CSS = [
    ".sx-wrap{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}",
    ".sx-wrap.sx-scroll{max-height:min(58vh,520px);overflow-y:auto;overflow-x:hidden;padding-right:4px;overscroll-behavior:contain}",
    ".sx-bar{position:sticky;top:0;z-index:6;display:flex;flex-direction:column;gap:7px;padding:5px 0 9px;background:var(--bg-card);border-bottom:1px solid color-mix(in srgb,var(--text-secondary) 16%,transparent);box-shadow:0 8px 14px -12px rgba(0,0,0,.6)}",
    ".sx-row{display:flex;align-items:center;gap:8px;min-width:0}",
    ".sx-searchbox{position:relative;flex:1 1 auto;min-width:0}",
    ".sx-q{width:100%;box-sizing:border-box;height:32px;border-radius:9px;border:1px solid color-mix(in srgb,var(--text-secondary) 26%,transparent);background:var(--bg-secondary);color:var(--text-primary);padding:0 26px 0 11px;font-size:12.5px;outline:none;font-family:inherit}",
    ".sx-q::placeholder{color:color-mix(in srgb,var(--text-secondary) 76%,transparent)}",
    ".sx-q:focus{border-color:color-mix(in srgb,var(--neon-blue) 62%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--neon-blue) 18%,transparent)}",
    ".sx-clear{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:20px;height:20px;line-height:17px;border:none;background:transparent;color:var(--text-secondary);font-size:15px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .15s;padding:0}",
    ".sx-searchbox.has-q .sx-clear{opacity:.75;pointer-events:auto}",
    ".sx-clear:hover{opacity:1}",
    ".sx-chips{display:flex;gap:5px;flex-wrap:wrap;min-width:0}",
    ".sx-chip{height:26px;padding:0 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--text-secondary) 26%,transparent);background:transparent;color:var(--text-secondary);font-size:11.5px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .15s;font-family:inherit;white-space:nowrap}",
    ".sx-chip:hover{color:var(--text-primary);border-color:color-mix(in srgb,var(--text-secondary) 48%,transparent)}",
    ".sx-chip.on{background:color-mix(in srgb,var(--neon-blue) 16%,transparent);border-color:color-mix(in srgb,var(--neon-blue) 58%,transparent);color:var(--text-primary)}",
    ".sx-chip b{font-weight:500;opacity:.62;font-size:10.5px}",
    ".sx-mini{height:26px;padding:0 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--text-secondary) 26%,transparent);background:transparent;color:var(--text-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap;font-family:inherit;flex:0 0 auto}",
    ".sx-mini:hover{color:var(--text-primary);border-color:var(--accent)}",
    ".sx-info{font-size:11.5px;color:var(--text-secondary);display:flex;gap:5px;align-items:center;flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
    ".sx-info b{color:var(--text-primary);font-weight:600}",
    ".sx-groups{display:flex;flex-direction:column;gap:6px;padding-bottom:4px}",
    ".sx-group{min-width:0}",
    ".sx-ghead{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:9px;border:1px solid color-mix(in srgb,var(--text-secondary) 18%,transparent);background:color-mix(in srgb,var(--text-secondary) 7%,transparent);color:var(--text-primary);font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;text-align:left;transition:background .15s}",
    ".sx-ghead:hover{background:color-mix(in srgb,var(--text-secondary) 14%,transparent)}",
    ".sx-caret{width:0;height:0;border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;color:var(--text-secondary);transition:transform .18s ease;flex:0 0 auto;margin-right:1px}",
    ".sx-group.open .sx-caret{transform:rotate(90deg)}",
    ".sx-gname{flex:0 0 auto}",
    ".sx-gcount{font-weight:400;font-size:10.5px;color:var(--text-secondary);background:color-mix(in srgb,var(--text-secondary) 14%,transparent);border-radius:999px;padding:1px 6px;flex:0 0 auto}",
    ".sx-gmix{margin-left:auto;font-weight:400;font-size:10.5px;color:var(--text-secondary);opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".sx-gbody{display:none;padding:8px 1px 2px}",
    ".sx-group.open .sx-gbody{display:block}",
    ".sx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}",
    ".sx-wrap.sx-wrap .sx-grid .style-item{position:relative;display:block;min-height:0;height:auto;width:100%;padding:8px 10px 10px;border-radius:10px;text-align:left;justify-items:stretch;align-content:start;box-sizing:border-box}",
    ".sx-wrap.sx-wrap .sx-grid .style-item:hover{border-color:color-mix(in srgb,var(--neon-blue) 42%,transparent);background:color-mix(in srgb,var(--neon-blue) 6%,var(--bg-secondary))}",
    ".sx-wrap.sx-wrap .sx-grid .style-avatar{display:none}",
    ".sx-wrap.sx-wrap .sx-grid .style-name{font-size:12.5px;line-height:1.4;font-weight:600;padding-right:40px;overflow-wrap:anywhere;color:var(--text-primary);text-align:left}",
    ".sx-wrap.sx-wrap .sx-grid .style-desc{margin-top:3px;font-size:11px;line-height:1.5;max-height:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;text-align:left;color:color-mix(in srgb,var(--text-secondary) 94%,transparent)}",
    ".sx-badge{position:absolute;top:8px;right:8px;font-size:9.5px;line-height:1;padding:3px 5px;border-radius:5px;font-weight:600;letter-spacing:.02em;white-space:nowrap}",
    ".sx-b-live{background:color-mix(in srgb,var(--neon-blue) 20%,transparent);color:color-mix(in srgb,var(--neon-blue) 88%,#fff)}",
    ".sx-b-2d{background:color-mix(in srgb,var(--neon-purple) 22%,transparent);color:color-mix(in srgb,var(--neon-purple) 80%,#fff)}",
    ".sx-b-3d{background:rgba(255,168,64,.18);color:#ffbb6b}",
    ".sx-b-other{background:color-mix(in srgb,var(--text-secondary) 18%,transparent);color:var(--text-secondary)}",
    ".sx-wrap.sx-wrap .sx-grid .style-item.active{background:color-mix(in srgb,var(--neon-blue) 9%,var(--bg-secondary));border-color:color-mix(in srgb,var(--neon-blue) 72%,transparent);box-shadow:0 0 10px color-mix(in srgb,var(--neon-blue) 20%,transparent)}",
    ".sx-wrap.sx-wrap .sx-grid .style-item.active::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,var(--neon-blue),var(--neon-purple))}",
    ".sx-wrap.sx-wrap .sx-grid .style-item.active .sx-badge{background:color-mix(in srgb,var(--neon-blue) 34%,transparent);color:#fff}",
    ".sx-none{padding:26px 10px;text-align:center;color:var(--text-secondary);font-size:12.5px;line-height:1.7}",
    ".sx-hide{display:none !important}"
  ].join("\n");

  if (!document.getElementById("sx-style-panel-css")) {
    var st = document.createElement("style");
    st.id = "sx-style-panel-css";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function parseItem(el) {
    var nameEl = el.querySelector(".style-name");
    var descEl = el.querySelector(".style-desc");
    var raw = norm(nameEl ? nameEl.textContent : "");
    var desc = norm(descEl ? descEl.textContent : "");
    var tag = "", title = raw;
    var m = /^【([^】]{1,12})】\s*([\s\S]*)$/.exec(raw);
    if (m) { tag = m[1]; title = norm(m[2]) || raw; }
    var kind = "other";
    if (/真人/.test(tag)) kind = "live";
    else if (/3D/i.test(tag)) kind = "3d";
    else if (/2D/i.test(tag)) kind = "2d";
    else if (!tag) {
      if (/真人/.test(raw)) kind = "live";
      else if (/3D/i.test(raw)) kind = "3d";
      else if (/2D|Q版/i.test(raw)) kind = "2d";
    }
    var gid = MAP[raw] || guessGroup(raw);
    return {
      el: el, raw: raw, title: title, desc: desc, kind: kind, gid: gid,
      hay: (raw + " " + desc).toLowerCase()
    };
  }

  function guessGroup(raw) {
    if (/韩国/.test(raw)) return "intl:kr";
    if (/日本/.test(raw)) return "intl:jp";
    if (/美国/.test(raw)) return "intl:us";
    if (/西班牙/.test(raw)) return "intl:es";
    if (/法国/.test(raw)) return "intl:fr";
    if (/英国/.test(raw)) return "intl:gb";
    if (/意大利/.test(raw)) return "intl:it";
    if (/泰国/.test(raw)) return "intl:th";
    if (/都市|豪门|职场|娱乐圈|逆袭|神医/.test(raw)) return "city";
    if (/校园|青春/.test(raw)) return "school";
    if (/家庭|婚后|女性成长|萌宝|亲子/.test(raw)) return "family";
    if (/田园|乡村/.test(raw)) return "rural";
    if (/古偶|宫廷浓颜|宅院|江湖唯美/.test(raw)) return "romance";
    if (/宅斗/.test(raw)) return "court";
    if (/朝堂|历史|乱世|市井|探案/.test(raw)) return "history";
    if (/武侠/.test(raw)) return "wuxia";
    if (/玄幻|修仙|神话|魔道|仙侠|国潮/.test(raw)) return "fantasy";
    if (/异能/.test(raw)) return "power";
    if (/悬疑|灵异|怪谈|诡异/.test(raw)) return "horror";
    if (/末世|废土/.test(raw)) return "apocalypse";
    if (/科幻|机甲/.test(raw)) return "scifi";
    if (/年代/.test(raw)) return "era";
    return "custom";
  }

  function mixText(items) {
    var c = {};
    items.forEach(function (it) { c[it.kind] = (c[it.kind] || 0) + 1; });
    var parts = [];
    ["live", "2d", "3d", "other"].forEach(function (k) {
      if (c[k]) parts.push(KIND_LABEL[k] + " " + c[k]);
    });
    return parts.join(" · ");
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function install(cfg) {
    var panel = null;
    var ctx = null;
    var state = loadState(cfg.key);
    function save() { saveState(cfg.key, state); }

    function refreshInfo() {
      if (!ctx) return;
      var a = ctx.wrap.querySelector(".style-item.active");
      var name = "";
      if (a) {
        var n = a.querySelector(".style-name");
        name = norm(n ? n.textContent : "");
      }
      var filtered = !!norm(state.q) || (state.chip && state.chip !== "all");
      var total = filtered ? (ctx.shown || 0) : ctx.items.length;
      var tail = filtered ? "匹配 " + total + " 个" : "共 " + total + " 个";
      ctx.info.innerHTML = name
        ? "当前：<b>" + escapeHtml(name) + "</b>　·　" + tail
        : "尚未选择　·　" + tail + "风格";
    }

    function syncToggle() {
      if (!ctx) return;
      var allOpen = ctx.order.every(function (g) { return !!state.open[g]; });
      ctx.toggleEl.textContent = allOpen ? "全部收起" : "全部展开";
    }

    function resetScroll() {
      if (!ctx) return;
      var sc = cfg.scroll === "wrap" ? ctx.wrap : ctx.field;
      if (sc) sc.scrollTop = 0;
    }

    function apply() {
      if (!ctx) return;
      var q = norm(state.q).toLowerCase();
      var chip = state.chip || "all";
      var shownAll = 0;
      ctx.order.forEach(function (g) {
        var rec = ctx.groups[g];
        var shown = 0, kinds = {};
        rec.items.forEach(function (it) {
          var ok = (chip === "all" || it.kind === chip) && (!q || it.hay.indexOf(q) >= 0);
          it.el.classList.toggle("sx-hide", !ok);
          if (ok) { shown++; kinds[it.kind] = (kinds[it.kind] || 0) + 1; }
        });
        rec.countEl.textContent = shown;
        rec.section.style.display = shown ? "" : "none";
        if (shown) {
          var parts = [];
          ["live", "2d", "3d", "other"].forEach(function (k) { if (kinds[k]) parts.push(KIND_LABEL[k] + " " + kinds[k]); });
          rec.mixEl.textContent = parts.join(" · ");
        }
        var open = q ? shown > 0 : !!state.open[g];
        rec.section.classList.toggle("open", open);
        shownAll += shown;
      });
      ctx.none.style.display = shownAll ? "none" : "";
      ctx.shown = shownAll;
      refreshInfo();
      syncToggle();
    }

    function build(card, field, grid) {
      var nodes = Array.prototype.slice.call(grid.children || []).filter(function (n) {
        return n && n.classList && n.classList.contains("style-item");
      });
      if (!nodes.length) return;

      var items = nodes.map(parseItem);

      var buckets = {};
      items.forEach(function (it) { (buckets[it.gid] || (buckets[it.gid] = [])).push(it); });
      var order = GROUP_ORDER.filter(function (g) { return buckets[g] && buckets[g].length; });
      Object.keys(buckets).forEach(function (g) { if (order.indexOf(g) < 0) order.push(g); });

      /* 组内排序：同一题材下 真人 → 2D → 3D 相邻，方便横向对比 */
      order.forEach(function (g) {
        buckets[g].sort(function (a, b) {
          var t = a.title.localeCompare(b.title, "zh-Hans-CN");
          if (t) return t;
          var k = (KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0);
          if (k) return k;
          return a.raw.localeCompare(b.raw, "zh-Hans-CN");
        });
      });

      var wrap = document.createElement("div");
      wrap.className = "sx-wrap" + (cfg.scroll === "wrap" ? " sx-scroll" : "");

      var bar = document.createElement("div");
      bar.className = "sx-bar";
      bar.innerHTML =
        '<div class="sx-row"><div class="sx-searchbox"><input class="sx-q" type="text" placeholder="搜索风格名称 / 描述…" autocomplete="off" spellcheck="false"><button class="sx-clear" type="button" title="清空">×</button></div><button class="sx-mini" type="button" data-act="toggle">全部展开</button></div>' +
        '<div class="sx-row"><div class="sx-chips"></div><div class="sx-info"></div></div>';

      var groupsEl = document.createElement("div");
      groupsEl.className = "sx-groups";

      var noneEl = document.createElement("div");
      noneEl.className = "sx-none";
      noneEl.textContent = "没有匹配的风格，换个关键词或点「全部」试试。";
      noneEl.style.display = "none";

      var groupMap = {};
      order.forEach(function (g) {
        var sec = document.createElement("section");
        sec.className = "sx-group";
        sec.setAttribute("data-gid", g);

        var head = document.createElement("button");
        head.type = "button";
        head.className = "sx-ghead";
        var caret = document.createElement("span"); caret.className = "sx-caret"; caret.textContent = "▶";
        var nm = document.createElement("span"); nm.className = "sx-gname"; nm.textContent = GROUP_LABEL[g] || g;
        var cnt = document.createElement("span"); cnt.className = "sx-gcount";
        var mix = document.createElement("span"); mix.className = "sx-gmix";
        mix.textContent = mixText(buckets[g]);
        head.appendChild(caret); head.appendChild(nm); head.appendChild(cnt); head.appendChild(mix);

        var body = document.createElement("div");
        body.className = "sx-gbody";
        var g2 = document.createElement("div");
        g2.className = "sx-grid";
        body.appendChild(g2);

        sec.appendChild(head);
        sec.appendChild(body);
        groupsEl.appendChild(sec);

        var rec = { id: g, section: sec, body: body, grid: g2, countEl: cnt, mixEl: mix, items: buckets[g] };
        buckets[g].forEach(function (it) {
          var badge = document.createElement("span");
          badge.className = "sx-badge " + (KIND_BADGE[it.kind] || "sx-b-other");
          badge.textContent = KIND_LABEL[it.kind] || "通用";
          it.el.appendChild(badge);
          it.el.setAttribute("title", it.raw + "\n\n" + it.desc);
          var nEl = it.el.querySelector(".style-name");
          if (nEl && it.title && it.title !== it.raw) nEl.textContent = it.title;
          g2.appendChild(it.el);
        });
        groupMap[g] = rec;
      });

      wrap.appendChild(bar);
      wrap.appendChild(groupsEl);
      wrap.appendChild(noneEl);

      grid.style.display = "none";
      field.insertBefore(wrap, grid);

      panel = wrap;
      ctx = {
        field: field, grid: grid, wrap: wrap, groups: groupMap, order: order, items: items,
        info: bar.querySelector(".sx-info"), none: noneEl, bar: bar,
        qEl: bar.querySelector(".sx-q"), boxEl: bar.querySelector(".sx-searchbox"),
        clearEl: bar.querySelector(".sx-clear"), chipsEl: bar.querySelector(".sx-chips"),
        toggleEl: bar.querySelector("[data-act=toggle]")
      };

      var counts = { all: items.length, live: 0, "2d": 0, "3d": 0, other: 0 };
      items.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
      if (!counts[state.chip]) state.chip = "all";
      [["all", "全部", counts.all], ["live", "真人", counts.live], ["2d", "2D 漫剧", counts["2d"]],
      ["3d", "3D 漫剧", counts["3d"]], ["other", "通用", counts.other]].forEach(function (c) {
        if (c[0] !== "all" && !c[2]) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "sx-chip" + (state.chip === c[0] ? " on" : "");
        b.setAttribute("data-k", c[0]);
        b.innerHTML = c[1] + ' <b>' + c[2] + "</b>";
        b.addEventListener("click", function () {
          state.chip = c[0]; save(); syncChips(); apply(); resetScroll();
        });
        ctx.chipsEl.appendChild(b);
      });
      function syncChips() {
        Array.prototype.forEach.call(ctx.chipsEl.children, function (b) {
          b.classList.toggle("on", b.getAttribute("data-k") === state.chip);
        });
      }

      ctx.order.forEach(function (g) {
        var rec = ctx.groups[g];
        rec.section.querySelector(".sx-ghead").addEventListener("click", function () {
          var open = rec.section.classList.toggle("open");
          state.open[g] = open; save(); syncToggle();
        });
      });
      ctx.toggleEl.addEventListener("click", function () {
        var allOpen = ctx.order.every(function (g) { return !!state.open[g]; });
        ctx.order.forEach(function (g) { state.open[g] = !allOpen; });
        save(); apply();
      });

      var timer = null;
      ctx.qEl.addEventListener("input", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          state.q = ctx.qEl.value || "";
          ctx.boxEl.classList.toggle("has-q", !!state.q);
          apply(); resetScroll();
        }, 110);
      });
      ctx.qEl.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { ctx.qEl.value = ""; state.q = ""; ctx.boxEl.classList.remove("has-q"); apply(); resetScroll(); }
      });
      ctx.clearEl.addEventListener("click", function () {
        ctx.qEl.value = ""; state.q = ""; ctx.boxEl.classList.remove("has-q"); apply(); resetScroll(); ctx.qEl.focus();
      });

      groupsEl.addEventListener("click", function (e) {
        var it = e.target && e.target.closest ? e.target.closest(".style-item") : null;
        if (!it) return;
        setTimeout(refreshInfo, 30);
      });

      var hasSaved = Object.keys(state.open).length > 0;
      if (!hasSaved) {
        var activeEl = wrap.querySelector(".style-item.active") || null;
        var openGid = null;
        if (activeEl) {
          var sec2 = activeEl.closest(".sx-group");
          if (sec2) openGid = sec2.getAttribute("data-gid");
        }
        if (!openGid) openGid = ctx.order[0];
        ctx.order.forEach(function (g) { state.open[g] = g === openGid; });
      }

      apply();
      refreshInfo();

      setTimeout(function () {
        var a = wrap.querySelector(".style-item.active");
        if (!a) return;
        var scroller = cfg.scroll === "wrap" ? wrap : field;
        var sec = a.closest ? a.closest(".sx-group") : null;
        var barH = bar.offsetHeight || 0;
        var fr = scroller.getBoundingClientRect();
        var ar = a.getBoundingClientRect(), sr = sec ? sec.getBoundingClientRect() : ar;
        var need = ar.top < fr.top + barH + 40 || ar.bottom > fr.bottom - 10;
        if (need) scroller.scrollTop += (sr.top - fr.top) - barH - 6;
      }, 60);
    }

    var queued = false;
    function scan() {
      queued = false;
      var card = document.querySelector(cfg.card);
      if (!card) { panel = null; ctx = null; return; }
      var field = card.querySelector(cfg.field);
      var grid = card.querySelector(".style-grid");
      if (!field || !grid) return;
      var alive = panel && panel.isConnected && panel.parentNode === field;
      var hasNew = grid.children && grid.children.length > 0;
      if (!alive) { build(card, field, grid); return; }
      if (hasNew) {                    /* 列表被重新渲染：拆掉旧面板重来 */
        try { panel.parentNode.removeChild(panel); } catch (e) { }
        panel = null; ctx = null;
        build(card, field, grid);
      }
    }
    function queue() {
      if (queued) return;
      queued = true;
      setTimeout(scan, 40);
    }

    var mo = new MutationObserver(function () { queue(); });
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
      queue();
    } else {
      document.addEventListener("DOMContentLoaded", function () { mo.observe(document.documentElement, { childList: true, subtree: true }); queue(); }, { once: true });
    }
  }

  /* ① 漫剧制作页「风格设置」：字段自己滚动 */
  install({ key: "wb", card: ".dialog-card.create-style-card", field: ".style-list-field", scroll: "field" });
  /* ② 作品列表「新增作品」→ 风格选择：网格自己有 max-height，改由面板滚动 */
  install({ key: "create", card: ".dialog-card.create-dialog-card", field: ".style-field", scroll: "wrap" });
})();
