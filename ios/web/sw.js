/* 报告 · Service Worker —— 离线可用，只缓存应用外壳 */
const CACHE = 'baogao-shell-v36';
/* 部署目录前缀：本 SW 可能挂在子路径下（如 /baogao/sw.js），
   此时接口是 /baogao/api/... 而非 /api/...，判断必须带前缀，
   否则接口请求会掉进下面的「缓存优先」分支被永久缓存。 */
const BASE = self.location.pathname.replace(/sw\.js$/, '');
const SHELL = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 站外资源（OCR 引擎、语言包、地图 SDK）走网络，不缓存
  if (url.origin !== location.origin) return;

  // 接口一律网络优先：统计数字要实时，缓存优先会让它永久卡在旧值
  if (url.pathname.startsWith(BASE + 'api/') || url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then(res => res)
        .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  // HTML / JS / CSS 网络优先：改版立即生效，断网才退回缓存
  const netFirst = url.pathname === BASE || url.pathname === BASE + 'index.html'
    || /\.(html|js|css)$/.test(url.pathname);
  if (netFirst) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  // 其余（CSS / 图标等）缓存优先
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
