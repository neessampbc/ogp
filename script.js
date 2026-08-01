(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ============ sticky nav shadow ============ */
  var header = document.getElementById('site-header');
  function onScrollNav() {
    if (window.scrollY > 4) header.classList.add('is-scrolled');
    else header.classList.remove('is-scrolled');
  }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  /* ============ word-by-word reveal ============ */
  // Walks child NODES (not textContent) so embedded elements — like the
  // headline's #rotator span — survive intact instead of being flattened to
  // text and rebuilt. Bare text nodes still get split into .reveal-word spans
  // for the staggered fade/blur-in. (Named "reveal-word", not "word", so this
  // system never collides with the GSAP rotator's own .word span below.)
  function wrapWords(el) {
    if (el.dataset.wrapped) return;
    el.dataset.wrapped = 'true';
    var nodes = Array.prototype.slice.call(el.childNodes);
    el.innerHTML = '';
    nodes.forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        var words = node.textContent.split(/(\s+)/); // keep whitespace tokens
        words.forEach(function (chunk) {
          if (chunk.trim() === '') {
            el.appendChild(document.createTextNode(chunk));
          } else {
            var span = document.createElement('span');
            span.className = 'reveal-word';
            span.textContent = chunk;
            el.appendChild(span);
          }
        });
      } else {
        el.appendChild(node); // preserve embedded elements (e.g. the rotator) as-is
      }
    });
  }

  document.querySelectorAll('.reveal-words').forEach(wrapWords);

  function revealWords(el) {
    if (el.classList.contains('is-revealed')) return;
    el.classList.add('is-revealed');
    var words = el.querySelectorAll('.reveal-word');
    words.forEach(function (w, i) {
      w.style.transitionDelay = reducedMotion ? '0ms' : (i * 45) + 'ms';
    });
  }

  /* ============ generic scroll reveal (GSAP ScrollTrigger, IO/no-JS fallback) ============ */
  var revealTargets = document.querySelectorAll('.fade-on-scroll, .reveal-words');

  function fireReveal(target) {
    if (target.classList.contains('reveal-words')) revealWords(target);
    else target.classList.add('is-visible');
  }

  var hasGSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  if (hasGSAP) {
    gsap.registerPlugin(ScrollTrigger);
    revealTargets.forEach(function (t) {
      ScrollTrigger.create({
        trigger: t,
        start: 'top 88%',
        once: true,
        onEnter: function () { fireReveal(t); }
      });
    });
    // catch anything already in view before ScrollTrigger finished setting up
    ScrollTrigger.refresh();
  } else if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          fireReveal(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    revealTargets.forEach(function (t) { io.observe(t); });
  } else {
    revealTargets.forEach(fireReveal);
  }

  /* ============ hero load-in ============ */
  window.addEventListener('DOMContentLoaded', function () {
    // hero headline reveals immediately on load (it's above the fold)
    var heroH1 = document.querySelector('.hero-heading .reveal-words');
    if (heroH1) revealWords(heroH1);

    document.querySelectorAll('.fade-in-up').forEach(function (el, i) {
      requestAnimationFrame(function () {
        setTimeout(function () { el.classList.add('is-loaded'); }, 30);
      });
    });

    var phoneSlot = document.querySelector('.hero-phone-slot');
    if (phoneSlot && !reducedMotion) {
      setTimeout(function () { phoneSlot.classList.add('hero-phone-float'); }, 900);
    }
  });
  // in case DOMContentLoaded already fired
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }

  /* ============ headline word rotator ============ */
  // "The Growth Partner [word] Trust" — cycles through the list below.
  // A single .word span is tweened with GSAP (yPercent + opacity) and its
  // text is swapped mid-cycle, rather than crossfading two stacked words.
  var ROTATOR_WORDS = ['Delis', 'Pizzerias', 'Cafes', 'Diners', 'Bakeries', 'Food Trucks', 'Local Businesses'];
  var ROTATOR_HOLD = 2200;

  function initRotator() {
    var rotator = document.getElementById('rotator');
    if (!rotator) return;
    var wordEl = rotator.querySelector('.word');
    if (!wordEl) {
      wordEl = document.createElement('span');
      wordEl.className = 'word';
      wordEl.textContent = ROTATOR_WORDS[0];
      rotator.appendChild(wordEl);
    }

    if (reducedMotion || typeof window.gsap === 'undefined') return; // static first word is fine without motion/GSAP

    var idx = ROTATOR_WORDS.indexOf(wordEl.textContent.trim());
    if (idx === -1) idx = 0;

    function cycle() {
      gsap.timeline({ delay: ROTATOR_HOLD / 1000, onComplete: cycle })
        .to(wordEl, { yPercent: -100, opacity: 0, duration: 0.45, ease: 'power2.in' })
        .call(function () {
          idx = (idx + 1) % ROTATOR_WORDS.length;
          wordEl.textContent = ROTATOR_WORDS[idx];
          gsap.set(wordEl, { yPercent: 100, opacity: 0 });
        })
        .to(wordEl, { yPercent: 0, opacity: 1, duration: 0.55, ease: 'power2.out' });
    }
    cycle();
  }
  initRotator();

  /* ============ health score gauge: draw-in + count up ============ */
  function polar(cx, cy, r, angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
  }

  // Track is a thick ring segment: outer r=70, inner r=61.6, gap centered at top (~100deg gap).
  // We build it as a stroked arc at centerline radius with matching stroke-width.
  var GAUGE_OUTER_R = 70, GAUGE_INNER_R = 61.6;
  var GAUGE_R = (GAUGE_OUTER_R + GAUGE_INNER_R) / 2; // 65.8
  var GAUGE_STROKE = GAUGE_OUTER_R - GAUGE_INNER_R; // 8.4
  var GAUGE_START = 310; // top-left edge of gap (progress origin)
  var GAUGE_END = 50; // top-right edge of gap (track terminus)
  var GAUGE_SWEEP = 260; // total degrees the track spans

  function describeArc(cx, cy, r, startAngle, endAngle) {
    var start = polar(cx, cy, r, startAngle);
    var end = polar(cx, cy, r, endAngle);
    var delta = endAngle - startAngle;
    var largeArc = Math.abs(delta) <= 180 ? 0 : 1;
    var sweep = delta >= 0 ? 1 : 0;
    return 'M ' + start.x + ' ' + start.y + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' ' + sweep + ' ' + end.x + ' ' + end.y;
  }

  function setGaugeStrokeAttrs(path) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', GAUGE_STROKE);
    path.setAttribute('stroke-linecap', 'round');
  }

  var mainTrack = document.getElementById('mainGaugeTrack');
  var mainProgress = document.getElementById('mainGaugeProgress');
  if (mainTrack && mainProgress) {
    setGaugeStrokeAttrs(mainTrack);
    mainTrack.setAttribute('stroke', '#E8E2DD');
    mainTrack.setAttribute('d', describeArc(70, 70, GAUGE_R, GAUGE_END, GAUGE_START));

    setGaugeStrokeAttrs(mainProgress);
    mainProgress.setAttribute('stroke', '#D96B27');
    mainProgress.setAttribute('d', describeArc(70, 70, GAUGE_R, GAUGE_START, GAUGE_START)); // start collapsed
  }

  var SCORE_TARGET = 36;
  var scoreNumEl = document.getElementById('scoreNum');

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateMainGauge() {
    if (!mainProgress) return;
    var duration = reducedMotion ? 1 : 1400;
    var start = null;

    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = easeOutCubic(t);
      var percent = eased * (SCORE_TARGET / 100);
      var endAngle = GAUGE_START - percent * GAUGE_SWEEP;
      mainProgress.setAttribute('d', describeArc(70, 70, GAUGE_R, GAUGE_START, endAngle));
      if (scoreNumEl) scoreNumEl.textContent = Math.round(eased * SCORE_TARGET);
      if (t < 1) requestAnimationFrame(frame);
      else {
        if (scoreNumEl) scoreNumEl.textContent = SCORE_TARGET;
        animateMiniGauges();
      }
    }
    requestAnimationFrame(frame);
  }

  function animateMiniGauges() {
    var rows = document.querySelectorAll('.status-row-item');
    rows.forEach(function (row, i) {
      var pct = parseFloat(row.dataset.percent) || 0;
      var circle = row.querySelector('.mini-gauge__progress');
      if (!circle) return;
      var delay = reducedMotion ? 0 : 150 * (i + 1);
      setTimeout(function () {
        var circumference = 2 * Math.PI * 10.2;
        var offset = circumference * (1 - pct / 100);
        circle.style.transition = reducedMotion ? 'none' : 'stroke-dashoffset 0.9s cubic-bezier(0.22,1,0.36,1)';
        circle.setAttribute('stroke-dashoffset', offset);
      }, delay);
    });
  }

  /* scan the phone screen first, then draw in the gauge + sub-scores */
  var scanLine = document.querySelector('.scan-line');
  function runScanThenGauge() {
    if (!scanLine || reducedMotion) {
      animateMainGauge();
      return;
    }
    scanLine.classList.add('is-scanning');
    scanLine.addEventListener('animationend', function onScanDone() {
      scanLine.removeEventListener('animationend', onScanDone);
      animateMainGauge();
    });
  }

  var gaugeSection = document.querySelector('.gauge-section');
  var gaugeAnimated = false;
  if (gaugeSection && 'IntersectionObserver' in window) {
    var gaugeIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !gaugeAnimated) {
          gaugeAnimated = true;
          runScanThenGauge();
          gaugeIO.disconnect();
        }
      });
    }, { threshold: 0.3 });
    gaugeIO.observe(gaugeSection);
  } else if (gaugeSection) {
    runScanThenGauge();
  }

  /* ============ reviews count-up (More Repeat Orders tab) ============ */
  var REVIEWS_TARGET = 248;
  var reviewsNumEl = document.getElementById('reviewsCount');
  function animateReviewsCount() {
    if (!reviewsNumEl) return;
    var duration = reducedMotion ? 1 : 1200;
    var start = null;
    reviewsNumEl.textContent = '0';
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = easeOutCubic(t);
      reviewsNumEl.textContent = Math.round(eased * REVIEWS_TARGET);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ============ Google-results pins: staggered pop-in + "you" ping (More Google Traffic tab) ============ */
  var googlePins = Array.prototype.slice.call(document.querySelectorAll('.map-pin[data-pin-order]'))
    .sort(function (a, b) { return (+a.dataset.pinOrder) - (+b.dataset.pinOrder); });
  var googleSearchPill = document.querySelector('.google-card__search');
  var youPin = document.querySelector('.map-pin--you');

  function animateGoogleCardPins() {
    googlePins.forEach(function (pin) { pin.classList.remove('is-shown'); });
    if (youPin) youPin.classList.remove('is-pinging');
    if (googleSearchPill) googleSearchPill.classList.remove('is-shown');

    if (reducedMotion) {
      googlePins.forEach(function (pin) { pin.classList.add('is-shown'); });
      if (youPin) youPin.classList.add('is-pinging');
      if (googleSearchPill) googleSearchPill.classList.add('is-shown');
      return;
    }

    setTimeout(function () {
      if (googleSearchPill) googleSearchPill.classList.add('is-shown');
    }, 150);

    googlePins.forEach(function (pin, i) {
      setTimeout(function () {
        pin.classList.add('is-shown');
        if (pin === youPin) {
          setTimeout(function () { youPin.classList.add('is-pinging'); }, 400);
        }
      }, 220 * (i + 1));
    });
  }

  var googleTabAnimated = false;
  var googleTabPanel = document.querySelector('.tab-panel[data-panel="0"]');
  if (googleTabPanel && 'IntersectionObserver' in window) {
    var googleTabIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !googleTabAnimated) {
          googleTabAnimated = true;
          animateGoogleCardPins();
          googleTabIO.disconnect();
        }
      });
    }, { threshold: 0.3 });
    googleTabIO.observe(googleTabPanel);
  } else if (googleTabPanel) {
    animateGoogleCardPins();
  }

  /* ============ auto-advancing feature tabs ============ */
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.tab-panel');
  var currentTab = 0;
  var TAB_INTERVAL = 5000;
  var tabTimer = null;

  function goToTab(index) {
    if (index === currentTab) return;
    tabs[currentTab].classList.remove('is-active');
    tabs[currentTab].setAttribute('aria-selected', 'false');
    panels[currentTab].classList.remove('is-active');
    panels[currentTab].classList.add('is-leaving');

    tabs[index].classList.add('is-active');
    tabs[index].setAttribute('aria-selected', 'true');
    panels[index].classList.add('is-active');

    // on narrow screens the tab row scrolls horizontally — without this, an
    // auto-advance to a tab scrolled out of view leaves no visible indication
    // anything changed
    tabs[index].scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', inline: 'nearest', block: 'nearest' });

    if (index === 0) animateGoogleCardPins();
    if (index === 2) animateReviewsCount();

    setTimeout(function () {
      panels.forEach(function (p, i) { if (i !== index) p.classList.remove('is-leaving'); });
    }, 550);

    currentTab = index;
  }

  function startAutoAdvance() {
    if (tabTimer) clearInterval(tabTimer);
    tabTimer = setInterval(function () {
      var next = (currentTab + 1) % tabs.length;
      goToTab(next);
    }, TAB_INTERVAL);
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      goToTab(i);
      startAutoAdvance(); // clicking a tab jumps/resets the auto-advance timer
    });
  });

  if (tabs.length) startAutoAdvance();

  // pause auto-advance while the tab section is off-screen to avoid surprising jumps
  var growthTabsEl = document.querySelector('.growth-tabs');
  if (growthTabsEl && 'IntersectionObserver' in window) {
    var tabVisIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) startAutoAdvance();
        else if (tabTimer) { clearInterval(tabTimer); tabTimer = null; }
      });
    }, { threshold: 0.2 });
    tabVisIO.observe(growthTabsEl);
  }

  /* ============ service card hover glow that follows cursor ============ */
  document.querySelectorAll('.service-card').forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var rect = card.getBoundingClientRect();
      var x = ((e.clientX - rect.left) / rect.width) * 100;
      var y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--mx', x + '%');
      card.style.setProperty('--my', y + '%');
    });
  });

})();
