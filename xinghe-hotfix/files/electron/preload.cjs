'use strict';
/**
 * 桥接层：按「漫剧分镜台」原有的 window 契约复刻。
 *
 * 注意：contextBridge 不能传 Proxy（会抛 An object could not be cloned），
 * 所以全部用显式对象 + 固定方法表。
 *
 * 真实契约（用原版 preload dump 实测，MJStudio/data/orig-api.json）：
 *   localProxy { ready, getBaseUrl, getHostToKey, rewrite }
 *   coreBridge { METHODS, invoke }   METHODS 15 个 action（详见 main.cjs CORE_METHODS）
 *   flygen { selectFolder, saveFile, selectFiles, getSettings, setSettings }
 *   dreamExt { check, launch }
 *   electronAPI —— 原版 preload 未暴露（前端做了可选降级），这里同样按需提供
 */
const { contextBridge, ipcRenderer } = require('electron');

// Vue 的响应式对象是 Proxy，直接过 contextBridge / IPC 会抛
// 「An object could not be cloned.」。这里统一做一次 JSON 深拷贝（拿到的就是普通对象）。
function plain(v) {
  if (v === null || typeof v === 'function') return v === null ? null : undefined;
  if (typeof v !== 'object') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}
const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args.map(plain));

const electronAPI = {
  // 在线热更新：info 查当前版本/最近一次热更，check 立即检查并弹窗
  app: {
    updateInfo: invoke('app:updateInfo'),
    updateCheck: invoke('app:updateCheck'),
    updateDiag: invoke('app:updateDiag'),
    updateSetUrl: invoke('app:updateSetUrl'),
    // 开发者渠道专用：主进程会校验本机标记，正式版一律拒绝
    devInfo: invoke('app:devInfo'),
    devOpenTools: invoke('app:devOpenTools'),
    devOpenPath: invoke('app:devOpenPath'),
    devCopyDiag: invoke('app:devCopyDiag'),
  },
  job: {
    list: invoke('job:list'),
    create: invoke('job:create'),
    delete: invoke('job:delete'),
    flags: invoke('job:flags'),
  },
  storyboard: {
    openDetached: invoke('storyboard:openDetached'),
  },
  // 原版前端在「取消生成」时会调 electronAPI.jimeng.cancelVideo({token})，
  // 壳层之前没实现（可选链静默跳过）→ 取消了也没人真去停豆包。现在接通到本地视频网关。
  jimeng: {
    cancelVideo: invoke('jimeng:cancelVideo'),
  },
  // 剪映：探测剪映真实草稿目录 + 把整集按分镜顺序拼成 mp4（8.x 只认自家加密草稿）
  jianying: {
    resolveDraftRoot: invoke('jianying:resolveDraftRoot'),
    buildEpisodeMp4: invoke('jianying:buildEpisodeMp4'),
    revealPath: invoke('jianying:revealPath'),
  },
  chatroom: {
    loadStore: invoke('chatroom:loadStore'),
    saveStore: invoke('chatroom:saveStore'),
    saveMeta: invoke('chatroom:saveMeta'),
    saveSession: invoke('chatroom:saveSession'),
    loadSession: invoke('chatroom:loadSession'),
    deleteSession: invoke('chatroom:deleteSession'),
  },
  fs: {
    readFile: invoke('fs:readFile'),
    writeFile: invoke('fs:writeFile'),
    mkdir: invoke('fs:mkdir'),
    unlink: invoke('fs:unlink'),
    exists: invoke('fs:exists'),
    readdir: invoke('fs:readdir'),
    stat: invoke('fs:stat'),
    copyFile: invoke('fs:copyFile'),
    rename: invoke('fs:rename'),
  },
  novel: {
    loadAllProjects: invoke('novel:loadAllProjects'),
    saveProject: invoke('novel:saveProject'),
    deleteProject: invoke('novel:deleteProject'),
    loadProject: invoke('novel:loadProject'),
    exportProject: invoke('novel:exportProject'),
  },
  doubaoExtension: {
    getStatus: invoke('doubao:getStatus'),
    // 订阅类接口必须走 ipcRenderer.on（invoke 传函数会抛 An object could not be cloned）
    subscribeStatus: (cb) => {
      const listener = (_e, status) => { try { cb && cb(status); } catch { /* ignore */ } };
      ipcRenderer.on('doubao:status', listener);
      ipcRenderer.invoke('doubao:subscribeStatus', true).catch(() => { /* ignore */ });
      return () => { try { ipcRenderer.removeListener('doubao:status', listener); } catch { /* ignore */ } };
    },
    setEnabled: invoke('doubao:setEnabled'),
    restart: invoke('doubao:restart'),
    regenerateToken: invoke('doubao:regenerateToken'),
    fetchHelper: invoke('doubao:fetchHelper'),
    getPath: invoke('doubao:getPath'),
    openFolder: invoke('doubao:openFolder'),
  },
  auth: {
    saveToken: invoke('auth:saveToken'),
    loadToken: invoke('auth:loadToken'),
    // 提示词接口用的第二令牌：返回 { success:true, data:"<token字符串>" }
    loadTokenTwo: invoke('auth:loadTokenTwo'),
    getToken: invoke('auth:getToken'),
    clearToken: invoke('auth:clearToken'),
    onForcedLogout: (cb) => { try { ipcRenderer.on('auth:forcedLogout', () => cb && cb()); } catch { /* ignore */ } },
  },
  system: {
    getMachineId: invoke('system:getMachineId'),
    getInfo: invoke('system:getInfo'),
    getAppConfig: invoke('system:getAppConfig'),
    writeAutoLoginLog: invoke('system:writeAutoLoginLog'),
  },
  asset: {
    revealInFolder: invoke('asset:revealInFolder'),
    download: invoke('asset:download'),
    importLocal: invoke('asset:importLocal'),
    save: invoke('asset:save'),
    delete: invoke('asset:delete'),
    list: invoke('asset:list'),
  },
  shell: {
    openExternal: invoke('shell:openExternal'),
    openPath: invoke('shell:openPath'),
    showItemInFolder: invoke('shell:showItemInFolder'),
  },
  gpuFallback: {
    getStatus: invoke('gpuFallback:getStatus'),
    reset: invoke('gpuFallback:reset'),
  },
  media: {
    getDuration: invoke('media:getDuration'),
    getMeta: invoke('media:getMeta'),
    extractThumb: invoke('media:extractThumb'),
  },
  mainLog: {
    list: invoke('mainLog:list'),
    append: invoke('mainLog:append'),
    clear: invoke('mainLog:clear'),
  },
  assetLibrary: {
    listAll: invoke('assetLibrary:listAll'),
    upsert: invoke('assetLibrary:upsert'),
    delete: invoke('assetLibrary:delete'),
    batchDelete: invoke('assetLibrary:batchDelete'),
    list: invoke('assetLibrary:list'),
    save: invoke('assetLibrary:save'),
    remove: invoke('assetLibrary:remove'),
    import: invoke('assetLibrary:import'),
    export: invoke('assetLibrary:export'),
  },
};

