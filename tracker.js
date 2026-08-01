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
   ============================================================ */

(function () {
  'use strict';

  /* ---------- 配置 ---------- */

  var CONFIG = {
    // 解锁完成码所需的"有效阅读时长"（秒）。两组必须相同。
    MIN_ACTIVE_SECONDS: 360,

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

  function hash32(str) {
    // FNV-1a，仅用于生成不可直接反推的短码，不作安全用途
    var h = 0x811c9dc5, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
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
        if (!en.isIntersecting) return;
        var id = en.target.id;
        if (!id || seenSections[id]) return;
        seenSections[id] = activeSeconds();
        log('section_view', id);
      });
    }, { threshold: 0.35 });

    var secs = document.querySelectorAll('section[id], .screen[id]');
    for (var i = 0; i < secs.length; i++) io.observe(secs[i]);
  }

  /* ---------- 完成码 ---------- */

  function makeCode() {
    var mins = Math.min(999, Math.floor(activeSeconds() / 60));
    var armTag = ARM === 'narrative' ? 'N' : (ARM === 'control' ? 'C' : 'X');
    var seed = ARM + '|' + PID + '|' + SESSION + '|' + mins;
    var body = hash32(seed).toString(36).toUpperCase();
    while (body.length < 6) body = '0' + body;
    body = body.slice(0, 6);
    var check = hash32(body + armTag) % 97;
    return CONFIG.CODE_PREFIX + '-' + armTag + body + '-' + pad(check, 2);
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

  /* 便于调试与数据导出：在控制台执行 TTE.dump() */
  window.TTE = {
    config: CONFIG,
    dump: function () { return payload(); },
    json: function () { return JSON.stringify(payload(), null, 2); }
  };
})();
