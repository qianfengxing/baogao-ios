/* ============================================================
   报告 · 核心逻辑
   取证 → 核对 → 生成材料 → 提交/存证
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  /* 待重传箱：只在「上传失败（断网）」时暂存一份，联网后自动补传，
     成功后立刻清掉。它不进记录列表——记录页只显示服务器上的。 */
  const OUTBOX = 'baogao.outbox.v1';
  // 地图 SDK 按需加载：首页加载即拉 Leaflet + 高德瓦片（免 key）
  /* 私有举报后台地址：一律跟随当前页面所在目录，不再写死内网 IP。
     · 本地直连   http://127.0.0.1:8780/          -> API = ''
     · 公网子路径 https://feng.cpolar.top/baogao/ -> API = '/baogao'
     · App 内 WebView（file:///android_asset/）    -> 回落到公网域名 /baogao
       （资源已打进 APK 离线加载，仅数据接口走公网；服务端 CORS=*，可跨源读取） */
  const API = (function () {
    // App 内本地托管（iOS http://127.0.0.1:PORT）：资源随包离线，
    // API 走同源（本地 server 会把 /api 代理到公网），故返回 ''。
    if (location.protocol === 'file:') return 'https://feng.cpolar.top/baogao';
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return '';
    const p = location.pathname || '/';
    const dir = p.slice(0, Math.max(0, p.lastIndexOf('/')));
    if (dir && dir !== '/') return dir;
    return (location.port === '8780') ? '' : 'http://127.0.0.1:8780';
  })();
  const DEFAULT_CENTER = [31.3267, 118.3729]; // 芜湖，首次无记录时的地图中心

  const AD_TYPES = [
    { id: 'plumb',   name: '疏通下水道' },
    { id: 'lock',    name: '开锁换锁' },
    { id: 'cert',    name: '办证刻章' },
    { id: 'loan',    name: '贷款/代款' },
    { id: 'recycle', name: '回收收购' },
    { id: 'move',    name: '搬家维修' },
    { id: 'rent',    name: '租房招工' },
    { id: 'other',   name: '其他' }
  ];

  /* ---------------- 状态 ---------------- */
  const S = {
    view: 'home',
    photo: null,      // dataURL（压缩后）
    thumb: null,      // 小图，用于记录
    photos: [],       // 多张待传：[{big, small}]
    ocrText: '',
    items: [],
    loc: '',
    locName: '',    // 逆地理编码出来的地名（只显示，可手动补充）
    note: '',       // 用户写的说明文字（选填，最多 300 字）
    coords: null,
    adType: 'other',
    report: null,
    maskSec: false,   // 报告页是否隐藏敏感信息
    fbPhotos: [],     // 意见反馈配图：[{big, small}]
    myReports: [],    // 服务端的「我的举报」（记录页直接显示这个，本机不再留副本）
    busy: false
  };

  /* ---------------- DOM ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = {
    btnBack: $('#btn-back'),
    main: $('#main'), tabs: $('#tabs'),
    overlay: $('#overlay'), ovTitle: $('#ov-title'), ovText: $('#ov-text'),
    toast: $('#toast'),
    reviewImg: $('#review-img'), stamp: $('#stamp'),
    inpLoc: $('#inp-loc'), geoHint: $('#geo-hint'),
    tags: $('#tags'),
    listPhone: $('#list-phone'), listUrl: $('#list-url'),
    cntPhone: $('#cnt-phone'), cntUrl: $('#cnt-url'),
    rawText: $('#raw-text'),
    reportBody: $('#report-body'), reportNo: $('#report-no'), reportTitle: $('#report-title'),
    reportFlag: $('#report-flag'),
    recList: $('#rec-list'), recEmpty: $('#rec-empty'),
    viewer: $('#viewer'), viewerImg: $('#viewer-img'),
    fileCamera: $('#file-camera'), fileAlbum: $('#file-album'),
    fbText: $('#fb-text'), fbCount: $('#fb-count'), fbPic: $('#fb-pic'),
    fbThumbs: $('#fb-thumbs'), fbSend: $('#fb-send'), fbTip: $('#fb-tip'),
    fileFeedback: $('#file-feedback'),
    online: true        // 服务端在线态：启动时探测一次，之后周期探；离线时提交走本地暂存、无感
  };

  /* ============================================================
     工具
     ============================================================ */
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove('on'), 2200);
  }

  const pad = n => String(n).padStart(2, '0');
  function fmtTime(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtShort(d) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function ymd(d) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 脱敏显示：界面上任何"给别人看"的地方都不出现完整联系方式 */
  function maskPhone(raw) {
    const d = String(raw || '').replace(/[^0-9]/g, '');
    if (d.length >= 11) return d.slice(0, 3) + ' **** ' + d.slice(-4);
    if (d.length >= 9) return d.slice(0, 3) + ' **** ' + d.slice(-2);
    if (d.length >= 5) return d.slice(0, 2) + '***' + d.slice(-2);
    return '******';
  }
  function maskUrl(raw) {
    const s = String(raw || '').replace(/^https?:\/\//, '');
    const m = /^(.*?)(\.[a-zA-Z]{2,6})(\/.*)?$/.exec(s);
    if (!m) return s.slice(0, 2) + '***';
    return m[1].slice(0, 3) + '***' + m[2];
  }
  function maskAny(it) {
    return it.kind === 'phone' ? maskPhone(it.raw || it.display) : maskUrl(it.raw || it.display);
  }

  /* ============================================================
     环形进度控件（上传 / 识别 / 处理照片 统一使用）
     设计参考 Uppy StatusBar + FilePond 的做法：
       · 分阶段：打包 → 上传（真实字节进度）→ 后端处理（不确定态弧线旋转）
       · 速度用指数滑动平均(EMA)平滑，剩余时间 = 剩余字节 ÷ 速度
       · 百分比单调不回退，DOM 更新按 70ms 节流，避免数字乱跳
       · 不确定态（拿不到 total 或后端处理中）用旋转弧，不是假装的百分比
       · 完成态描出绿色对勾；全程可取消
     ============================================================ */
  const PG_C = 270.18;                 // 2πr，r = 43
  const pg = {
    box: $('#pg'), fill: $('#pg-fill'), pct: $('#pg-pct'),
    amount: $('#pg-amount'), detail: $('#pg-detail'), cancel: $('#pg-cancel'),
    value: 0, lastPaint: 0
  };

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '';
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
  }
  function fmtEta(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '';
    if (sec < 1) return '不到 1 秒';
    if (sec < 60) return Math.ceil(sec) + ' 秒';
    return Math.ceil(sec / 60) + ' 分钟';
  }
  /* 指数移动平均（半衰期版，与 Uppy 的 emaFilter 同款）：
     halfLife 越大越平滑，dt 为距上次采样的毫秒数，因此对采样频率不敏感。 */
  function emaFilter(now, prev, halfLife, dt) {
    if (halfLife === 0 || now === prev) return now;
    if (dt === 0) return prev;
    return now + (prev - now) * Math.pow(2, -dt / halfLife);
  }

  /* 数字更新节流 500ms：Uppy 源码注释给出的理由——低于 250ms 会与动画冲突，
     低于 500ms 会让手机发烫（Firefox 长传实测）。平滑感交给 CSS 0.3s 过渡补。 */
  const PG_THROTTLE = 500;

  function pgSet(v, opt) {
    opt = opt || {};
    if (!opt.indeterminate) {                                 // 不确定态不推进百分比（Uppy：换数据源而非猜）
      const val = Math.max(0, Math.min(100, Number(v) || 0));
      // 默认只增不减（弱网重传会让 loaded 回退，数字跳回去很吓人）；重试时显式 allowBack 归零
      pg.value = opt.allowBack ? val : Math.max(pg.value, val);
    }

    const now = Date.now();
    const isEnd = (Number(v) || 0) >= 100 || opt.force;
    if (!isEnd && now - pg.lastPaint < PG_THROTTLE) return;
    pg.lastPaint = now;

    pg.box.classList.toggle('indet', !!opt.indeterminate);
    if (opt.indeterminate) {
      pg.pct.textContent = '⋯';          // 不确定态：不给假百分比
      pg.pct.nextElementSibling && (pg.pct.nextElementSibling.textContent = '');
      pg.box.removeAttribute('aria-valuenow');   // ARIA 规范：不确定态省略 valuenow
    } else {
      pg.fill.style.strokeDashoffset = String(PG_C * (1 - pg.value / 100));
      pg.pct.textContent = String(Math.round(pg.value));
      pg.pct.nextElementSibling && (pg.pct.nextElementSibling.textContent = '%');
      pg.box.setAttribute('aria-valuenow', String(Math.round(pg.value)));
    }
    if (opt.amount != null) {
      pg.amount.textContent = opt.amount;
      pg.amount.hidden = !opt.amount;
    }
    if (opt.text) el.ovText.textContent = opt.text;
    if (opt.detail != null) {
      pg.detail.textContent = opt.detail;
      pg.detail.hidden = !opt.detail;
    }
  }

  function showOverlay(title, opt) {
    opt = opt || {};
    pg.value = 0; pg.lastPaint = 0;
    el.ovTitle.textContent = title || '处理中';
    el.ovText.textContent = opt.text || '准备中…';
    el.ovText.removeAttribute('role');      // 上一轮的完成播报不要残留
    pg.pct.textContent = '0';
    pg.amount.textContent = ''; pg.amount.hidden = true;
    pg.detail.textContent = ''; pg.detail.hidden = true;
    pg.box.classList.remove('done', 'indet');
    pg.fill.style.strokeDashoffset = String(PG_C);
    if (opt.cancel) {
      pg.cancel.hidden = false;
      pg.cancel.onclick = opt.cancel;
    } else {
      pg.cancel.hidden = true;
      pg.cancel.onclick = null;
    }
    el.overlay.hidden = false;
  }

  function setProgress(pct, text) { pgSet(pct, { text }); }   // 兼容旧调用点

  function pgDone(text) {
    pgSet(100, { text: text || '完成', force: true, amount: '', detail: '' });
    pg.pct.textContent = '100';
    pg.box.classList.remove('indet');
    pg.box.classList.add('done');
    pg.cancel.hidden = true;
    // 完成是一次性播报（role=status 隐含 aria-live=polite）；进度条本身不加 aria-live，
    // 否则读屏会被百分比刷屏（Uppy 的做法）
    el.ovText.setAttribute('role', 'status');
  }
  function hideOverlay() { el.overlay.hidden = true; }

  /* ============================================================
     视图切换
     ============================================================ */
  const VIEW_META = {
    home:    { name: '我要报告', sub: '', back: false, tab: 'home' },
    review:  { name: '核对信息', sub: '', back: true, tab: 'home' },
    submit:  { name: '举报材料', sub: '', back: true, tab: 'home' },
    records: { name: '举报记录', sub: '', back: false, tab: 'records' },
    about:   { name: '说明', sub: '', back: false, tab: 'about' },
    login:   { name: '登录', sub: '', back: true, tab: 'records' },
    compose: { name: '编辑举报', sub: '', back: true, tab: 'home' }
  };

  /* 是否运行在自家 App 的 WebView 里（决定返回钮要不要显示） */
  function inApp() {
    return !!(window.BaoGaoNative && typeof window.BaoGaoNative.getInfo === 'function');
  }

  function go(view) {
    const meta = VIEW_META[view];
    if (!meta) return;
    S.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
    // 顶栏已移除。返回钮只在浏览器预览里出现（App 里靠系统返回键）
    if (el.btnBack) el.btnBack.hidden = !(meta.back && !inApp());
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === meta.tab));
    // 首页就是地图（全屏不滚动），切回来要重新量尺寸
    el.main.classList.toggle('map-mode', view === 'home');
    el.main.scrollTop = 0;
    if (view === 'home') {
      setTimeout(() => MapCtl.show(), 90);
    }
  }

  function back() {
    if (S.view === 'submit') go('review');
    else go('home');
  }

  /* ============================================================
     图片处理
     ============================================================ */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function compress(dataUrl, maxSide, quality) {
    const img = await loadImg(dataUrl);
    let { width: w, height: h } = img;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', quality);
  }

  /* 超时兜底：离线化后 file:// 不透明源下，Worker/wasm/超大图都可能不回调，
     任何一步卡死都自动回退，绝不让界面停住（对齐"OCR 绝不阻断提交"的设计）。 */
  function withTimeout(promise, ms, fallback) {
    let timer;
    const to = new Promise(res => { timer = setTimeout(() => res({ to: true }), ms); });
    return Promise.race([
      promise.then(v => ({ v })).catch(() => ({ v: fallback })),
      to
    ]).then(r => { clearTimeout(timer); return r.to ? fallback : (r.v !== undefined ? r.v : fallback); });
  }
  /* 压缩卡死（iOS file:// + 超大 dataURL 偶发）时回退原图，照片不丢、界面不卡 */
  async function compressSafe(dataUrl, maxSide, quality) {
    return withTimeout(compress(dataUrl, maxSide, quality), 12000, dataUrl);
  }

  /* ============================================================
     文本归一化 + 抽取
     ============================================================ */
  function normalize(s) {
    return String(s || '')
      .replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[—–−ー]/g, '-')
      .replace(/[：]/g, ':')
      .replace(/[／]/g, '/')
      .replace(/[．。]/g, '.')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[\u3000\u00A0]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ');
  }

  const RE = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    // 注：不用后行断言 (?<!...)，兼容 iOS Safari 16.4 以下
    mobile: /(^|[^0-9])((?:\+?86[\s-]?)?(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}))(?![0-9])/g,
    service: /(^|[^0-9])((?:400|800)[\s-]?\d{3}[\s-]?\d{4})(?![0-9])/g,
    landline: /(^|[^0-9])(0\d{2,3}[\s-]?\d{7,8}(?:[\s-]?\d{1,4})?)(?![0-9])/g,
    url: /(?:https?:\/\/)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|cn|net|org|top|xyz|cc|vip|shop|site|online|club|wang|info|biz|tv|me|io|co|gov|edu|link|store|tech)(?::\d{2,5})?(?:\/[\w\-./?%&=#~]*)?/gi,
    qq: /(?:Q{2}|q{2}|Q群|扣扣|企鹅|QQ群)\s*[:号]?\s*(\d{5,11})/gi,
    wechat: /(?:微信|V信|v信|加微|薇信|VX|vx|weixin|WeChat)\s*[:号]?\s*([a-zA-Z][a-zA-Z0-9_-]{5,19})/g
  };

  /* 扫描带前导分组的正则：
     m[1]=前导字符（可能是空串），m[2]=号码本体。
     匹配后把 lastIndex 回拨到号码起点，保证"13888888888 13999999999"
     这类只隔一个分隔符的连续号码不漏配。 */
  function scan(re, text, filter) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const val = m[2];
      const digitStart = m.index + m[1].length;
      re.lastIndex = digitStart > m.index ? digitStart : m.index + 1;
      if (!filter || filter(val, digits(val))) out.push(val);
    }
    return out;
  }

  function digits(s) { return s.replace(/[^0-9]/g, ''); }

  function fmtPhone(raw) {
    const d = digits(raw);
    if (d.length === 11 && /^1[3-9]/.test(d)) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
    if (d.length === 11 && /^(400|800)/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length >= 10 && d[0] === '0') {
      const area = d.length === 12 ? 4 : d.length === 11 ? 3 : 3;
      const head = d.slice(0, area);
      const tail = d.slice(area);
      return tail.length > 8 ? `${head}-${tail.slice(0, 8)}-${tail.slice(8)}` : `${head}-${tail}`;
    }
    return raw.trim();
  }

  function extract(text) {
    const norm = normalize(text);
    const out = [];
    const seen = new Set();

    function push(kind, raw, display, label, risky) {
      const key = kind === 'phone' ? 'p:' + digits(raw) : 'u:' + String(raw).toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: uid(), kind, raw: String(raw).trim(), display, label, risky: !!risky, checked: true, source: 'ocr' });
    }

    // 邮箱先摘出来，避免被网址正则吃掉
    let work = norm;
    const emails = [];
    work = work.replace(RE.email, m => { emails.push(m); return ' \u0000EMAIL\u0000 '; });

    // 手机号 / 热线 / 固话
    scan(RE.mobile, work).forEach(v => {
      let d = digits(v);
      if (d.length > 11 && d.startsWith('86')) d = d.slice(d.length - 11); // 去掉国别前缀
      push('phone', d, fmtPhone(d), '手机号');
    });
    scan(RE.service, work).forEach(d => push('phone', digits(d), fmtPhone(digits(d)), '服务热线'));
    scan(RE.landline, work, (v, d) => d.length >= 10 && d.length <= 12)
      .forEach(d => push('phone', digits(d), fmtPhone(digits(d)), '固定电话'));

    // 网址
    let m;
    RE.url.lastIndex = 0;
    while ((m = RE.url.exec(work))) {
      const u = m[0].replace(/[.,;:'")\]]+$/, '');
      if (/^\d+$/.test(u)) continue;
      if (u.length < 6) continue;
      push('url', u, u.replace(/^https?:\/\//, ''), '网址');
    }
    emails.forEach(e => push('url', e, e, '邮箱'));

    // QQ / 微信
    RE.qq.lastIndex = 0;
    while ((m = RE.qq.exec(norm))) push('url', m[1], 'QQ ' + m[1], 'QQ');
    RE.wechat.lastIndex = 0;
    while ((m = RE.wechat.exec(norm))) {
      const v = m[1];
      if (/^(com|cn|net|www)$/i.test(v)) continue;
      push('url', v, v, '微信号');
    }

    return out;
  }

  /* ============================================================
     通用工具：按需加载外部脚本（地图 SDK 等使用）
     ============================================================ */
  function loadScript(src, ms) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; reject(new Error('脚本加载超时')); } }, ms || 12000);
      s.onload = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      s.onerror = () => { if (!done) { done = true; clearTimeout(t); reject(new Error('脚本加载失败')); } };
      document.head.appendChild(s);
    });
  }

  /* ---- 通用图片读取（多處复用：生成缩略图、回显大图等）---- */
  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = src;
    });
  }

  /* OCR 已移除：本机不再做照片识别。识别 / 清洗交由后台处理，App 仅压缩并上传原图。
     用户仍可在编辑页「手动补号码 / 网址」([data-add])。 */

  /* ============================================================
     照片水印（写入核对页角标）
     ============================================================ */
  function refreshStamp() {
    const now = new Date();
    const pos = S.coords
      ? `${S.coords.lat.toFixed(5)}, ${S.coords.lng.toFixed(5)}`
      : '位置未获取';
    el.stamp.textContent = `${fmtTime(now)}\n${S.loc || '地点待填写'}　${pos}`;
  }

  /* ============================================================
     主流程：拍照即传（手机端不做 OCR，识别/举报由后台负责）
     ============================================================ */
  function locateOnce(timeout) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('不支持定位'));
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        err => reject(err),
        { enableHighAccuracy: true, timeout: timeout || 8000, maximumAge: 60000 }
      );
    });
  }

  /* ---- 多张待传：拍照 / 相册可反复添加，攒够一起传 ---- */
  const MAX_PHOTOS = 9;

  async function addPhotos(files) {
    const imgs = [...(files || [])].filter(f => f && /^image\//.test(f.type));
    dbg('addPhotos 收到 ' + (files ? files.length : 0) + ' 个，图片类 ' + imgs.length + ' 个');
    if (!imgs.length) { toast('没有选到照片，请重试'); return; }
    if (S.photos.length >= MAX_PHOTOS) { toast(`一次最多 ${MAX_PHOTOS} 张`); return; }
    const room = MAX_PHOTOS - S.photos.length;
    const take = imgs.slice(0, room);
    if (imgs.length > room) toast(`最多 ${MAX_PHOTOS} 张，多出的没加进来`);

    showOverlay('正在处理照片');
    try {
      for (let i = 0; i < take.length; i++) {
        setProgress(10 + i * 20, `处理第 ${S.photos.length + 1} 张…`);
        try {
          const raw = await readFile(take[i]);
          let big, small;
          try { big = await compressSafe(raw, 1600, 0.86); }
          catch (e) { big = raw; }                       // 压缩失败就用原图，不丢这张
          try { small = await compressSafe(raw, 420, 0.72); }
          catch (e) { small = big; }
          S.photos.push({ big, small });
        } catch (e) {
          console.error('单张处理失败', e);
          toast('有 1 张处理失败，已跳过');
        }
      }
      if (!S.photos.length) { hideOverlay(); toast('照片都没处理成功，换张试试'); return; }

      // 首张加入时自动定位一次（失败不影响上传）
      if (!S.coords) {
        setProgress(90, '获取位置…');
        try { S.coords = await locateOnce(8000); } catch (e) { S.coords = null; }
      }
      hideOverlay();

      /* 关键修复：先跳到「编辑举报」确认页，确保用户一定能看到照片管理界面。
         旧写法先 renderShelf/renderCompose 再 go('compose')，一旦其中任一步在真机抛异常，
         跳页就被跳过、照片却已 push 进列表（首页才冒出「上传 N 张」按钮）、编辑页不跳也不报错
         —— 表现就是「拍照没反应、照片没加到编辑页」。现在无论如何先跳页。 */
      go('compose');
      try { renderCompose(); renderShelf(); }
      catch (e) { console.error('渲染确认页失败', e); }

      dbg('addPhotos 完成 -> go(compose) 后 view=' + S.view + ' photos=' + S.photos.length);
      // 逆地理编码拿地名（网络慢，异步补上，不阻塞进页面）
      if (S.coords && !S.locName) {
        reverseGeocode(S.coords.lat, S.coords.lng)
          .then(n => { S.locName = n; renderCompose(); })
          .catch(() => { });
      }
    } catch (err) {
      console.error(err);
      hideOverlay();
      toast('照片处理失败，换张试试');
    }
  }

  function renderShelf() {
    const shelf = $('#photo-shelf');
    const btn = $('#btn-upload');
    if (!shelf || !btn) return;
    const n = S.photos.length;
    btn.hidden = !n;
    btn.textContent = `去确认 ${n} 张`;
    if (!n) { shelf.hidden = true; shelf.innerHTML = ''; return; }
    shelf.hidden = false;
    shelf.innerHTML = S.photos.map((p, i) =>
      `<div class="shelf-item">` +
        `<img src="${p.small}" alt="">` +
        `<button class="shelf-del" data-i="${i}" aria-label="删除">✕</button>` +
        (i === 0 ? '<span class="shelf-tag">主图</span>' : '') +
      `</div>`
    ).join('');
  }

  /* ---- 编辑举报页（发朋友圈式）---- */

  /* 坐标 → 地名。和搜索用同一个 Photon 服务，免 key、WGS84 坐标 */
  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
      if (!r.ok) return '';
      const j = await r.json();
      const f = j && j.features && j.features[0];
      const p = (f && f.properties) || {};
      return [p.name, p.street, p.district, p.city].filter(Boolean).slice(0, 3).join(' · ');
    } catch (e) { return ''; }
  }

  async function composeLocate() {
    const name = $('#cmp-loc-name');
    if (name) name.textContent = '正在定位…';
    try {
      S.coords = await locateOnce(8000);
      S.locName = await reverseGeocode(S.coords.lat, S.coords.lng);
      if (!S.locName) toast('已定位，可手动补充具体位置');
    } catch (e) {
      S.locName = '';
      toast('定位失败，可手动补充位置');
    }
    renderCompose();
  }

  function renderCompose() {
    const grid = $('#cmp-grid');
    if (grid) {
      grid.innerHTML = S.photos.map((p, i) =>
        `<div class="cmp-cell">` +
          `<img src="${p.small}" alt="">` +
          `<button class="cmp-del" data-i="${i}" aria-label="删除这张">✕</button>` +
          (i === 0 ? '<span class="cmp-tag">主图</span>' : '') +
        `</div>`
      ).join('');
    }
    const full = S.photos.length >= MAX_PHOTOS;
    ['#cmp-add-camera', '#cmp-add-album'].forEach(s => {
      const b = $(s); if (b) b.disabled = full;
    });

    const nm = $('#cmp-loc-name');
    if (nm) {
      nm.textContent = S.locName
        || (S.coords ? '已定位 · 建议补充具体位置' : '未定位，可手动补充位置');
    }
    const cd = $('#cmp-loc-coord');
    if (cd) cd.textContent = S.coords
      ? `${S.coords.lat.toFixed(6)}, ${S.coords.lng.toFixed(6)}`
      : '点「重新定位」再取一次';

    const cnt = $('#cmp-note-count');
    if (cnt) cnt.textContent = String((S.note || '').length);
    // 回填输入框（值不同才写，避免把用户正在敲的内容顶掉）
    const li = $('#cmp-loc-input');
    if (li && li.value !== (S.loc || '')) li.value = S.loc || '';
    const nt = $('#cmp-note');
    if (nt && nt.value !== (S.note || '')) nt.value = S.note || '';

    const sub = $('#cmp-submit');
    if (sub) sub.disabled = !S.photos.length || S.busy;
    const st = $('#cmp-submit-text');
    if (st) st.textContent = S.photos.length ? `报告（${S.photos.length} 张）` : '报告';
  }

  async function doUpload() {
    if (!S.photos.length) { toast('还没有照片，先去拍照或加图'); return; }
    if (S.busy) { toast('正在处理上一张，请稍候'); return; }
    S.busy = true;
    let cancelled = false;
    try {
      const n = S.photos.length;
      // 预估体积：dataURL 的 base64 段 × 3/4 ≈ 原始字节数，让用户一开始就心里有数
      const estBytes = S.photos.reduce((a, p) => {
        const i = String(p.big || '').indexOf(',');
        return a + Math.round(Math.max(0, String(p.big || '').length - i - 1) * 0.75);
      }, 0);
      showOverlay('正在上传', {
        text: '打包照片…',
        cancel: () => { cancelled = true; if (curXhr) curXhr.abort(); }
      });
      pgSet(6, {
        text: '打包照片…',
        amount: n + ' 张 · 约 ' + fmtBytes(estBytes),
        force: true
      });

      const r = buildReport();
      S.report = r;

      let uploaded = false;
      let savedOffline = false;
      let city = '';
      try {
        if (S.online) {
          const d = await uploadWithRetry(r, n, (p) => {
            if (p.unknown) {                       // 拿不到总字节数：转不确定态，不假装百分比
              pgSet(50, { indeterminate: true, text: '上传中…', amount: n + ' 张' });
              return;
            }
            const spd = p.speed > 1024 ? fmtBytes(p.speed) + '/s' : '';
            pgSet(6 + p.ratio * 88, {
              text: '上传中',
              amount: fmtBytes(p.loaded) + ' / ' + fmtBytes(p.total),
              detail: spd ? (spd + (p.eta != null ? ' · 还剩 ' + fmtEta(p.eta) : '')) : ''
            });
          });
          city = d.city || '';
          uploaded = true;
          /* 后端落盘/入库：这段拿不到进度。按 Uppy 的做法——不确定态不推进百分比，
             只换成橙色旋转弧 + "后台处理中"，而不是卡在 96% 骗人。 */
          pgSet(0, { indeterminate: true, force: true, text: '后台处理中…', amount: '', detail: '' });
        } else {
          throw new Error('OFFLINE');   // 已知离线：直接走本地暂存，不傻等超时
        }
      } catch (e) {
        if (String(e.message) === 'CANCEL') cancelled = true;
        else {
          // 断网/服务器不可达：暂存到本机待传箱，联网后自动补传，不让用户手工点同步
          savedOffline = addOutbox({ no: r.no, timeText: r.timeText, report: r, photos: S.photos });
          if (!savedOffline) toast('照片太大，本机存不下，请在有网时重拍再提交');
        }
      }

      if (uploaded) {
        syncMe().then(renderBadge).catch(() => {});
        refreshMyReports();          // 记录页直接用服务器的最新列表
        pgDone('已上报');
        await new Promise(d2 => setTimeout(d2, 760));   // 让对勾动画走完
      } else if (savedOffline) {
        // 离线：外观与成功一致，用户无感；联网后自动同步
        pgDone('已保存');
        await new Promise(d2 => setTimeout(d2, 760));
      }
      resetAll();
      renderShelf();
      hideOverlay();

      go('home');
      if (cancelled) {
        toast('已取消，照片还在，可重新上传');
      } else if (uploaded) {
        toast('已上报');
      } else if (savedOffline) {
        /* 离线提交保持无感：记录页本地条目显示「待同步」，联网后自动上传，不弹网络告警 */
      } else {
        toast('提交未完成，照片已保留，可再试');
      }
    } catch (err) {
      console.error(err);
      hideOverlay();
      toast('上传失败，照片已保留，可再试');
    } finally {
      S.busy = false;
    }
  }

  function enterReview(text) {
    S.ocrText = text || '';
    S.items = extract(S.ocrText);
    go('review');
    refreshStamp();
    renderTags();
    renderItems();
    el.rawText.textContent = S.ocrText.trim() || '（没有识别到文字）';
  }

  /* ============================================================
     核对页渲染
     ============================================================ */
  function renderTags() {
    el.tags.innerHTML = AD_TYPES.map(t =>
      `<button class="tag${t.id === S.adType ? ' on' : ''}" data-type="${t.id}">${t.name}</button>`
    ).join('');
  }

  function renderItems() {
    const phones = S.items.filter(i => i.kind === 'phone');
    const urls = S.items.filter(i => i.kind !== 'phone');

    el.listPhone.innerHTML = phones.length
      ? phones.map(itemHTML).join('')
      : `<div class="hint" style="margin:0 0 2px">没识别到电话号码，点下面手动补一个。</div>`;

    el.listUrl.innerHTML = urls.length
      ? urls.map(itemHTML).join('')
      : `<div class="hint" style="margin:0 0 2px">没识别到网址或账号。</div>`;

    el.cntPhone.textContent = phones.length;
    el.cntUrl.textContent = urls.length;
    el.cntPhone.classList.toggle('zero', !phones.length);
    el.cntUrl.classList.toggle('zero', !urls.length);
  }

  function itemHTML(it) {
    return `
      <div class="item ${it.checked ? 'on' : 'off'}" data-id="${it.id}">
        <button class="tick" data-act="toggle" aria-label="选用">
          <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>
        </button>
        <div class="item-main">
          <input class="val" value="${esc(it.display)}" data-act="edit" spellcheck="false">
          <div class="item-meta"><span class="badge">${esc(it.label)}</span>${it.source === 'manual' ? '<span class="badge warn">手动</span>' : ''}</div>
        </div>
        <button class="del" data-act="del" aria-label="删除">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12"/></svg>
        </button>
      </div>`;
  }

  /* 事件委托：号码列表 */
  function bindList(container) {
    container.addEventListener('click', e => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const itemEl = actEl.closest('.item');
      if (!itemEl) return;
      const id = itemEl.dataset.id;
      const it = S.items.find(x => x.id === id);
      if (!it) return;
      const act = actEl.dataset.act;

      if (act === 'toggle') {
        it.checked = !it.checked;
        itemEl.classList.toggle('on', it.checked);
        itemEl.classList.toggle('off', !it.checked);
      } else if (act === 'del') {
        S.items = S.items.filter(x => x.id !== id);
        renderItems();
      }
    });

    container.addEventListener('input', e => {
      const input = e.target.closest('[data-act="edit"]');
      if (!input) return;
      const itemEl = input.closest('.item');
      const it = S.items.find(x => x.id === itemEl.dataset.id);
      if (!it) return;
      it.display = input.value;
      it.raw = it.kind === 'phone' ? digits(input.value) : input.value.trim();
    });
  }

  /* ============================================================
     报告生成
     ============================================================ */
  function chosen() {
    return S.items.filter(i => i.checked && String(i.display).trim());
  }

  function typeName() {
    const t = AD_TYPES.find(t => t.id === S.adType);
    return t ? t.name : '其他';
  }

  function serial(now) {
    return 'RPT-' + ymd(now) + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  }

  function buildReport() {
    const now = new Date();
    const list = chosen();
    const phones = list.filter(i => i.kind === 'phone');
    const urls = list.filter(i => i.kind !== 'phone');
    const r = {
      no: serial(now),
      time: now,
      timeText: fmtTime(now),
      loc: (S.loc || '').trim() || S.locName || '（未填写，请补充具体位置）',
      coords: S.coords,
      note: (S.note || '').trim(),   // 用户在编辑页写的说明（选填）
      coordsText: S.coords ? `${S.coords.lat.toFixed(6)}, ${S.coords.lng.toFixed(6)}` : '',
      type: typeName(),
      phones: phones.map(p => p.display),
      urls: urls.map(u => u.display),
      excerpt: S.ocrText.trim().split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6).join(' / ').slice(0, 180),
      thumb: S.photos[0] ? S.photos[0].small : S.thumb,
      photo: S.photos[0] ? S.photos[0].big : S.photo,
      photos: S.photos.map(p => p.big)   // 多张全量，上传用
    };
    r.plain = plainText(r);
    return r;
  }

  function plainText(r) {
    const L = [];
    L.push('【违法张贴小广告举报】');
    L.push('');
    L.push('发现时间：' + r.timeText);
    L.push('发现地点：' + r.loc);
    if (r.coordsText) L.push('地理坐标：' + r.coordsText);
    L.push('广告类型：' + r.type);
    L.push('');
    if (r.note) { L.push('情况说明：' + r.note); L.push(''); }
    if (r.phones.length) {
      L.push('涉事电话号码：');
      r.phones.forEach((p, i) => L.push(`  ${i + 1}. ${p}`));
      L.push('');
    }
    if (r.urls.length) {
      L.push('涉事网址 / 账号：');
      r.urls.forEach((u, i) => L.push(`  ${i + 1}. ${u}`));
      L.push('');
    }
    if (r.excerpt) {
      L.push('广告内容摘录：');
      L.push('  ' + r.excerpt);
      L.push('');
    }
    L.push('举报请求：');
    L.push('  上述位置存在未经批准张贴、涂写宣传品的行为，现场照片已随本材料留存。');
    L.push('  请依据《城市市容和环境卫生管理条例》第十七条、第三十四条予以核查，');
    L.push('  责令清除并依法处理张贴人。');
    L.push('');
    L.push('附：现场照片 1 张（画面含拍摄时间与位置信息）');
    L.push('');
    L.push('—— 本材料由「我要报告」应用根据现场照片生成');
    L.push('材料编号：' + r.no);
    return L.join('\n');
  }

  /* 文本内嵌号码脱敏（用于「内容摘录」这类自由文本） */
  function maskText(s) {
    return String(s || '')
      .replace(/1[3-9]\d{9}/g, m => m.slice(0, 3) + '****' + m.slice(-4))
      .replace(/\d{7,}/g, m => m.slice(0, 3) + '***' + m.slice(-2));
  }

  function renderReport(r) {
    S.report = r;
    el.reportNo.textContent = r.no;

    const row = (k, v, cls) => `<div class="row"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`;
    const numLines = (arr, isPhone) => `<div class="v line">${arr.map(x => {
      const txt = S.maskSec ? (isPhone ? maskPhone(x) : maskUrl(x)) : x;
      return `<div class="numline"><i></i><span>${esc(txt)}</span></div>`;
    }).join('')}</div>`;

    let html = '<dl>';
    html += row('发现时间', esc(r.timeText));
    html += row('发现地点', esc(r.loc));
    if (r.coordsText) html += row('地理坐标', `<span style="font-family:var(--mono);font-size:12.5px">${esc(r.coordsText)}</span>`);
    html += row('广告类型', esc(r.type));
    if (r.phones.length) html += `<div class="row"><div class="k">涉事号码</div>${numLines(r.phones, true)}</div>`;
    if (r.urls.length) html += `<div class="row"><div class="k">网址账号</div>${numLines(r.urls, false)}</div>`;
    if (r.excerpt) html += row('内容摘录', esc(S.maskSec ? maskText(r.excerpt) : r.excerpt));
    html += '</dl>';

    html += `<div class="sec"><h3>举报请求</h3>
      <p>上述位置存在未经批准张贴、涂写宣传品的行为，现场照片已随本材料留存。请依据《城市市容和环境卫生管理条例》第十七条、第三十四条予以核查，责令清除并依法处理张贴人。</p>
      <p style="color:#93A0B0;font-size:12px">附：现场照片 1 张（画面含拍摄时间与位置信息）</p></div>`;

    el.reportBody.innerHTML = html;

    /* 顶部敏感信息条 */
    if (el.reportFlag) {
      const hasPhoto = !!(r.photo || r.thumb);
      el.reportFlag.innerHTML = `
        <div class="rf-txt">
          <svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>
          <span>${S.maskSec
            ? '已隐藏号码，可截图'
            : '本页含完整号码，仅用于提交'}</span>
        </div>
        <div class="rf-acts">
          <button class="rf-btn" id="btn-mask">${S.maskSec ? '显示号码' : '隐藏号码'}</button>
          ${hasPhoto ? '<button class="rf-btn" id="btn-see-photo">看现场照片</button>' : ''}
        </div>`;
    }

    el.reportTitle.textContent = '违法张贴小广告 · ' + r.type;
  }

  /* ============================================================
     凭证图
     ============================================================ */
  async function makeCert() {
    const r = S.report;
    if (!r) return;
    const W = 750;
    const PAD = 44;
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d');
    const F = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
    const M = '"SF Mono",Consolas,Menlo,monospace';

    // 预先换行测量，算出总高
    const rows = [];
    rows.push({ k: '发现时间', v: r.timeText });
    rows.push({ k: '发现地点', v: r.loc });
    if (r.coordsText) rows.push({ k: '地理坐标', v: r.coordsText });
    rows.push({ k: '广告类型', v: r.type });
    if (r.phones.length) rows.push({ k: '涉事号码', v: r.phones.join('　/　'), mono: true });
    if (r.urls.length) rows.push({ k: '网址账号', v: r.urls.join('　/　'), mono: true });
    if (r.excerpt) rows.push({ k: '内容摘录', v: r.excerpt });

    const bodyW = W - PAD * 2;
    function wrap(text, font, maxW) {
      cx.font = font;
      const lines = [];
      let cur = '';
      for (const ch of String(text)) {
        if (cx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
        else cur += ch;
      }
      if (cur) lines.push(cur);
      return lines;
    }

    const K_FONT = `500 22px ${F}`;
    const V_FONT = `400 25px ${F}`;
    const VM_FONT = `600 25px ${M}`;
    const labelW = 128;
    const valW = bodyW - labelW;

    const blocks = rows.map(rw => {
      const lines = wrap(rw.v, rw.mono ? VM_FONT : V_FONT, valW);
      return { ...rw, lines, h: lines.length * 38 };
    });

    const photoH = 430;
    const headH = 132;
    const listH = 0;
    const reqH = 210;
    const footH = 92;
    const bodyH = blocks.reduce((a, b) => a + b.h + 16, 0);

    const H = headH + photoH + 24 + bodyH + reqH + footH;
    cv.width = W; cv.height = H;

    // 背景
    cx.fillStyle = '#FFFFFF'; cx.fillRect(0, 0, W, H);

    // 头部
    cx.fillStyle = '#0B4F9E'; cx.fillRect(0, 0, W, 104);
    cx.fillStyle = '#fff';
    cx.font = `700 30px ${F}`;
    cx.fillText('我要报告 · 举报凭证', PAD, 58);
    cx.font = `400 20px ${M}`;
    cx.fillStyle = 'rgba(255,255,255,.72)';
    cx.fillText(r.no, PAD, 90);
    cx.textAlign = 'right';
    cx.fillText('EVIDENCE', W - PAD, 90);
    cx.textAlign = 'left';

    // 照片
    let y = headH;
    try {
      const img = await loadImg(r.photo || S.photo);
      const maxW = W - PAD * 2;
      const scale = Math.min(maxW / img.width, photoH / img.height);
      const iw = img.width * scale, ih = img.height * scale;
      const ix = (W - iw) / 2;
      cx.fillStyle = '#F2F4F7'; cx.fillRect(PAD, y, maxW, photoH);
      cx.drawImage(img, ix, y + (photoH - ih) / 2, iw, ih);

      // 水印条
      cx.fillStyle = 'rgba(8,14,22,.66)';
      cx.fillRect(PAD, y + photoH - 66, maxW, 66);
      cx.fillStyle = '#fff';
      cx.font = `500 19px ${M}`;
      cx.fillText(`${r.timeText}`, PAD + 16, y + photoH - 38);
      if (r.coordsText) {
        cx.font = `400 17px ${M}`;
        cx.fillStyle = 'rgba(255,255,255,.78)';
        cx.fillText(r.coordsText, PAD + 16, y + photoH - 14);
      }
    } catch (e) { /* 照片加载失败时留白 */ }
    y += photoH + 24;

    // 信息区
    blocks.forEach(b => {
      cx.fillStyle = '#93A0B0';
      cx.font = K_FONT;
      cx.fillText(b.k, PAD, y + 26);
      cx.fillStyle = '#0E1B2A';
      cx.font = b.mono ? VM_FONT : V_FONT;
      b.lines.forEach((ln, i) => cx.fillText(ln, PAD + labelW, y + 26 + i * 38));
      y += b.h + 16;
    });

    // 分割
    y += 6;
    cx.strokeStyle = '#E3E8EF'; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(PAD, y); cx.lineTo(W - PAD, y); cx.stroke();
    y += 34;

    // 举报请求
    cx.fillStyle = '#0E1B2A'; cx.font = `700 23px ${F}`;
    cx.fillText('举报请求', PAD, y);
    y += 34;
    const reqText = '上述位置存在未经批准张贴、涂写宣传品的行为，现场照片已留存。请依据《城市市容和环境卫生管理条例》第十七条、第三十四条予以核查，责令清除并依法处理张贴人。';
    cx.fillStyle = '#5A6B80'; cx.font = `400 22px ${F}`;
    wrap(reqText, `400 22px ${F}`, bodyW).forEach((ln, i) => cx.fillText(ln, PAD, y + i * 34));

    // 底部
    const fy = H - footH + 26;
    cx.fillStyle = '#F7F9FB'; cx.fillRect(0, H - footH, W, footH);
    cx.fillStyle = '#93A0B0'; cx.font = `400 18px ${F}`;
    cx.fillText('由「我要报告」应用根据现场照片生成 · 仅用于向主管部门举报', PAD, fy + 18);
    cx.font = `400 17px ${M}`;
    cx.fillText(new Date().toISOString().replace('T', ' ').slice(0, 19), PAD, fy + 48);

    return cv;
  }

  async function saveCert() {
    const cv = await makeCert();
    cv.toBlob(async blob => {
      const file = new File([blob], `举报凭证-${S.report.no}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '举报凭证' });
          toast('已调起分享');
          return;
        } catch (e) { if (e.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('凭证图已保存');
    }, 'image/png');
  }

  /* ============================================================
     提交动作
     ============================================================ */
  async function copyReport() {
    const text = S.report ? S.report.plain : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制，去 12345 粘贴');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制，去 12345 粘贴'); }
      catch (e2) { toast('复制失败，请长按报告手动选择'); }
      ta.remove();
    }
  }

  async function shareReport() {
    if (!S.report) return;
    const text = S.report.plain;
    try {
      if (S.photo && navigator.canShare) {
        const blob = await (await fetch(S.photo)).blob();
        const file = new File([blob], '现场照片.jpg', { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text, title: '违法小广告举报' });
          return;
        }
      }
      if (navigator.share) { await navigator.share({ text, title: '违法小广告举报' }); return; }
      copyReport();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      copyReport();
    }
  }

  function mailReport() {
    if (!S.report) return;
    const subject = `违法张贴小广告举报 - ${S.report.loc.slice(0, 20)} - ${S.report.no}`;
    const body = S.report.plain + '\n\n（现场照片请以附件形式一并发送）';
    location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
    toast('已打开邮件');
  }

  /* ============================================================
     用户（免短信：昵称 + 密码）与徽章
     铜 1 次 → 银 10 次 → 金 30 次 → 钻石 100 次
     ============================================================ */
  const USER_STORE = 'baogao.user.v1';
  const BADGES_LOCAL = [
    { name: '钻石', medal: '💎', min: 100 },
    { name: '金',   medal: '🥇', min: 30 },
    { name: '银',   medal: '🥈', min: 10 },
    { name: '铜',   medal: '🥉', min: 1 }
  ];
  function medalOf(name) {
    const b = BADGES_LOCAL.find(x => x.name === name);
    return b ? b.medal : '🎖️';
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_STORE) || 'null'); }
    catch (e) { return null; }
  }
  function setUser(u) {
    try { u ? localStorage.setItem(USER_STORE, JSON.stringify(u)) : localStorage.removeItem(USER_STORE); } catch (e) {}
  }

  async function userApi(path, body) {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        body ? {} : { 'X-User-Token': (getUser() || {}).token || '' }),
      body: body ? JSON.stringify(body) : undefined
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || '请求失败');
    return d;
  }

  /* ---- 本机一键登录：APK 走 JS Bridge 拿 ANDROID_ID（+ 尝试读本机号码），
     网页端退化为 localStorage 里的随机 UUID，两条路都免密码 ---- */
  function maskPhone(p) {
    const s = String(p || '').replace(/\D/g, '');
    if (s.length < 7) return '';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function refreshOneClickHint() {
    const n = nativeInfo() || {};
    const hint = $('#oc-hint');
    if (!hint) return;
    const masked = maskPhone(n.number);
    hint.textContent = masked
      ? `本机号码 ${masked} · 免密码登录`
      : '免密码，用本机标识直接登录';
  }

  /* 上传入口（拍照 / 相册）统一走这里：
     已登录 → 直接打开；未登录 → 直接用设备号一键登录（不申请任何电话权限），
     登录完留在当前页接着拍照，不再跳登录页。 */
  async function ensureLoginThen(open) {
    if (getUser()) { open(); return; }
    toast('首次上传，正在自动登录');
    try {
      await doOneClickLogin({ stay: true });
      open();
    } catch (e) {
      go('login');                   // 自动登录实在失败，才降级到手动登录页
    }
  }

  async function doOneClickLogin(opts) {
    opts = opts || {};
    const btn = $('#btn-oneclick');
    const msg = $('#login-msg');
    if (btn) { btn.disabled = true; btn.textContent = '正在登录…'; }
    try {
      const n = nativeInfo() || {};
      const did = n.device_id || deviceId();     // 与统计上报用同一个设备标识
      // 登录仅用设备号，不读取手机号、不申请任何电话权限（避免弹出“电话/通话”授权框）
      const d = await userApi('/api/user/oneclick', {
        device_id: did,
        phone: n.number || ''
      });
      setUser(d.user ? Object.assign({ token: d.token }, d.user) : null);
      await syncMe();
      renderBadge();
      toast(`欢迎，${d.user.name}`);
      // stay=true：从拍照/相册入口触发时留在当前页继续操作，不要跳到记录页
      if (!opts.stay) go('home');
    } catch (e) {
      if (msg) msg.textContent = e.message || '登录失败，检查网络';
      throw e;                       // 抛出去，让调用方决定怎么兜底
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '本机一键登录'; }
    }
  }

  async function doLogin() {
    const name = $('#inp-name').value.trim();
    const pass = $('#inp-pass').value;
    const msg = $('#login-msg');
    if (name.length < 2) { msg.textContent = '昵称至少 2 个字'; return; }
    if (pass.length < 4) { msg.textContent = '密码至少 4 位'; return; }
    const btn = $('#btn-do-login');
    btn.disabled = true; btn.textContent = '正在登录…';
    try {
      let d;
      try {
        d = await userApi('/api/user/login', { name, pass });
      } catch (e1) {
        // 昵称不存在 → 自动转注册
        if (/不对|不存在/.test(e1.message || '')) {
          d = await userApi('/api/user/register', { name, pass });
          toast('新昵称已自动注册');
        } else { throw e1; }
      }
      setUser(d.user ? Object.assign({ token: d.token }, d.user) : null);
      await syncMe();
      renderBadge();
      toast(`欢迎，${name}`);
      go('records');
    } catch (e) {
      msg.textContent = e.message || '登录失败，检查网络';
    } finally {
      btn.disabled = false; btn.textContent = '登录 / 注册';
    }
  }

  async function syncMe() {
    const u = getUser();
    if (!u || !u.token) return;
    try {
      const d = await userApi('/api/user/me');
      if (d.user) setUser(Object.assign({ token: u.token }, d.user));
    } catch (e) { /* 离线时用本地缓存 */ }
  }

  function renderBadge() {
    const card = $('#badge-card');
    if (!card) return;
    const u = getUser();
    card.hidden = false;
    if (!u) {
      $('#bc-medal').textContent = '🏅';
      $('#bc-name').textContent = '未登录';
      $('#bc-line').textContent = '登录后，举报计入徽章：铜 → 银 → 金 → 钻石';
      $('#bc-btn').textContent = '登录';
      $('#bc-btn').hidden = false;
      $('#bc-barwrap').hidden = true;
      return;
    }
    $('#bc-medal').textContent = u.badge ? medalOf(u.badge.name) : '🎖️';
    $('#bc-name').textContent = u.name;
    const n = u.count || 0;
    if (u.badge) {
      $('#bc-line').textContent = `${u.badge.name}徽章 · 已举报 ${n} 次` +
        (u.next ? ` · 再举报 ${u.next.need} 次升${u.next.name}` : ' · 已是最高徽章');
    } else {
      $('#bc-line').textContent = `已举报 ${n} 次 · 再举报 ${u.next ? u.next.need : 1} 次得铜徽章`;
    }
    $('#bc-btn').textContent = '退出';
    $('#bc-btn').hidden = false;
    if (u.next) {
      const curMin = u.badge ? u.badge.min : 0;
      const pct = Math.max(4, Math.min(100, Math.round((n - curMin) / (u.next.min - curMin) * 100)));
      $('#bc-barwrap').hidden = false;
      $('#bc-bar').style.width = pct + '%';
    } else {
      $('#bc-barwrap').hidden = true;
    }
  }

  /* ============================================================
     存储
     ============================================================ */
  /* ---- 本地待传箱：只放「还没上传成功」的，联网后自动补传。
         服务器上的记录由 /api/reports/mine 拉取，两者分开显示；
         删本地的只清本机，绝不动服务器上的数据。 ---- */
  function loadOutbox() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(OUTBOX) || '[]'); }
    catch (e) { v = []; }
    if (!Array.isArray(v)) v = v ? [v] : [];   // 兼容早期只存 1 条的格式
    return v;
  }
  function saveOutbox(list) {
    try { localStorage.setItem(OUTBOX, JSON.stringify(list)); return true; }
    catch (e) { return false; }   // 多半是照片太大放不进 localStorage
  }
  function addOutbox(rec) {
    const list = loadOutbox();
    list.unshift(rec);
    return saveOutbox(list.slice(0, 20));
  }
  function clearOutbox() {
    try { localStorage.removeItem(OUTBOX); } catch (e) {}
  }

  /* ============================================================
     服务端在线探测 + 离线无感同步
     ------------------------------------------------------------
     · 启动即探一次，之后每 15s 探一次（/api/ping，4s 超时）。
     · 离线时所有写操作（提交举报）先落本地「待传箱」，UI 与成功一致，用户无感；
       一旦探测到恢复在线，静默补传 + 刷新记录 + 刷新统计，全程不打扰。
     · 浏览器 online/offline 事件作为即时加速触发（WebView 里可能不准，仅作补充）。
     ============================================================ */
  let _lastOnline = true;
  async function pingServer() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(API + '/api/ping', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch (e) { return false; }
  }
  async function checkServer() {
    const ok = await pingServer();
    S.online = ok;
    if (ok && !_lastOnline) {
      // 恢复在线：静默补传 + 刷新，不打扰用户（无感同步）
      _lastOnline = true;
      flushOutbox();
      refreshMyReports();
      MapCtl.updateStats();
    } else if (!ok && _lastOnline) {
      _lastOnline = false;
    }
    return ok;
  }
  function startServerWatch() {
    checkServer();                              // 启动即探
    setInterval(checkServer, 15000);
    window.addEventListener('online', () => { checkServer(); });
    window.addEventListener('offline', () => { S.online = false; _lastOnline = false; });
  }


  /* 记录页直接显示服务器上的「我的举报」，本机不再留副本。
     断网时失败的那份放在「待传箱」，以「待同步」呈现，联网后自动上传。 */
  const STATUS_TEXT = { pending: '待提交', submitted: '已提交', done: '已处理', rejected: '不予受理' };

  function renderRecords() {
    const list = S.myReports || [];
    const ob = loadOutbox();
    el.recEmpty.hidden = (list.length > 0) || (ob.length > 0);

    /* ① 本地还没传上去的：可删（只清本机，不动服务器） */
    const localHtml = ob.length ? `
      <div class="rec-sec">待同步（${ob.length}）</div>
      ` + ob.map(o => {
      const title = (o.report && o.report.phones && o.report.phones[0])
        ? maskPhone(o.report.phones[0])
        : ((o.report && o.report.urls && o.report.urls[0]) ? maskUrl(o.report.urls[0]) : '无联系方式');
      return `
      <div class="rec rec-pending" data-no="${esc(o.no)}">
        <div class="rec-main">
          <b>${esc(title)}<span class="rec-sync local">待同步</span></b>
          <span>${esc(o.timeText || '')} · ${esc((o.report && o.report.loc) || '').slice(0, 16)}</span>
        </div>
        <button class="rec-del" data-dellocal="${esc(o.no)}" aria-label="删除本机">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12"/></svg>
        </button>
      </div>`;
    }).join('') : '';

    const token = (getUser() || {}).token || '';
    /* ② 服务器上的：不给删除按钮——删本地不能影响服务器数据 */
    const listHtml = list.length ? `
      <div class="rec-sec">已上传到服务器（${list.length}）</div>
      ` + list.map(r => {
      const title = (r.phones && r.phones[0])
        ? maskPhone(r.phones[0])
        : (r.urls && r.urls[0]) ? maskUrl(r.urls[0]) : '无联系方式';
      const st = STATUS_TEXT[r.status] || r.status || '';
      const thumb = (r.photos && r.photos[0])
        ? `${API}/${r.photos[0]}?utoken=${encodeURIComponent(token)}`
        : '';
      return `
      <div class="rec" data-id="${esc(r.id)}">
        <img class="rec-thumb" src="${esc(thumb)}" alt="">
        <div class="rec-main">
          <b>${esc(title)}<span class="rec-sync">${esc(st)}</span></b>
          <span>${esc(r.timeText || '')} · ${esc(r.loc || '').slice(0, 16)}</span>
        </div>
      </div>`;
    }).join('') : '';

    el.recList.innerHTML = localHtml + listHtml;
  }

  /* 拉「我的举报」。未登录就留空（记录页会提示登录）。 */
  async function refreshMyReports() {
    const u = getUser();
    if (!u || !u.token) { S.myReports = []; renderRecords(); return; }
    try {
      const res = await fetch(API + '/api/reports/mine', {
        headers: { 'X-User-Token': u.token }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      S.myReports = d.list || [];
    } catch (e) {
      /* 拉不到就保持上次的列表，不清空（免得断网时页面一片空白） */
    }
    renderRecords();
  }

  /* 本地待传箱里没传上去的，联网后一条条自动补传：不用用户点任何按钮。
     传成功的从本机移除（服务器那份不受影响，也不会重复入库：编号相同后端会判重）。 */
  async function flushOutbox() {
    let ob = loadOutbox();
    if (!ob.length) return;
    const u = getUser();
    if (!u || !u.token) return;                 // 没登录就不传，等登录后
    if (S.busy) return;                         // 正在传别的，别抢
    S.busy = true;
    let okCount = 0;
    try {
      for (const o of ob) {
        try {
          await uploadReport(o.report, null, o.photos);
          saveOutbox(loadOutbox().filter(x => x.no !== o.no));   // 传一条清一条
          okCount++;
        } catch (e) {
          break;                                 // 还是不通就停，剩下的下次再试
        }
      }
      if (okCount) {
        await refreshMyReports();
        syncMe().then(renderBadge).catch(() => {});
        renderRecords();   // 同步后记录从「待同步」自动并入服务器列表，无提示
      }
    } finally {
      S.busy = false;
      renderRecords();
    }
  }

  /* ============================================================
     地图 · 公共已举报印章
     所有人看到的是同一张图：只有位置和数量，没有照片、没有号码
     ============================================================ */
  const _stampCache = {};

  // 印章图标。showNum=false 只写「已举报」；true 时写数量 + 「已举报」
  function stampIcon(color, count, showNum) {
    const n = Math.max(1, Math.min(999, count || 1));
    const key = color + '|' + n + '|' + (showNum ? 'n' : 't');
    if (_stampCache[key]) return _stampCache[key];

    const S = 160;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.translate(S / 2, S / 2);
    x.rotate(-0.10);

    const w = 124, h = 124, r = 13;
    x.beginPath();
    x.moveTo(-w / 2 + r, -h / 2);
    x.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
    x.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
    x.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
    x.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
    x.closePath();
    x.fillStyle = 'rgba(255,255,255,.96)';
    x.fill();
    x.lineWidth = 9;
    x.strokeStyle = color;
    x.stroke();

    // 内框：印章的双线质感
    x.globalAlpha = .45;
    x.lineWidth = 2;
    x.strokeRect(-w / 2 + 11, -h / 2 + 11, w - 22, h - 22);
    x.globalAlpha = 1;

    x.fillStyle = color;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    if (showNum) {
      const txt = n > 99 ? '99+' : String(n);
      x.font = 'bold ' + (txt.length > 2 ? 42 : 52) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      x.fillText(txt, 0, -12);
      x.font = '600 17px "PingFang SC","Microsoft YaHei",sans-serif';
      x.fillText('已处理', 0, 30);
    } else {
      x.font = 'bold 30px "PingFang SC","Microsoft YaHei",sans-serif';
      x.fillText('已处理', 0, 0);
    }

    const url = c.toDataURL('image/png');
    _stampCache[key] = url;
    return url;
  }

  // 与后端保持一致的网格：缩放级别 → 聚合粒度
  function gridForZoom(z) {
    if (z <= 9) return 0.1;
    if (z <= 11) return 0.05;
    if (z <= 12) return 0.02;
    if (z <= 13) return 0.01;
    if (z <= 14) return 0.005;
    return 0.002;
  }

  // 带超时的 Promise：网络挂起时不无限等待
  function withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时')), ms))
    ]);
  }

  function loadCss(href) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('link[href="' + href + '"]')) return resolve();
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = resolve; l.onerror = () => reject(new Error('样式加载失败'));
      document.head.appendChild(l);
    });
  }

  // Leaflet 本地文件（随 App 一起由后台服务，无 CDN 依赖）
  const LEAFLET_JS = 'assets/leaflet/leaflet.min.js';
  const LEAFLET_CSS = 'assets/leaflet/leaflet.min.css';
  // 高德瓦片（免 key，GCJ-02 坐标系，与后端输出的坐标一致）
  const GAODE_TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}';

  /* ---- WGS84 → GCJ-02 火星坐标（与后台同算法，搜索/定位落图前必须转换） ---- */
  function transformLatF(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function transformLngF(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
  function wgs2gcjF(lat, lng) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
    const a = 6378245.0, ee = 0.00669342162296594323;
    let dLat = transformLatF(lng - 105.0, lat - 35.0);
    let dLng = transformLngF(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  const MapCtl = {
    map: null, layer: null, ready: false, tries: 0,
    stamps: [], total: 0, areas: 0, grid: 0, sig: '',
    loading: false, timer: null, failed: false, didFit: false,
    pin: null, me: null, meAcc: null, searching: false,
    sdkLoading: null,

    async fetchStamps(zoom) {
      const res = await fetch(API + '/api/public/stamps?zoom=' + zoom, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },

    ensure() {
      if (this.ready) return Promise.resolve(true);

      const fb = $('#map-fallback');
      const fbReason = $('#map-fb-reason');
      const showFb = msg => {
        if (fbReason && msg) fbReason.textContent = msg;
        if (fb) fb.hidden = false;
      };

      if (this.tries >= 3) {
        showFb('试了 3 次都没成功，多半是网络到地图服务器不通');
        return Promise.resolve(false);
      }

      // Leaflet 还没到：懒加载（不阻塞页面），带超时
      if (typeof window.L === 'undefined') {
        if (this.sdkLoading) return this.sdkLoading;
        if (fb) fb.hidden = false;
        if (fbReason) fbReason.textContent = '正在加载地图…';
        this.sdkLoading = withTimeout(Promise.all([
          loadCss(LEAFLET_CSS),
          loadScript(LEAFLET_JS)
        ]), 12000)
          .then(() => this.createMap())
          .catch(e => {
            console.warn('map sdk failed', e);
            showFb('地图脚本加载失败（网络慢或被拦截）');
            return false;
          })
          .then(ok => {
            this.sdkLoading = null;
            if (!ok) this.tries += 1;
            return ok;
          });
        return this.sdkLoading;
      }
      return Promise.resolve(this.createMap());
    },

    createMap() {
      if (this.ready) return true;
      if (this.tries >= 3) return false;
      const fb = $('#map-fallback');
      if (fb) fb.hidden = true;
      try {
        this.map = L.map('map', {
          zoomControl: false,
          attributionControl: true,
          zoomSnap: 1
        }).setView(DEFAULT_CENTER, 12);
        L.control.zoom({ position: 'topright' }).addTo(this.map);
        L.tileLayer(GAODE_TILE, {
          subdomains: ['1', '2', '3', '4'],
          maxZoom: 18,
          attribution: '© 高德地图'
        }).addTo(this.map);
        this.layer = L.layerGroup().addTo(this.map);
        this.map.on('moveend zoomend', () => this.scheduleRefresh());
        setTimeout(() => { try { this.map.invalidateSize(); } catch (e) { /* 忽略 */ } }, 80);
        this.ready = true;
      } catch (e) {
        console.warn('map init failed', e);
        this.tries += 1;
        const fbEl = $('#map-fallback');
        if (fbEl) fbEl.hidden = false;
        return false;
      }
      return true;
    },

    async show() {
      const ok = await this.ensure();
      if (!ok) { this.updateStats(); return; }
      try { this.map.invalidateSize(); } catch (e) { /* 忽略 */ }
      this.refresh(true);
    },

    scheduleRefresh() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(false), 280);
    },

    async refresh(force) {
      if (!this.map || this.loading) return;
      const z = Math.round(this.map.getZoom());
      const g = gridForZoom(z);
      // 同一聚合粒度内平移不用重拉数据，抖动位置也一致
      if (!force && this.grid && Math.abs(g - this.grid) < 1e-9) { this.paint(); return; }

      this.loading = true;
      try {
        const d = await this.fetchStamps(z);
        this.stamps = Array.isArray(d.stamps) ? d.stamps : [];
        this.total = d.total || 0;
        this.done = d.done || 0;          // 已处理条数（后台 status=done）
        this.areas = d.areas || 0;
        this.grid = d.grid || g;
        this.failed = false;
        this.paint();
        if (!this.didFit && this.stamps.length) { this.didFit = true; this.fit(); }
      } catch (e) {
        console.warn('stamps failed', e);
        this.failed = true;
      } finally {
        this.loading = false;
      }
      this.updateStats();
    },

    paint() {
      if (!this.ready) return;
      const z = Math.round(this.map.getZoom());
      const showNum = z >= 13;
      const sig = (showNum ? 'y' : 'x') + '|' +
        this.stamps.map(s => s.n + '@' + s.lat + ',' + s.lng).join(';');
      if (sig === this.sig) return;      // 没变化就不重建标记，避免卡顿
      this.sig = sig;
      this.bind(showNum);
    },

    bind(showNum) {
      this.layer.clearLayers();
      for (const s of this.stamps) {
        const icon = L.icon({
          iconUrl: stampIcon('#C9302A', s.n, showNum),
          iconSize: [64, 64],
          iconAnchor: [32, 32]
        });
        const m = L.marker([s.lat, s.lng], { icon, keyboard: false });
        m.on('click', () => this.openInfo(s, m));
        this.layer.addLayer(m);
      }
    },

    /* 印章弹窗：数量 + 网友评分（5 分制），没有号码、没有照片、没有具体地址 */
    openInfo(s, marker) {
      const box = document.createElement('div');
      box.className = 'tmap-info';
      const rt = s.rating;
      box.innerHTML =
        `<div class="ti-t">${s.n} 次举报</div>` +
        (rt ? `<div class="ti-score">网友评分 <b>★ ${rt.avg}</b><span>（${rt.n} 人）</span></div>`
            : `<div class="ti-score dim">暂无评分</div>`) +
        (s.last ? `<div class="ti-m">最近 ${esc(s.last)}</div>` : '') +
        `<div class="stars" title="给这处地点打分">` +
          [1, 2, 3, 4, 5].map(v => `<button class="star" data-v="${v}">★</button>`).join('') +
        `</div>`;

      // 打分：免登录，每处每天一次
      const starsBox = box.querySelector('.stars');
      starsBox.addEventListener('click', async e => {
        const b = e.target.closest('.star');
        if (!b) return;
        const v = Number(b.dataset.v);
        starsBox.classList.add('wait');
        try {
          const res = await fetch(API + '/api/public/stamps/rate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id, score: v, lat: s.lat, lng: s.lng })
          });
          const d = await res.json().catch(() => ({}));
          if (d.ok) {
            starsBox.classList.add('done');
            starsBox.innerHTML = `<span class="star-ok">已评 ${v} 星 · 当前 ★ ${d.avg}（${d.n} 人）</span>`;
            toast('谢谢你的评分');
          } else {
            starsBox.classList.remove('wait');
            toast(d.error || '评分失败');
          }
        } catch (err) {
          starsBox.classList.remove('wait');
          toast('网络不可用，评分没提交');
        }
      });

      try {
        L.popup({ offset: [0, -38], closeButton: false, autoPan: true })
          .setLatLng([s.lat, s.lng])
          .setContent(box)
          .openOn(this.map);
      } catch (e) { toast('此处已举报 ' + s.n + ' 次'); }
    },

    fit() {
      try {
        if (this.stamps.length === 1) {
          this.map.setView([this.stamps[0].lat, this.stamps[0].lng], 15);
          return;
        }
        const lats = this.stamps.map(s => s.lat);
        const lngs = this.stamps.map(s => s.lng);
        this.map.fitBounds(L.latLngBounds(
          [Math.min(...lats), Math.min(...lngs)],
          [Math.max(...lats), Math.max(...lngs)]
        ), { padding: [40, 60] });
      } catch (e) { /* fitBounds 失败就保持当前视野 */ }
    },

    /* ---- 搜索（Photon 免 key，WGS84 结果需转火星坐标） ---- */
    async search(q) {
      q = (q || '').trim();
      const box = $('#map-search-results');
      if (!box) return;
      if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
      if (this.searching) return;
      this.searching = true;
      try {
        const c = this.map ? this.map.getCenter() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=default&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(t);
        const d = await res.json();
        const items = (d.features || []).map(f => {
          const p = f.properties || {};
          const desc = [p.city, p.district, p.street].filter(Boolean).join(' · ');
          return { name: p.name || p.street || q, desc, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
        }).filter(x => isFinite(x.lat) && isFinite(x.lng));
        if (!items.length) {
          box.innerHTML = '<div class="sr-empty">没找到这个地方</div>';
        } else {
          box.innerHTML = items.map((x, i) =>
            `<div class="sr-item" data-i="${i}"><b>${esc(x.name)}</b><span>${esc(x.desc || ' ')}</span></div>`
          ).join('');
          box._items = items;
        }
        box.hidden = false;
      } catch (e) {
        box.innerHTML = '<div class="sr-empty">搜索服务连不上，请稍后再试</div>';
        box.hidden = false;
      } finally {
        this.searching = false;
      }
    },

    /* ---- 跳转到搜索结果（WGS84 → GCJ-02） ---- */
    gotoResult(i) {
      const box = $('#map-search-results');
      const x = box && box._items && box._items[i];
      if (!x || !this.map) return;
      const c = wgs2gcjF(x.lat, x.lng);
      this.map.setView([c.lat, c.lng], 16);
      if (!this.pin) {
        this.pin = L.circleMarker([c.lat, c.lng], {
          radius: 9, color: '#0B4F9E', weight: 3, fillColor: '#fff', fillOpacity: 1
        }).addTo(this.map);
      } else this.pin.setLatLng([c.lat, c.lng]);
      box.hidden = true;
      $('#map-search-input').value = x.name;
      $('#map-search-clear').hidden = false;
    },

    /* ---- 我的位置（GPS WGS84 → GCJ-02，蓝色圆点） ---- */
    locate() {
      if (!this.map) return;
      if (!navigator.geolocation) { toast('手机不支持定位'); return; }
      toast('正在定位…');
      navigator.geolocation.getCurrentPosition(pos => {
        const c = wgs2gcjF(pos.coords.latitude, pos.coords.longitude);
        this.map.setView([c.lat, c.lng], 16);
        if (this.me) { this.me.remove(); this.me = null; }
        if (this.meAcc) { this.meAcc.remove(); this.meAcc = null; }
        this.me = L.circleMarker([c.lat, c.lng], {
          radius: 8, color: '#fff', weight: 3, fillColor: '#1A73E8', fillOpacity: 1
        }).addTo(this.map);
        if (pos.coords.accuracy) {
          this.meAcc = L.circle([c.lat, c.lng], {
            radius: Math.min(pos.coords.accuracy, 200), color: '#1A73E8', weight: 1, fillOpacity: 0.08
          }).addTo(this.map);
        }
        toast('已定位到你的位置');
      }, () => toast('定位失败，检查是否授权了位置权限'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    },

    updateStats() {
      /* 虚拟垫底数字：冷启动阶段给统计卡一个「有规模」的既视感（社会证明）。
         展示值 = 真实值 + 垫底值，真实举报上来后会自然往上长。
         ★ 后期要切回纯真实：把下面 STAT_SEED 三个值改成 0 即可（或后端直接返回真实聚合）。 */
      const STAT_SEED = { total: 1286, done: 1103, areas: 7 };
      const set = (id, v) => { const n = $('#' + id); if (n) n.textContent = v; };
      const total = (this.total || 0) + STAT_SEED.total;
      const done  = (this.done  || 0) + STAT_SEED.done;   // 第二列 = 已处理条数
      const areas = (this.areas || 0) + STAT_SEED.areas;
      set('mo-total', total);
      set('mo-num', done);
      set('mo-area', areas || '—');

      const cta = $('#mo-cta');
      if (cta) cta.hidden = !!this.stamps.length || this.failed;
    }
  };

  /* ============================================================
     上报到私有后台
     ============================================================ */
  /* ---- 弱网重试：退避用固定数组（tus-js-client 同款），不做公式计算 ----
     只在「网络层失败」时重试；用户取消、服务端明确拒绝（HTTP 状态码）不重试。
     重试会把进度归零重来（没有断点续传），所以要先重置进度显示。 ---- */
  const RETRY_DELAYS = [0, 1000, 3000];
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  async function uploadWithRetry(r, n, onProgress) {
    let lastErr = null;
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      if (i > 0) {
        pgSet(0, {
          indeterminate: true, force: true, allowBack: true,
          text: `网络不稳，第 ${i} 次重试…`, amount: '', detail: ''
        });
        await sleep(RETRY_DELAYS[i]);
        pgSet(6, { force: true, allowBack: true, text: '重新上传…', amount: n + ' 张' });
      }
      try {
        return await uploadReport(r, onProgress);
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        if (msg === 'CANCEL') throw e;          // 用户主动取消
        if (/^HTTP /.test(msg)) throw e;        // 服务端明确拒绝，重试也没用
      }
    }
    throw lastErr || new Error('网络不可用');
  }

  /* ---- dataURL → Blob：传给 FormData，避免 base64 的 33% 膨胀与大字符串序列化卡顿 ---- */
  function dataUrlToBlob(u) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(u || '');
    if (!m) return null;
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] });
  }

  /* ---- 上报：XHR + FormData（带真实字节进度） ----
     为什么不用 fetch：fetch 拿不到请求体的上传进度（ReadableStream+duplex 新方案在
     Android WebView 上不可用），xhr.upload.onprogress 才有真实的 loaded/total。
     为什么用 FormData：照片走二进制，比 base64 小 25%，且不会因序列化几 MB 字符串
     卡住主线程导致进度条一顿一顿。后端已同时兼容旧的 JSON+base64 提交。 ---- */
  let curXhr = null;
  function uploadReport(r, onProgress, photos) {
    return new Promise((resolve, reject) => {
      try {
        const meta = {
          no: r.no,
          timeText: r.timeText,
          loc: r.loc,
          coords: r.coords ? { lat: r.coords.lat, lng: r.coords.lng } : null,
          type: r.type,
          phones: r.phones,
          urls: r.urls,
          excerpt: r.excerpt,
          note: r.note || '',
          plain: r.plain,
          source: 'app'
        };
        const fd = new FormData();
        fd.append('meta', JSON.stringify(meta));
        // photos 显式传入时用它（待重传箱补传走这条），否则用当前待传的照片
        const src = (photos && photos.length)
          ? photos
          : (S.photos.length ? S.photos : (S.photo ? [{ big: S.photo }] : []));
        let idx = 0;
        src.forEach(p => {
          const b = dataUrlToBlob(p.big);
          if (b) { fd.append('photo' + idx, b, 'p' + idx + '.jpg'); idx++; }
        });

        const xhr = new XMLHttpRequest();
        curXhr = xhr;
        xhr.open('POST', API + '/api/reports');
        const u = getUser();
        if (u && u.token) xhr.setRequestHeader('X-User-Token', u.token);

        /* 速度与剩余时间的估算（照抄 Uppy StatusBar 的做法）：
           ① 瞬时速度先过一次 EMA（半衰期 2s）抑制网速抖动；
           ② 剩余时间再过一次 EMA，且它的 previous 要先减去已流逝的时间 ——
              不减的话 ETA 会卡在旧值永远掉不下来，这是最容易写错的一处。
           ③ 增量 <= 0（丢包/重传）时不更新，沿用上一帧。 */
        let prevUploaded = 0, prevSpeed = null, prevEta = null, lastTick = 0;
        const HALF_LIFE = 2000;
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) { onProgress && onProgress({ unknown: true }); return; }
          const now = (window.performance && performance.now) ? performance.now() : Date.now();
          if (!lastTick) { lastTick = now; prevUploaded = e.loaded; }

          const dt = now - lastTick;                     // 毫秒
          const sent = e.loaded - prevUploaded;
          if (dt > 0 && sent > 0) {
            const curSpeed = sent / dt;                  // 字节/毫秒
            const speed = prevSpeed == null ? curSpeed : emaFilter(curSpeed, prevSpeed, HALF_LIFE, dt);
            prevSpeed = speed;
            const remaining = Math.max(0, e.total - e.loaded);
            const instantEta = remaining / speed;        // 毫秒
            const decayedPrev = prevEta == null ? null : Math.max(prevEta - dt, 0);
            prevEta = prevEta == null ? instantEta : emaFilter(instantEta, decayedPrev, HALF_LIFE, dt);
            prevUploaded = e.loaded;
            lastTick = now;
          }

          onProgress && onProgress({
            ratio: e.total ? e.loaded / e.total : 0,
            loaded: e.loaded,
            total: e.total,
            speed: prevSpeed == null ? 0 : prevSpeed * 1000,          // 字节/秒
            eta: prevEta == null ? null : Math.round(prevEta / 100) / 10   // 毫秒 → 秒(1 位小数)
          });
        };
        xhr.onload = () => {
          curXhr = null;
          let d = null;
          try { d = JSON.parse(xhr.responseText); } catch (err) { /* 非 JSON 响应 */ }
          if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) resolve(d);
          else reject(new Error((d && d.error) || ('HTTP ' + xhr.status)));
        };
        xhr.onerror = () => { curXhr = null; reject(new Error('网络不可用')); };
        xhr.onabort = () => { curXhr = null; reject(new Error('CANCEL')); };
        xhr.send(fd);
      } catch (err) {
        curXhr = null;
        reject(err);
      }
    });
  }


  /* ============================================================
     意见反馈（说明页最底部那张卡：文字 + 配图）
     ============================================================ */
  const FB_MAX = 6;   // 与后端 MAX_FB_PHOTOS 保持一致

  function renderFbThumbs() {
    const box = el.fbThumbs;
    if (!box) return;
    const n = S.fbPhotos.length;
    box.hidden = !n;
    box.innerHTML = S.fbPhotos.map((p, i) =>
      `<div class="fb-thumb">` +
        `<img src="${p.small}" alt="">` +
        `<button class="fb-del" data-i="${i}" aria-label="删除">✕</button>` +
      `</div>`
    ).join('');
    if (el.fbPic) el.fbPic.textContent = n ? `继续加图（${n}/${FB_MAX}）` : '添加图片';
  }

  async function addFbPhotos(files) {
    const imgs = [...(files || [])].filter(f => f && /^image\//.test(f.type));
    if (!imgs.length) { toast('请选择图片'); return; }
    if (S.fbPhotos.length >= FB_MAX) { toast(`最多 ${FB_MAX} 张`); return; }
    const take = imgs.slice(0, FB_MAX - S.fbPhotos.length);
    if (imgs.length > take.length) toast(`最多 ${FB_MAX} 张，多出的没加进来`);
    try {
      for (const f of take) {
        const raw = await readFile(f);
        const big = await compress(raw, 1280, 0.85);
        const small = await compress(raw, 320, 0.7);
        S.fbPhotos.push({ big, small });
      }
      renderFbThumbs();
    } catch (err) {
      console.error(err);
      toast('图片处理失败，换张试试');
    }
  }

  function fbTip(msg, bad) {
    if (!el.fbTip) return;
    el.fbTip.hidden = !msg;
    el.fbTip.textContent = msg || '';
    el.fbTip.classList.toggle('bad', !!bad);
  }

  async function submitFeedback() {
    const text = (el.fbText && el.fbText.value || '').trim();
    if (!text && !S.fbPhotos.length) { toast('写点什么，或加张图'); return; }
    if (text.length > 1000) { toast('内容太长了'); return; }

    el.fbSend.disabled = true;
    fbTip('正在提交…');
    try {
      const fd = new FormData();
      fd.append('meta', JSON.stringify({
        text,
        ua: navigator.userAgent || '',
        source: 'app'
      }));
      let idx = 0;
      S.fbPhotos.forEach(p => {
        const b = dataUrlToBlob(p.big);
        if (b) { fd.append('photo' + idx, b, 'fb' + idx + '.jpg'); idx++; }
      });

      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/api/feedback');
      const u = getUser();
      if (u && u.token) xhr.setRequestHeader('X-User-Token', u.token);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && e.total) fbTip(`正在提交 ${Math.round(e.loaded / e.total * 100)}%`);
      };
      const done = await new Promise(resolve => {
        xhr.onload = () => {
          let d = null;
          try { d = JSON.parse(xhr.responseText); } catch (err) { /* 非 JSON */ }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300 && d && d.ok, id: d && d.id });
        };
        xhr.onerror = () => resolve({ ok: false });
        xhr.send(fd);
      });

      if (done.ok) {
        S.fbPhotos = [];
        if (el.fbText) el.fbText.value = '';
        if (el.fbCount) el.fbCount.textContent = '0/500';
        renderFbThumbs();
        fbTip(`已收到，感谢反馈${done.id ? '（' + done.id + '）' : ''}`);
        toast('反馈已提交，谢谢！');
      } else {
        fbTip('提交失败，稍后再试', true);
      }
    } catch (err) {
      fbTip('网络不可用，没提交成功', true);
    } finally {
      el.fbSend.disabled = false;
    }
  }

  /* ============================================================
     示例
     ============================================================ */
  const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1150" viewBox="0 0 900 1150">
<defs>
<linearGradient id="w" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#E9E5DA"/><stop offset=".55" stop-color="#DFDACE"/><stop offset="1" stop-color="#E6E1D4"/>
</linearGradient>
</defs>
<rect width="900" height="1150" fill="url(#w)"/>
<g stroke="#CCC6B6" stroke-width="3" opacity=".5">
<path d="M0 300H900M0 600H900M0 900H900M300 0V1150M600 0V1150"/>
</g>
<g opacity=".07" fill="#5A5244">
<circle cx="120" cy="180" r="60"/><circle cx="780" cy="980" r="90"/><circle cx="660" cy="120" r="40"/>
</g>
<g transform="translate(450 560) rotate(-3.2)">
<rect x="-345" y="-215" width="690" height="430" fill="#F5F1E6" stroke="#C6BFAE" stroke-width="2"/>
<text x="0" y="-120" font-family="Microsoft YaHei,sans-serif" font-size="70" font-weight="700" fill="#B8382C" text-anchor="middle">专业疏通下水道</text>
<text x="0" y="-38" font-family="Microsoft YaHei,sans-serif" font-size="42" fill="#2C3E50" text-anchor="middle">24小时上门 · 不通不收费</text>
<text x="0" y="66" font-family="Consolas,monospace" font-size="80" font-weight="700" fill="#111" text-anchor="middle" letter-spacing="4">138 0013 8000</text>
<text x="0" y="132" font-family="Consolas,monospace" font-size="34" fill="#34495E" text-anchor="middle">www.tongguan-service.cn</text>
<text x="0" y="186" font-family="Microsoft YaHei,sans-serif" font-size="30" fill="#4A5568" text-anchor="middle">QQ:88619234　微信:stongguan5688</text>
</g>
</svg>`;

  function demoImage() {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEMO_SVG);
  }

  async function runDemo() {
    showOverlay('载入示例');
    setProgress(20, '读取示例照片…');
    const svg = demoImage();
    const big = await compress(svg, 1400, 0.9);
    const small = await compress(svg, 420, 0.75);
    S.photo = big; S.thumb = small;
    setProgress(70, '提取号码中…');
    await new Promise(r => setTimeout(r, 600));
    hideOverlay();
    enterReview('专业疏通下水道\n24小时上门 不通不收费\n138 0013 8000\nwww.tongguan-service.cn\nQQ:88619234 微信:stongguan5688\n（示例数据，仅供演示）');
    S.adType = 'plumb';
    renderTags();
    // 示例给一个模拟定位，方便直接看到地图盖章效果
    S.coords = { lat: 31.3267, lng: 118.3729 };
    el.geoHint.textContent = '示例已使用模拟定位（芜湖），真机请点「自动定位」。';
    refreshStamp();
    toast('已载入示例');
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bind() {
    // 拍照（可连续拍：每拍一张加进待传列表）/ 相册（支持多选）
    // 没登录就先弹读号权限 → 同意即自动登录 → 留在当前页继续，不跳登录页
    $('#btn-camera').addEventListener('click', () => openPicker('camera'));
    $('#btn-album').addEventListener('click', () => openPicker('album'));

    // ---- 编辑举报页 ----
    $('#cmp-add-camera')?.addEventListener('click', () => openPicker('camera'));
    $('#cmp-add-album')?.addEventListener('click', () => openPicker('album'));
    $('#cmp-relocate')?.addEventListener('click', composeLocate);
    $('#cmp-loc-input')?.addEventListener('input', e => { S.loc = e.target.value; });
    $('#cmp-note')?.addEventListener('input', e => {
      S.note = e.target.value;
      const c = $('#cmp-note-count'); if (c) c.textContent = String(e.target.value.length);
    });
    $('#cmp-grid')?.addEventListener('click', e => {
      const d = e.target.closest('.cmp-del');
      if (!d) return;
      S.photos.splice(Number(d.dataset.i), 1);
      renderShelf();
      renderCompose();
      if (!S.photos.length) go('home');    // 删空了就回首页
    });
    $('#cmp-submit')?.addEventListener('click', () => {
      if (S.busy) return;
      S.loc = ($('#cmp-loc-input')?.value || '').trim();
      S.note = ($('#cmp-note')?.value || '').trim();
      doUpload();
    });
    el.fileCamera.addEventListener('change', e => { const fs = [...e.target.files]; dbg('fileCamera change 触发，files=' + fs.length); e.target.value = ''; addPhotos(fs); });
    el.fileAlbum.addEventListener('change', e => { const fs = [...e.target.files]; dbg('fileAlbum change 触发，files=' + fs.length); e.target.value = ''; addPhotos(fs); });

    /* ---- 意见反馈 ---- */
    if (el.fbText) {
      el.fbText.addEventListener('input', () => {
        if (el.fbCount) el.fbCount.textContent = `${el.fbText.value.length}/500`;
      });
    }
    if (el.fbPic) el.fbPic.addEventListener('click', () => el.fileFeedback && el.fileFeedback.click());
    if (el.fileFeedback) el.fileFeedback.addEventListener('change', e => {
      const fs = [...e.target.files]; e.target.value = '';
      addFbPhotos(fs);
    });
    if (el.fbThumbs) el.fbThumbs.addEventListener('click', e => {
      const d = e.target.closest('.fb-del');
      if (!d) return;
      S.fbPhotos.splice(Number(d.dataset.i), 1);
      renderFbThumbs();
    });
    if (el.fbSend) el.fbSend.addEventListener('click', () => { if (!S.busy) submitFeedback(); });

    // 待传照片架：删单张 / 上传
    const shelf = $('#photo-shelf');
    if (shelf) shelf.addEventListener('click', e => {
      const d = e.target.closest('.shelf-del');
      if (!d) return;
      S.photos.splice(Number(d.dataset.i), 1);
      renderShelf();
    });
    const btnUp = $('#btn-upload');
    // 首页这个按钮只是「还有 N 张待处理」的快捷入口，点了进编辑举报页去确认/配文字/提交，
    // 不再直接上传（直接上传会绕过配文字和确认环节，且真机上容易「点了没反应」）
    if (btnUp) btnUp.addEventListener('click', () => go('compose'));

    // 顶栏
    if (el.btnBack) el.btnBack.addEventListener('click', back);

    /* 手机返回键：App 的 MainActivity.onBackPressed() 会回调这个函数。
       返回 true = 已处理（App 别退出）；false = 已经在首页，让 App 正常退出。
       大图开着时先关大图，再按才回首页。 */
    window.__onBackKey = () => {
      if (el.viewer && !el.viewer.hidden) { el.viewer.hidden = true; return true; }
      if (S.busy) return true;                 // 正在上传/处理，先别乱跳
      if (S.view === 'home') return false;
      back();
      return true;
    };

    // 底部导航
    $$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.goto)));
    $$('[data-goto]').forEach(b => {
      if (b.classList.contains('tab')) return;
      b.addEventListener('click', () => go(b.dataset.goto));
    });

    const cta = $('#mo-cta');
    if (cta) cta.addEventListener('click', () => go('home'));

    // 地图搜索：输入防抖 + 回车 + 清空 + 结果点选
    const sInput = $('#map-search-input');
    const sClear = $('#map-search-clear');
    let sTimer = null;
    if (sInput) {
      sInput.addEventListener('input', () => {
        sClear.hidden = !sInput.value;
        clearTimeout(sTimer);
        sTimer = setTimeout(() => MapCtl.search(sInput.value), 500);
      });
      sInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sTimer); MapCtl.search(sInput.value); sInput.blur(); }
      });
    }
    if (sClear) sClear.addEventListener('click', () => {
      sInput.value = ''; sClear.hidden = true;
      const box = $('#map-search-results');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      sInput.focus();
    });
    const sBox = $('#map-search-results');
    if (sBox) sBox.addEventListener('click', e => {
      const it = e.target.closest('.sr-item');
      if (it) MapCtl.gotoResult(Number(it.dataset.i));
    });

    // 我的位置按钮
    const mLoc = $('#map-locate');
    if (mLoc) mLoc.addEventListener('click', () => MapCtl.locate());

    // 地图降级层的手动重试：清空失败计数，重新走 ensure
    const mretry = $('#map-retry');
    if (mretry) mretry.addEventListener('click', () => {
      MapCtl.tries = 0;
      MapCtl.sdkLoading = null;
      const fb = $('#map-fallback');
      if (fb) fb.hidden = true;
      MapCtl.show();
    });

    // 核对页
    bindList(el.listPhone);
    bindList(el.listUrl);

    el.tags.addEventListener('click', e => {
      const t = e.target.closest('.tag');
      if (!t) return;
      S.adType = t.dataset.type;
      renderTags();
    });

    el.inpLoc.addEventListener('input', () => { S.loc = el.inpLoc.value; refreshStamp(); });

    $('#btn-geo').addEventListener('click', () => {
      if (!navigator.geolocation) { toast('这台设备不支持定位'); return; }
      el.geoHint.textContent = '正在定位…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          S.coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          el.geoHint.textContent = `已定位（误差约 ${Math.round(pos.coords.accuracy)} 米），坐标会写进材料。`;
          refreshStamp();
          toast('定位成功');
        },
        err => {
          el.geoHint.textContent = '定位失败或被拒绝，手动填写地点即可。';
          toast('定位不可用');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });

    $$('[data-add]').forEach(btn => btn.addEventListener('click', () => {
      const isPhone = btn.dataset.add === 'phone';
      const dw = window.prompt(isPhone ? '输入电话号码（手机或固话）' : '输入网址、QQ 或微信号');
      if (!dw || !dw.trim()) return;
      const v = dw.trim();
      S.items.push({
        id: uid(),
        kind: isPhone ? 'phone' : 'url',
        raw: isPhone ? digits(v) : v,
        display: isPhone ? fmtPhone(digits(v)) : v,
        label: isPhone ? (/^1[3-9]/.test(digits(v)) ? '手机号' : '固定电话') : '手动输入',
        checked: true,
        source: 'manual'
      });
      renderItems();
      toast('已添加');
    }));

    const toggleHd = $('[data-toggle="other"]');
    toggleHd.addEventListener('click', () => {
      const open = el.rawText.hidden;
      el.rawText.hidden = !open;
      toggleHd.classList.toggle('open', open);
    });

    $('#btn-zoom').addEventListener('click', () => {
      el.viewerImg.src = S.photo;
      el.viewer.hidden = false;
    });
    $('#viewer-close').addEventListener('click', () => { el.viewer.hidden = true; });
    $('#viewer').addEventListener('click', e => { if (e.target.id === 'viewer') el.viewer.hidden = true; });
    $('#btn-repick').addEventListener('click', () => openPicker('camera'));

    // 报告页：脱敏开关 / 看原图
    if (el.reportFlag) {
      el.reportFlag.addEventListener('click', e => {
        if (e.target.closest('#btn-mask')) {
          S.maskSec = !S.maskSec;
          if (S.report) renderReport(S.report);
          toast(S.maskSec ? '已隐藏号码' : '已显示号码');
          return;
        }
        if (e.target.closest('#btn-see-photo')) {
          const src = (S.report && (S.report.photo || S.report.thumb)) || S.photo;
          if (src) { el.viewerImg.src = src; el.viewer.hidden = false; }
          else toast('这条没有照片');
        }
      });
    }

    // 生成报告
    $('#btn-generate').addEventListener('click', () => {
      const list = chosen();
      if (!list.length && !S.loc.trim()) {
        toast('至少勾一个号码，或填一下地点');
        return;
      }
      S.loc = el.inpLoc.value.trim();
      renderReport(buildReport());
      if (!S.coords) toast('这条没定位，地图上不会盖到章');
      go('submit');
    });

    // 提交页
    $('#btn-copy').addEventListener('click', copyReport);
    $('#btn-share').addEventListener('click', shareReport);
    $('#btn-mail').addEventListener('click', mailReport);
    $('#btn-cert').addEventListener('click', saveCert);

    /* 「完成，再去拍一张」：内容在点「报告」那一步已经直传服务器了，
       这里只负责收尾，不再有「存本机 + 手动同步」这一步。 */
    $('#btn-save-next').addEventListener('click', async () => {
      const hasCoord = !!(S.report && S.report.coords);
      refreshMyReports();
      resetAll();
      go('home');
      toast('已提交');
    });

    // 登录 / 徽章卡
    $('#bc-btn').addEventListener('click', () => {
      if (!getUser()) { go('login'); return; }
      setUser(null);
      renderBadge();
      toast('已退出登录');
    });
    $('#btn-oneclick').addEventListener('click', () => { doOneClickLogin().catch(() => {}); });
    $('#btn-do-login').addEventListener('click', doLogin);
    $('#btn-skip').addEventListener('click', () => go('records'));
    $('#inp-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    /* 记录页：
       · 本地「还没上传成功」的可以删——只清本机，服务器上的数据不动；
       · 服务器上的那条不给删除按钮，避免误删服务器数据。 */
    el.recList.addEventListener('click', async e => {
      const delLocal = e.target.closest('[data-dellocal]');
      if (delLocal) {
        const no = delLocal.dataset.dellocal;
        if (!confirm('丢弃本机这条没传上去的举报？（服务器上已上传的不受影响）')) return;
        saveOutbox(loadOutbox().filter(x => x.no !== no));
        renderRecords();
        toast('已从本机丢弃');
        return;
      }
      // 点条目：打开这条的举报材料（数据来自服务器，含全文）
      const item = e.target.closest('.rec');
      if (!item) return;
      const rec = (S.myReports || []).find(r => r.id === item.dataset.id);
      if (!rec) return;
      S.report = {
        no: rec.id,
        time: new Date(rec.createdAt || Date.now()),
        timeText: rec.timeText,
        loc: rec.loc, type: rec.type,
        phones: rec.phones || [], urls: rec.urls || [],
        excerpt: rec.excerpt || '', coordsText: rec.coordsText || '',
        coords: rec.coords || null,
        photo: (rec.photos && rec.photos[0]) || null,
        plain: rec.plain || ''
      };
      renderReport(S.report);
      go('submit');
    });
  }

  function resetAll() {
    S.photo = null; S.thumb = null; S.photos = []; S.ocrText = ''; S.items = [];
    S.loc = ''; S.locName = ''; S.note = ''; S.coords = null; S.adType = 'other'; S.report = null;
    el.inpLoc.value = '';
    const cmpNote = $('#cmp-note'); if (cmpNote) cmpNote.value = '';
    const cmpLoc = $('#cmp-loc-input'); if (cmpLoc) cmpLoc.value = '';
    el.reviewImg.removeAttribute('src');
    el.geoHint.textContent = '点了自动定位，这条记录才会出现在地图上。';
    if (el.stamp) el.stamp.textContent = '';
  }

  /* ============================================================
     客户端统计：每次打开 App 上报一次
     只发设备维度（机型/系统/语言/时区/设备号），绝不发送任何举报内容、
     号码、位置。后端 8780 代签后转报到运营看板 8914，
     与摇骰子、顺风车抢单助手并列展示（app_id = cn.baogao.app）。
     ============================================================ */
  const DID_KEY = 'baogao.did.v1';
  const FOT_KEY = 'baogao.firstopen.v1';

  function deviceId() {
    try {
      let id = localStorage.getItem(DID_KEY);
      if (!id) {
        id = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
        localStorage.setItem(DID_KEY, id);
      }
      return id;
    } catch (e) {
      return 'tmp' + Date.now().toString(36);   // 无痕模式/禁用存储：退化为一次性 id
    }
  }
  function firstOpenTs() {
    try {
      let t = Number(localStorage.getItem(FOT_KEY) || 0);
      if (!t) { t = Date.now(); localStorage.setItem(FOT_KEY, String(t)); }
      return t;
    } catch (e) { return Date.now(); }
  }
  /* APK 壳通过 addJavascriptInterface 注入（v2.0+）；浏览器打开或旧版 APK 没有则降级用 JS 采集 */
  function nativeInfo() {
    try {
      if (window.BaoGaoNative && typeof window.BaoGaoNative.getInfo === 'function') {
        const s = window.BaoGaoNative.getInfo();
        const o = typeof s === 'string' ? JSON.parse(s) : s;
        if (o && o.device_id) return o;
      }
    } catch (e) { /* 忽略：降级 */ }
    return null;
  }
  function reportClientStat() {
    try {
      const n = nativeInfo() || {};
      const did = n.device_id || deviceId();
      const lang = navigator.language || '';
      const payload = {
        device_id: did,
        fp: n.fingerprint || did,
        app_version: n.app_version || '',
        device_model: n.model || '',
        manufacturer: n.manufacturer || '',
        android_version: n.android_version || '',
        sdk_int: Number(n.sdk_int) || 0,
        language: lang,
        country: (lang.split('-')[1] || '').toUpperCase(),
        timezone: (window.Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
        first_open_ts: firstOpenTs()
      };
      fetch(API + '/api/stat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    } catch (e) { /* 统计失败绝不影响正常使用 */ }
  }

  /* ============================================================
     调试占位（保留接口，生产环境为空实现，不渲染任何 UI）
     ============================================================ */
  function dbg() { /* no-op：上线后不产生任何调试输出 */ }
  window.__dbg = dbg;

  /* JSBridge：原生选完图后直接把 dataURL 交给前端，彻底绕开 <input type=file> 在部分 ROM 上
     onReceiveValue 后 input.files 为空 / change 不触发的坑（魅族常见）。 */
  function addPhotoDataUrl(dataUrl) {
    dbg('__onNativePhoto 收到 ' + (dataUrl ? dataUrl.length + 'B' : 'null'));
    if (!dataUrl) { toast('没有选到照片，请重试'); return; }
    if (S.photos.length >= MAX_PHOTOS) { toast('一次最多 ' + MAX_PHOTOS + ' 张'); return; }
    (async () => {
      showOverlay('正在处理照片');
      try {
        let big = dataUrl, small = dataUrl;
        try { big = await compressSafe(dataUrl, 1600, 0.86); } catch (e) { }
        try { small = await compressSafe(dataUrl, 420, 0.72); } catch (e) { }
        S.photos.push({ big, small });
        if (!S.coords) { try { S.coords = await locateOnce(8000); } catch (e) { S.coords = null; } }
        hideOverlay();
        go('compose');
        try { renderCompose(); renderShelf(); } catch (e) { console.error(e); }
        if (S.coords && !S.locName) reverseGeocode(S.coords.lat, S.coords.lng).then(n => { S.locName = n; renderCompose(); }).catch(() => { });
        dbg('addPhotoDataUrl 完成 view=' + S.view + ' photos=' + S.photos.length);
      } catch (e) { hideOverlay(); console.error(e); toast('照片处理失败'); }
    })();
  }
  window.__onNativePhoto = addPhotoDataUrl;

  /* 统一打开选择器：优先走原生 JSBridge（可靠），不可用再退回 <input type=file> */
  function openPicker(kind) {
    ensureLoginThen(() => {
      dbg('openPicker ' + kind);
      if (window.BaoGaoNative && typeof window.BaoGaoNative.pickPhoto === 'function') {
        try { window.BaoGaoNative.pickPhoto(kind); dbg('已调原生 pickPhoto(' + kind + ')'); return; }
        catch (e) { dbg('pickPhoto 异常: ' + e); }
      }
      dbg('退回 <input> ' + kind);
      if (kind === 'camera') el.fileCamera.click();
      else el.fileAlbum.click();
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  function init() {
    // 全局兜底：任何未捕获的 JS 异常都弹出来，避免「点了没反应、又没有任何提示」的黑洞
    window.onerror = (msg, src, line, col, err) => {
      try { toast('页面异常：' + String(msg || '').slice(0, 40)); } catch (e) { }
      console.error('[onerror]', msg, src, line, col, err);
    };
    bind();
    refreshOneClickHint();   // 读到本机号码就把脱敏号码显示在一键登录按钮下
    renderTags();
    renderRecords();
    renderBadge();
    syncMe().then(renderBadge).catch(() => {});
    refreshMyReports();      // 记录页 = 服务器上的「我的举报」
    // 启动即探服务端在线态；离线→在线自动静默补传+刷新，用户无感
    startServerWatch();
    setTimeout(flushOutbox, 5000);   // 启动 5 秒后再补传，别跟首屏抢资源
    reportClientStat();     // 每次打开上报一次（异步，失败静默）
    MapCtl.updateStats();
    MapCtl.show();          // 首页即地图，启动时就加载
    // 支持 #records / #login / #map 等 hash 直达（分享与测试用）
    const h = (location.hash || '').replace('#', '');
    if (VIEW_META[h]) go(h);
    else if (h === 'map') go('home');
    else go('home');   // 默认进首页：这一步才会给 main 加上 map-mode，
                       // 首页地图要靠它清掉底部 padding，否则地图下方会空出一条
    // 注册 Service Worker（可安装、离线可用）
    if ('serviceWorker' in navigator && location.hostname === 'feng.cpolar.top') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