const flygen = {
  selectFolder: invoke('flygen:selectFolder'),
  saveFile: invoke('flygen:saveFile'),
  selectFiles: invoke('flygen:selectFiles'),
  getSettings: invoke('flygen:getSettings'),
  setSettings: invoke('flygen:setSettings'),
};

/* localProxy.rewrite 必须是【同步】函数（前端直接拿返回值当 URL 用），
 * 与主进程 startProxyServer 的路由规则保持一致：/px/<encodeURIComponent(origin)><rest> */
const PROXY_PORT = Number(ipcRenderer.sendSync('localProxy:portSync'));
function rewriteUrlSync(raw) {
  const u = String(raw || '');
  if (!/^https?:\/\//i.test(u)) return u;
  const m = /^(https?:\/\/[^/?#]+)([\s\S]*)$/i.exec(u);
  if (!m) return u;
  const origin = m[1];
  const rest = m[2] || '/';
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) && rest.startsWith('/px/')) return u;
  return `http://127.0.0.1:${PROXY_PORT}/px/${encodeURIComponent(origin)}${rest}`;
}

const localProxy = {
  ready: invoke('localProxy:ready'),
  getBaseUrl: invoke('localProxy:getBaseUrl'),
  getHostToKey: invoke('localProxy:getHostToKey'),
  rewrite: rewriteUrlSync,
};

const coreBridge = {
  METHODS: {
    AUTH_LOGIN: 'auth.login',
    AUTH_RESTORE_SESSION: 'auth.restoreSession',
    AUTH_VALIDATE_SESSION: 'auth.validateSession',
    AUTH_LOGOUT: 'auth.logout',
    LICENSE_GET_STATUS: 'license.getStatus',
    DEVICE_GET_ID: 'device.getId',
    NOVEL_GENERATE_OUTLINE: 'novel.generateOutline',
    NOVEL_GENERATE_TEXT: 'novel.generateText',
    NOVEL_BUILD_OUTLINE_PROMPT: 'novel.buildOutlinePrompt',
    NOVEL_BUILD_PROMPT: 'novel.buildPrompt',
    STORYBOARD_GENERATE: 'storyboard.generate',
    STORYBOARD_CHECK: 'storyboard.check',
    PROMPT_BUILTIN: 'prompt.builtin',
    PROMPT_BUILD: 'prompt.build',
    MEDIA_REQUEST: 'media.request',
  },
  invoke: (action, payload) => ipcRenderer.invoke('core:invoke', String(action), payload),
};

const dreamExt = {
  check: (name) => ipcRenderer.invoke('xapp:check', name),
  launch: (name) => ipcRenderer.invoke('xapp:launch', name),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('flygen', flygen);
contextBridge.exposeInMainWorld('localProxy', localProxy);
contextBridge.exposeInMainWorld('coreBridge', coreBridge);
contextBridge.exposeInMainWorld('dreamExt', dreamExt);

// 调试辅助：把 console.error 的对象参数序列化，便于无头探针拿到真实错误
try {
  const origError = console.error;
  console.error = function (...args) {
    return origError.apply(console, args.map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + String(a.stack).split('\n')[1] : ''}`;
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : a; } catch { return a; }
    }));
  };
} catch { /* ignore */ }
