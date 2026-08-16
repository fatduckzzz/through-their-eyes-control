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

     TTE-N-7K2MQFH
      │  │    └── 7 位 base32：30 位数据 + 5 位校验
      │  └─────── 组别：N=叙事（实验组），C=对照组
      └────────── 前缀

   30 位数据的排布（高位在前）：
     bit 29..22  有效阅读时长 / 15 秒  0–255（最长 63 分 45 秒）
     bit 21..16  挂钟时长（分钟）      0–63
     bit 15..11  看过的分节数          0–31
     bit 10..7   滚动深度              0–15 档（× 100/15 ≈ 百分比）
     bit  6..4   CVD 类型              0=无 1=protan 2=deutan
                                       3=tritan 4=achro 7=未知
     bit     3   系统开了减少动效
     bit  2..0   预留

   为什么同时存两种时长：**挂钟时长 − 有效时长 = 被试离开或发呆的时间**。
   有效 8 分 / 挂钟 9 分，是一口气读完；有效 8 分 / 挂钟 45 分，是开着
   页面去干别的了。两者的效应可能不同，光看有效时长看不出来。

   有效时长按 15 秒一档而不是按分钟：分钟精度对剂量—反应分析太粗，
   5 分 05 秒和 5 分 55 秒会被记成同一个数。

   实验站在运行时用 TTE.set() 上报自己的状态：
     TTE.set('cvdType', 2);        // 分配到第二色盲
   对照组不调用，对应位保持"未知"。两组的计时与编码逻辑完全一致。

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
    /* 解锁完成码所需的"有效阅读时长"（秒）。两组必须相同。

       设成 5 分钟，而不是按"读完全文需要多久"来定。理由是闸门设高会
       把没读够的人挡在门外，他们多半直接退出而不是回去继续读——流失
       因此是选择性的，会偏样本。既然完成码里已经记了真实时长，就不必
       靠闸门去强制，把剔除留到分析阶段做（规则请预注册）。
       闸门在这里只起一个作用：挡住点开就跳过的人。 */
    MIN_ACTIVE_SECONDS: 300,

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
    correct: 0,           // 场景答对数（对照组无场景，恒为 0）
    guesses: 0,           // 场景作答数
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
    } else if (key === 'correct' || key === 'guesses') {
      /* 计数字段要按数值存。这里原本对 cvdType 之外的一切都做 !!value，
         场景答对数 9 会被压成 true，进码时又变回 1——刚加进来的计数
         等于白记。 */
      reported[key] = Math.max(0, value | 0);
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
    /* 有效时长按 15 秒一档存，不是按分钟。

       分钟精度对剂量—反应分析太粗：读了 5 分 05 秒和 5 分 55 秒会被
       记成同一个数。15 秒一档、8 位，最长记到 63 分 45 秒，够用。 */
    var activeQ  = Math.min(255, Math.round(activeSeconds() / 15));

    /* 挂钟时长另存一份。它减去有效时长 = 被试离开页面或发呆的时间，
       这个差值本身就是信息：有效 8 分 / 挂钟 9 分 是一口气读完，
       有效 8 分 / 挂钟 45 分 是开着页面去干别的了。 */
    var wallMin  = Math.min(63, Math.floor((Date.now() - startedAt) / 60000));

    var sections = Math.min(31, Object.keys(seenSections).length);
    var scroll15 = Math.min(15, Math.round(maxScrollPct / 100 * 15));
    var type     = (reported.cvdType === null) ? 7 : (reported.cvdType & 7);

    /* 场景答题表现。对照组没有场景，两个值恒为 0。

       这是「有没有真的在体验」最直接的行为证据，比阅读时长强：
       时长只说明页面开着，答对了几道题说明人在读、在判断。页面结尾
       本来就把这两个数显示给被试看，却一直没记进码里。 */
    var correct = Math.min(15, reported.correct | 0);
    var guesses = Math.min(15, reported.guesses | 0);

    /* pid 指纹。

       没有它，码就几乎没有熵：任何一个老实读完、闸门一开就点按钮的人，
       拿到的都是同一串。试点里三个人交了一模一样的码——而且作弊与不作弊
       产生的数据完全一样，事后分不出来。加上 pid 的 5 位指纹之后，每份
       答卷的码各不相同，转发别人的码会与答卷上的 pid 对不上。

       只存 5 位指纹而不是 pid 本身：够用来校验，又不足以从码反推出 pid。 */
    var pidHash = fingerprint(PID);

    /* 40 位载荷（高位在前）：
         39..32  有效时长 / 15 秒     8 位
         31..26  挂钟分钟             6 位
         25..21  看过的分节数         5 位
         20..17  滚动深度（0–15 档）  4 位
         16..14  CVD 类型             3 位
            13   系统开了减少动效     1 位
         12..9   场景答对数           4 位
          8..5   场景作答数           4 位
          4..0   pid 指纹             5 位
       40 位已超出 JS 按位运算的 32 位范围，因此全程用乘法拼装；
       双精度浮点在 2^53 以内的整数运算是精确的，40+5 位仍安全。 */
    var v = activeQ;
    v = v * 64 + wallMin;
    v = v * 32 + sections;
    v = v * 16 + scroll15;
    v = v * 8  + type;
    v = v * 2  + (reducedMotion ? 1 : 0);
    v = v * 16 + correct;
    v = v * 16 + guesses;
    v = v * 32 + pidHash;

    var check = 0, i, t = v;
    for (i = 0; i < 8; i++) { check ^= t % 32; t = Math.floor(t / 32); }

    var full = v * 32 + check;
    var body = '';
    for (i = 0; i < 9; i++) {
      body = ALPHABET[full % 32] + body;
      full = Math.floor(full / 32);
    }

    /* 组别标签保持 N / C（问卷的格式校验正则依赖它），但 data-arm 的取值
     已改成无语义的 'n' / 'c'：被试查看网页源码时看不出自己在哪一组。 */
    var armTag = ARM === 'n' ? 'N' : (ARM === 'c' ? 'C' : 'X');
    return CONFIG.CODE_PREFIX + '-' + armTag + '-' + body;
  }

  /* 自解码，方便在控制台核对生成结果与 tools/decode_codes.py 是否一致 */
  function readCode(code) {
    var m = /([NCX])-([0-9A-Z]{9})\s*$/.exec(String(code).toUpperCase().replace(/\s/g, ''));
    if (!m) return null;

    var full = 0, i;
    for (i = 0; i < 9; i++) {
      var idx = ALPHABET.indexOf(m[2].charAt(i));
      if (idx < 0) return null;
      full = full * 32 + idx;
    }

    var check = full % 32, v = Math.floor(full / 32), sum = 0, t = v;
    for (i = 0; i < 8; i++) { sum ^= t % 32; t = Math.floor(t / 32); }

    /* 从低位往高位剥，与编码顺序相反 */
    var pidHash = v % 32;        v = Math.floor(v / 32);
    var guesses = v % 16;        v = Math.floor(v / 16);
    var correct = v % 16;        v = Math.floor(v / 16);
    var rm      = v % 2;         v = Math.floor(v / 2);
    var type    = v % 8;         v = Math.floor(v / 8);
    var scroll  = v % 16;        v = Math.floor(v / 16);
    var secs    = v % 32;        v = Math.floor(v / 32);
    var wallMin = v % 64;        v = Math.floor(v / 64);
    var activeSec = (v % 256) * 15;

    return {
      valid: sum === check,
      arm: m[1] === 'N' ? 'narrative' : (m[1] === 'C' ? 'control' : 'unknown'),
      activeSeconds: activeSec,
      activeMinutes: +(activeSec / 60).toFixed(2),
      wallMinutes: wallMin,
      idleMinutes: Math.max(0, +(wallMin - activeSec / 60).toFixed(2)),
      sectionsSeen: secs,
      maxScrollPct: Math.round(scroll / 15 * 100),
      cvdType: ['none', 'protan', 'deutan', 'tritan', 'achro', '?', '?', 'unknown'][type],
      reducedMotion: !!rm,
      scenesCorrect: correct,
      scenesAnswered: guesses,
      pidFingerprint: pidHash
    };
  }

  /* pid 的 5 位指纹。FNV-1a 的一个小变体，取模 32。
     用途只是「这串码是不是这份答卷的」，不是密码学用途。 */
  function fingerprint(s) {
    var h = 2166136261, i;
    s = String(s || '');
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h % 32;
  }

  /* ---------- 文案 ----------

     实验站有 EN/中文 切换，但 tracker.js 之前的提示语是写死的中文——
     切到英文时闸门那块会中英混排。跟着 <html lang> 走即可，两站仍是
     同一份文件。 */
  var STR = {
    zh: {
      copy: '复制完成码', copied: '已复制 ✓', copyFail: '复制失败，请手动选中',
      issued: '完成码已生成',
      issuedNote: '请复制上方完成码，返回问卷填写。有效阅读时长：',
      min: ' 分 ', sec: ' 秒。',
      ready: '已达到最短阅读时长，可以获取完成码。',
      remainA: '还需要阅读约 ', remainB: '。（离开页面或长时间无操作时不计入）',
      minShort: ' 分 ', secShort: ' 秒'
    },
    en: {
      copy: 'Copy code', copied: 'Copied ✓', copyFail: 'Copy failed — select it manually',
      issued: 'Code generated',
      issuedNote: 'Copy the code above and paste it back into the questionnaire. Active reading time: ',
      min: ' min ', sec: ' sec.',
      ready: 'Minimum reading time reached — you can get your completion code.',
      remainA: 'About ', remainB: ' of reading left. (Time away from the page, or long pauses, does not count.)',
      minShort: ' min ', secShort: ' sec'
    }
  };

  function T(key) {
    var lang = (document.documentElement.getAttribute('lang') || 'zh').toLowerCase();
    var d = STR[lang.indexOf('en') === 0 ? 'en' : 'zh'];
    return d[key] != null ? d[key] : key;
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
      if (status) status.textContent = T('ready');
    } else {
      btn.disabled = true;
      if (status) {
        var m = Math.floor(left / 60), s = left % 60;
        status.textContent = T('remainA') +
          (m > 0 ? m + T('minShort') : '') + pad(s, 2) + T('secShort') + T('remainB');
      }
    }
  }

  /* ---------- 一键复制 ----------

     没有后端，完成码就是数据回到你手上的唯一通道——被试抄错一个字符，
     那个人的埋点就全丢了。所以别让他们手抄：给一个按钮，点一下进剪贴板。

     navigator.clipboard 需要安全上下文（HTTPS 或 localhost），且部分
     内置浏览器不给权限，因此保留 execCommand 兜底。两条都失败时把码
     选中，至少能长按复制。 */
  function copyCode() {
    if (!issuedCode) return;

    function feedback(ok) {
      if (!copyBtn) return;
      copyBtn.textContent = ok ? T('copied') : T('copyFail');
      setTimeout(function () { copyBtn.textContent = T('copy'); }, 2400);
      log(ok ? 'code_copied' : 'code_copy_failed');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(issuedCode).then(
        function () { feedback(true); },
        function () { legacyCopy(); }
      );
    } else {
      legacyCopy();
    }

    function legacyCopy() {
      var ta = document.createElement('textarea');
      ta.value = issuedCode;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, issuedCode.length);   // iOS 需要显式指定范围
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (!ok) selectCode();
      feedback(ok);
    }
  }

  /* 复制不成功时把码整段选中，被试长按就能复制 */
  function selectCode() {
    if (!codeBox || !window.getSelection || !document.createRange) return;
    var range = document.createRange();
    range.selectNodeContents(codeBox);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  var copyBtn = null;

  if (btn) {
    btn.addEventListener('click', function () {
      if (activeSeconds() < CONFIG.MIN_ACTIVE_SECONDS) return;
      unlocked = true;
      issuedCode = makeCode();
      btn.disabled = true;
      btn.textContent = T('issued');

      if (codeBox) {
        codeBox.style.display = 'block';
        codeBox.textContent = issuedCode;
      }

      if (!copyBtn) {
        copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.id = 'gateCopy';
        copyBtn.className = btn.className;      // 与"获取完成码"同款，两站外观自动一致
        copyBtn.textContent = T('copy');
        copyBtn.addEventListener('click', copyCode);
        (codeBox || btn).parentNode.insertBefore(copyBtn, (codeBox || btn).nextSibling);
      }

      if (status) {
        status.textContent = T('issuedNote') +
          Math.floor(activeSeconds() / 60) + T('min') + pad(activeSeconds() % 60, 2) + T('sec');
      }

      selectCode();          // 就算不点按钮，长按也能直接复制
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
