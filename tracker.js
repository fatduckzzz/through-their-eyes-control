/* ============================================================
   tracker.js — 曝光计时 / 事件记录 / 完成码
   Through Their Eyes · RCT instrumentation

   同一份文件同时用于实验组与对照组，保证两组的
   曝光测量方式完全一致（这是组间可比的前提）。

   接入方式：
     <body data-arm="control">   或   data-arm="narrative"
     <script src="tracker.js"></script>

   页面需包含（两组标记必须一致）：
     #gate  #gateBtn  #gateCode  #gateStatus

   参与者编号：从链接参数读取，例如
     index.html?pid=T12345
   腾讯问卷跳转外链时把答卷编号带上即可。

   ------------------------------------------------------------
   完成码 = 数据本身（无后端方案）

   本站没有后端，CONFIG.ENDPOINT 为 null，所以 localStorage 里
   的完整事件流是回收不了的。为此完成码不再是单向哈希，而是把
   关键指标编码进码里：被试把码填回问卷，数据就随之回到你手上。

     TTE-N-7K2MQF
      │  │    └── 6 位 base32：25 位数据 + 5 位校验
      │  └─────── 组别：N=叙事（实验组），C=对照组
      └────────── 前缀

   25 位数据的排布（高位在前）：
     bit 24..18  有效阅读分钟数        0–127
     bit 17..13  看过的分节数          0–31
     bit 12..8   最大滚动深度 / 4      0–25（即 0–100%）
     bit  7..5   CVD 类型              0=无 1=protan 2=deutan
                                       3=tritan 4=achro 7=未知
     bit  4..0   标志位                bit4 打开过配色工具
                                       bit3 导出过报告
                                       bit2 分析过图片
                                       bit1 系统开了减少动效
                                       bit0 预留

   实验站在运行时用 TTE.set() 上报自己的状态，例如：
     TTE.set('cvdType', 2);        // 分配到第二色盲
     TTE.set('ctoolOpened', true);
   对照组不调用这些，对应位保持 0。两组的计时与编码逻辑完全一致。

   解码脚本见 tools/decode_codes.py。
   ------------------------------------------------------------

   注意：这是纯前端方案，懂技术的人打开控制台即可伪造。它是
   依从性信号，不是防作弊机制——请与问卷里的注意力检查题合并
   判断，不要单独作为剔除依据。
   ============================================================ */

