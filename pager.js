/* ============================================================
   pager.js — 把长文改成一节一屏

   为什么加这个
   ------------------------------------------------------------
   对照组正文约 7,500 中文字。作为一整页连续正文，它需要 19–25
   分钟精读，中途没有任何进度反馈——这是长文最容易被放弃的形态。
   流失本身会成为组间差异的来源，而那不是我们想测的东西。

   为什么这不会削弱操纵
   ------------------------------------------------------------
   在此之前，两组其实差了两件事：一是叙事的沉浸与第一人称模拟，
   二是页面结构（分屏推进 vs 一整页滚动）。后者是无关变量，却和
   前者混在一起。把对照组也改成分屏推进之后，两组的导航机制一致，
   剩下的差异才干净地落在我们真正要操纵的那一项上。

   本文件只做"翻页"，不引入任何探索式交互：没有折叠、没有动画、
   没有颜色编码、没有模拟。对照组的克制是刻意的。

   与 tracker.js 的关系
   ------------------------------------------------------------
   分屏后其余节点是 display:none，IntersectionObserver 看不到，
   因此每次翻页显式调用 TTE.seen(id) 补记——与实验站 show() 里
   的做法完全一致，两组的 sectionsSeen 才可比。
   ============================================================ */

(function () {
  'use strict';

  var main = document.querySelector('main');
  if (!main) return;

  var steps = [].slice.call(main.querySelectorAll(':scope > section[id]'));
  if (steps.length < 2) return;

  /* ---------- 进度条 ---------- */

  var bar = document.createElement('div');
  bar.className = 'pager-progress';
  bar.innerHTML = '<i></i><span class="pager-count"></span>';
  document.body.insertBefore(bar, document.body.firstChild);
  var fill = bar.querySelector('i');
  var count = bar.querySelector('.pager-count');

  /* ---------- 每节底部的推进控件 ---------- */

  steps.forEach(function (sec, i) {
    if (i === steps.length - 1) return;      // 最后一节是完成码，不加

    var nav = document.createElement('div');
    nav.className = 'pager-nav';

    if (i > 0) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'pager-btn pager-back';
      prev.textContent = '← 上一节';
      prev.addEventListener('click', function () { go(i - 1); });
      nav.appendChild(prev);
    }

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'pager-btn';
    next.textContent = (i === steps.length - 2) ? '读完了，去获取完成码 →' : '继续 →';
    next.addEventListener('click', function () { go(i + 1); });
    nav.appendChild(next);

    sec.appendChild(nav);
  });

  /* ---------- 切换 ---------- */

  var current = 0;

  function go(i) {
    if (i < 0 || i >= steps.length) return;
    steps[current].hidden = true;
    current = i;
    steps[current].hidden = false;

    fill.style.width = ((i + 1) / steps.length * 100).toFixed(1) + '%';
    count.textContent = (i + 1) + ' / ' + steps.length;

    /* 焦点移到新一节的标题，键盘与读屏用户才知道页面变了 */
    var h = steps[current].querySelector('h2');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);

    if (window.TTE && TTE.seen) TTE.seen(steps[current].id);
    warm(i + 1);
    warm(i + 2);
  }

  /* 提前把后面两节的图片取下来。

     分页之后其余各节是 display:none，浏览器不会认为 lazy 图"接近视口"，
     于是它们一直不加载——等被试翻到第八节，1.6 MB 才开始下，慢网上会
     卡住一下。提前两节预热，图片在阅读间隙里悄悄下完。 */
  function warm(i) {
    if (i < 0 || i >= steps.length) return;
    var imgs = steps[i].querySelectorAll('img[loading="lazy"]');
    for (var k = 0; k < imgs.length; k++) {
      var src = imgs[k].getAttribute('src');
      if (src) new Image().src = src;      // 进浏览器缓存，真正显示时秒开
    }
  }

  steps.forEach(function (s, i) { s.hidden = (i !== 0); });
  go(0);

  /* 键盘翻页：左右方向键。输入框内不拦截。 */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'ArrowRight' && current < steps.length - 1) go(current + 1);
    if (e.key === 'ArrowLeft' && current > 0) go(current - 1);
  });
})();