(function () {
  'use strict';

  /* ---------- 配置 ---------- */

  var CONFIG = {
    // 解锁完成码所需的"有效阅读时长"（秒）。两组必须相同。
    // 对照组正文约 7,500 中文字，精读需 19–25 分钟；实验组约 12–15 分钟。
    // 360 秒（6 分钟）对两者都过低，等于闸门形同虚设，故上调至 480。
    MIN_ACTIVE_SECONDS: 480,

    // 连续无操作超过这个秒数即暂停计时（防止挂机刷时长）
    IDLE_TIMEOUT_SECONDS: 60,

    // 后端接收地址；留 null 则只写入 localStorage，不发送
    ENDPOINT: null,

    // 完成码前缀
    CODE_PREFIX: 'TTE'
  };

  /* ---------- 基础工具 ---------- */

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function uid() {
    return Date.now().toString(36) + '-' +
      Math.floor(Math.random() * 1e9).toString(36);
  }

  /* ---------- 会话状态 ---------- */

  var ARM = (document.body && document.body.getAttribute('data-arm')) || 'unknown';
  var PID = qs('pid') || qs('PID') || '';
  var SESSION = uid();
  var STORE_KEY = 'tte.' + ARM + '.' + SESSION;

  var startedAt = Date.now();
  var activeMs = 0;          // 累计有效时长
  var lastTick = Date.now();
  var lastInput = Date.now();
  var visible = !document.hidden;
  var unlocked = false;
  var issuedCode = '';

  var events = [];
  var seenSections = {};
  var maxScrollPct = 0;

  var reducedMotion = !!(window.matchMedia &&
    matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* 由页面在运行时上报的状态。对照组不设置任何一项，全部保持默认，
     因此两组走的是同一套编码逻辑，只是对照组的这些位恒为 0。 */
  var reported = {
    cvdType: null,        // null → 编码为 7（未知/不适用）
    ctoolOpened: false,
    ctoolExported: false,
    imgAnalysed: false
  };

  var CVD_TYPES = { none: 0, protan: 1, deutan: 2, tritan: 3, achro: 4 };

  function report(key, value) {
    if (!(key in reported)) return;
    if (key === 'cvdType') {
      reported.cvdType = (typeof value === 'string')
        ? (CVD_TYPES.hasOwnProperty(value) ? CVD_TYPES[value] : null)
        : (typeof value === 'number' ? value : null);
    } else {
      reported[key] = !!value;
    }
    log('report', { key: key, value: reported[key] });
  }

  function activeSeconds() {
    return Math.floor(activeMs / 1000);
  }

  /* ---------- 事件记录 ---------- */

  function log(type, detail) {
    events.push({
      t: Date.now() - startedAt,       // 距进入页面的毫秒数
      a: activeSeconds(),              // 当时的有效时长（秒）
      type: type,
      detail: detail || null
    });
    persist();
  }

  function payload() {
    return {
      session: SESSION,
      arm: ARM,
      pid: PID,
      ua: navigator.userAgent,
      lang: navigator.language,
      screen: (window.screen ? window.screen.width + 'x' + window.screen.height : ''),
      viewport: window.innerWidth + 'x' + window.innerHeight,
      startedAt: new Date(startedAt).toISOString(),
      activeSeconds: activeSeconds(),
      wallSeconds: Math.floor((Date.now() - startedAt) / 1000),
      maxScrollPct: maxScrollPct,
      sectionsSeen: Object.keys(seenSections),
      reported: reported,
      reducedMotion: reducedMotion,
      unlocked: unlocked,
      code: issuedCode,
      events: events
    };
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload()));
    } catch (e) { /* 隐私模式下可能失败，忽略 */ }
  }

  function send(final) {
    if (!CONFIG.ENDPOINT) return;
    var body = JSON.stringify(payload());
    try {
      if (final && navigator.sendBeacon) {
        navigator.sendBeacon(CONFIG.ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else if (window.fetch) {
        fetch(CONFIG.ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: !!final
        })['catch'](function () {});
      }
    } catch (e) { /* 网络失败不影响阅读 */ }
  }

  /* ---------- 有效时长计时 ---------- */

  function tick() {
    var now = Date.now();
    var delta = now - lastTick;
    lastTick = now;

    if (delta > 5000) delta = 0;              // 休眠/切后台后的跳变，丢弃
    var idle = (now - lastInput) > CONFIG.IDLE_TIMEOUT_SECONDS * 1000;

    if (visible && !idle) activeMs += delta;

    updateGate();
  }

  function markInput() {
    lastInput = Date.now();
  }

  ['scroll', 'mousemove', 'keydown', 'touchstart', 'click', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, markInput, { passive: true });
  });

  document.addEventListener('visibilitychange', function () {
    visible = !document.hidden;
    lastTick = Date.now();
    log(visible ? 'visible' : 'hidden');
  });

  setInterval(tick, 1000);

  /* ---------- 滚动深度 ---------- */

  var scrollRaf = false;
  window.addEventListener('scroll', function () {
    if (scrollRaf) return;
    scrollRaf = true;
    requestAnimationFrame(function () {
      scrollRaf = false;
      var doc = document.documentElement;
      var total = doc.scrollHeight - window.innerHeight;
      if (total <= 0) return;
      var pct = Math.round(((window.pageYOffset || doc.scrollTop) / total) * 100);
      if (pct > maxScrollPct) {
        var before = maxScrollPct;
        maxScrollPct = Math.min(100, pct);
        [25, 50, 75, 90, 100].forEach(function (m) {
          if (before < m && maxScrollPct >= m) log('scroll_depth', m);
        });
      }
    });
  }, { passive: true });

  /* ---------- 分节停留 ---------- */

  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) markSeen(en.target.id);
      });
    }, { threshold: 0.35 });

    var secs = document.querySelectorAll('section[id], .screen[id]');
    for (var i = 0; i < secs.length; i++) io.observe(secs[i]);
  }

  /* ---------- 完成码 ---------- */

  /* base32，剔除 I L O U 以免手抄时与 1 0 混淆 */
  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function makeCode() {
    var mins     = Math.min(127, Math.floor(activeSeconds() / 60));
    var sections = Math.min(31, Object.keys(seenSections).length);
    var scroll   = Math.min(25, Math.round(maxScrollPct / 4));
    var type     = (reported.cvdType === null) ? 7 : (reported.cvdType & 7);

    var flags = (reported.ctoolOpened   ? 1 : 0) << 4 |
                (reported.ctoolExported ? 1 : 0) << 3 |
                (reported.imgAnalysed   ? 1 : 0) << 2 |
                (reducedMotion          ? 1 : 0) << 1;

    /* 25 位载荷。JS 位运算是 32 位有符号的，25+5 位仍在安全范围内。 */
    var v = (mins << 18) | (sections << 13) | (scroll << 8) | (type << 5) | flags;

    var check = 0, i;
    for (i = 0; i < 25; i += 5) check ^= (v >>> i) & 31;

    var full = ((v << 5) | check) >>> 0;   // 30 位
    var body = '';
    for (i = 25; i >= 0; i -= 5) body += ALPHABET[(full >>> i) & 31];

    var armTag = ARM === 'narrative' ? 'N' : (ARM === 'control' ? 'C' : 'X');
    return CONFIG.CODE_PREFIX + '-' + armTag + '-' + body;
  }

  /* 自解码，方便在控制台核对生成结果与 tools/decode_codes.py 是否一致 */
  function readCode(code) {
    var m = /([NCX])-([0-9A-Z]{6})\s*$/.exec(String(code).toUpperCase().replace(/\s/g, ''));
    if (!m) return null;
    var full = 0, i;
    for (i = 0; i < 6; i++) {
      var idx = ALPHABET.indexOf(m[2].charAt(i));
      if (idx < 0) return null;
      full = (full * 32) + idx;
    }
    var check = full & 31, v = Math.floor(full / 32), sum = 0;
    for (i = 0; i < 25; i += 5) sum ^= (v >>> i) & 31;
    return {
      valid: sum === check,
      arm: m[1] === 'N' ? 'narrative' : (m[1] === 'C' ? 'control' : 'unknown'),
      minutes: (v >>> 18) & 127,
      sectionsSeen: (v >>> 13) & 31,
      maxScrollPct: ((v >>> 8) & 31) * 4,
      cvdType: ['none', 'protan', 'deutan', 'tritan', 'achro', '?', '?', 'unknown'][(v >>> 5) & 7],
      ctoolOpened: !!((v >>> 4) & 1),
      ctoolExported: !!((v >>> 3) & 1),
      imgAnalysed: !!((v >>> 2) & 1),
      reducedMotion: !!((v >>> 1) & 1)
    };
  }

  var gate = document.getElementById('gate');
  var btn = document.getElementById('gateBtn');
  var codeBox = document.getElementById('gateCode');
  var status = document.getElementById('gateStatus');

  function updateGate() {
    if (!btn || unlocked) return;
    var left = CONFIG.MIN_ACTIVE_SECONDS - activeSeconds();
    if (left <= 0) {
      btn.disabled = false;
      if (status) status.textContent = '已达到最短阅读时长，可以获取完成码。';
    } else {
      btn.disabled = true;
      if (status) {
        var m = Math.floor(left / 60), s = left % 60;
        status.textContent = '还需要阅读约 ' + (m > 0 ? m + ' 分 ' : '') + pad(s, 2) + ' 秒。' +
          '（离开页面或长时间无操作时不计入）';
      }
    }
  }

  if (btn) {
    btn.addEventListener('click', function () {
      if (activeSeconds() < CONFIG.MIN_ACTIVE_SECONDS) return;
      unlocked = true;
      issuedCode = makeCode();
      btn.disabled = true;
      btn.textContent = '完成码已生成';
      if (codeBox) {
        codeBox.style.display = 'block';
        codeBox.textContent = issuedCode;
      }
      if (status) status.textContent = '请复制上方完成码，返回问卷填写。有效阅读时长：' +
        Math.floor(activeSeconds() / 60) + ' 分 ' + pad(activeSeconds() % 60, 2) + ' 秒。';
      log('code_issued', issuedCode);
      send(false);
    });
  }

  /* ---------- 生命周期 ---------- */

  log('page_view', { referrer: document.referrer || null });
  updateGate();

  window.addEventListener('pagehide', function () { log('page_exit'); send(true); });
  window.addEventListener('beforeunload', function () { persist(); });

  /* 单页应用（实验站）一次只显示一屏，IntersectionObserver 看不到被
     display:none 隐藏的其他屏。实验站在 show() 里调用 TTE.seen(id) 补记，
     对照组是长页面，靠 IntersectionObserver 自动记录，两边最终都汇入
     seenSections，编码方式一致。 */
  function markSeen(id) {
    if (!id || seenSections[id]) return;
    seenSections[id] = activeSeconds();
    log('section_view', id);
  }

  /* 页面用 TTE.set() 上报状态；TTE.dump()/decode() 便于调试与自查 */
  window.TTE = {
    config: CONFIG,
    set: report,
    seen: markSeen,
    dump: function () { return payload(); },
    json: function () { return JSON.stringify(payload(), null, 2); },
    preview: function () { return makeCode(); },
    decode: readCode
  };
})();
