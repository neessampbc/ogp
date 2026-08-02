(function () {
  'use strict';

  var modal = document.getElementById('auditModal');
  if (!modal) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SESSION_TOKEN = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random());
  var MIN_SCAN_MS = 9000;
  var SCAN_STEP_ORDER = ['places', 'competitors', 'site', 'score'];
  var WHATSAPP_NUMBER = '13477761759'; // same number as the nav bar's wa.me link

  var stages = {};
  modal.querySelectorAll('[data-audit-stage]').forEach(function (el) {
    stages[el.dataset.auditStage] = el;
  });

  var state = { place: null, scanResult: null, phone: '', name: '', leadRef: null };

  function showStage(key) {
    Object.keys(stages).forEach(function (k) { stages[k].hidden = k !== key; });
  }

  function openModal() {
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('audit-modal-open');
  }
  function closeModal() {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('audit-modal-open');
  }
  modal.querySelectorAll('[data-audit-close]').forEach(function (el) {
    el.addEventListener('click', closeModal);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  /* ============ autocomplete wiring (one instance per CTA bar) ============ */
  var debounceTimers = new WeakMap();

  function wireBar(bar) {
    var input = bar.querySelector('[data-audit-input]');
    var suggestionsEl = bar.querySelector('[data-audit-suggestions]');
    var submitBtn = bar.querySelector('[data-audit-submit]');
    if (!input || !suggestionsEl) return;

    var currentSuggestions = [];
    var activeIndex = -1;

    function renderSuggestions(list) {
      currentSuggestions = list;
      activeIndex = -1;
      suggestionsEl.innerHTML = '';
      if (!list.length) { suggestionsEl.hidden = true; return; }
      list.forEach(function (s) {
        var li = document.createElement('li');
        li.className = 'cta-bar__suggestion';
        li.setAttribute('role', 'option');

        var main = document.createElement('div');
        main.className = 'cta-bar__suggestion-main';
        main.textContent = s.mainText || s.text || '';

        var sub = document.createElement('div');
        sub.className = 'cta-bar__suggestion-sub';
        sub.textContent = s.secondaryText || '';

        li.appendChild(main);
        li.appendChild(sub);
        li.addEventListener('mousedown', function (e) {
          e.preventDefault(); // fires before input's blur-close so the click isn't lost
          selectPlace(s);
        });
        suggestionsEl.appendChild(li);
      });
      suggestionsEl.hidden = false;
    }

    function updateActive() {
      var items = suggestionsEl.querySelectorAll('.cta-bar__suggestion');
      items.forEach(function (it, i) { it.classList.toggle('is-active', i === activeIndex); });
    }

    function fetchSuggestions(q) {
      fetch('/api/autocomplete?input=' + encodeURIComponent(q) + '&sessionToken=' + encodeURIComponent(SESSION_TOKEN))
        .then(function (r) { return r.json(); })
        .then(function (data) { renderSuggestions(data.suggestions || []); })
        .catch(function () { renderSuggestions([]); });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(debounceTimers.get(input));
      if (q.length < 3) { renderSuggestions([]); return; }
      debounceTimers.set(input, setTimeout(function () { fetchSuggestions(q); }, 300));
    });

    input.addEventListener('keydown', function (e) {
      if (suggestionsEl.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(currentSuggestions.length - 1, activeIndex + 1);
        updateActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        updateActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0) selectPlace(currentSuggestions[activeIndex]);
      }
    });

    input.addEventListener('blur', function () {
      setTimeout(function () { suggestionsEl.hidden = true; }, 150);
    });

    function selectPlace(s) {
      input.value = s.mainText || s.text || '';
      suggestionsEl.hidden = true;
      startAudit({ placeId: s.placeId, name: s.mainText || s.text || '' });
    }

    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        if (activeIndex >= 0 && currentSuggestions[activeIndex]) {
          selectPlace(currentSuggestions[activeIndex]);
        } else if (currentSuggestions.length) {
          selectPlace(currentSuggestions[0]);
        } else if (input.value.trim()) {
          // typed something but never picked a real suggestion — we need a placeId, so nudge instead of silently failing
          input.focus();
          input.classList.add('cta-bar__field--needs-selection');
          setTimeout(function () { input.classList.remove('cta-bar__field--needs-selection'); }, 900);
        }
      });
    }
  }

  document.querySelectorAll('[data-audit-cta]').forEach(wireBar);

  /* ============ scanning stage ============ */
  var scanStepEls = {};
  stages.scanning.querySelectorAll('.audit-scan-step').forEach(function (el) {
    scanStepEls[el.dataset.step] = el;
  });
  var scanTimerEl = stages.scanning.querySelector('[data-audit-timer]');
  var scanBusinessNameEl = stages.scanning.querySelector('[data-audit-business-name]');
  var scanErrorEl = stages.scanning.querySelector('[data-audit-scan-error]');
  var scanRetryBtn = stages.scanning.querySelector('[data-audit-retry]');

  function clearScanError() {
    stages.scanning.classList.remove('is-error');
    scanErrorEl.hidden = true;
  }
  function showScanError() {
    stages.scanning.classList.add('is-error');
    scanErrorEl.hidden = false;
  }
  if (scanRetryBtn) {
    scanRetryBtn.addEventListener('click', function () {
      clearScanError();
      if (state.place) startAudit(state.place);
    });
  }

  function runScanStepper() {
    var stepMs = MIN_SCAN_MS / SCAN_STEP_ORDER.length;
    var startedAt = Date.now();
    var remaining = Math.ceil(MIN_SCAN_MS / 1000);
    if (scanTimerEl) scanTimerEl.textContent = remaining;

    var countdown = setInterval(function () {
      remaining = Math.max(0, remaining - 1);
      if (scanTimerEl) scanTimerEl.textContent = remaining;
      if (remaining <= 0) clearInterval(countdown);
    }, 1000);

    var stepTimers = SCAN_STEP_ORDER.map(function (key, i) {
      return setTimeout(function () {
        if (i > 0) {
          var prev = scanStepEls[SCAN_STEP_ORDER[i - 1]];
          if (prev) { prev.classList.remove('is-active'); prev.classList.add('is-done'); }
        }
        var el = scanStepEls[key];
        if (el) el.classList.add('is-active');
      }, reducedMotion ? 0 : stepMs * i);
    });

    return {
      elapsed: function () { return Date.now() - startedAt; },
      finish: function () {
        clearInterval(countdown);
        stepTimers.forEach(clearTimeout);
        SCAN_STEP_ORDER.forEach(function (key, i) {
          var el = scanStepEls[key];
          if (!el) return;
          el.classList.remove('is-active');
          el.classList.add('is-done');
        });
      },
    };
  }

  function startAudit(place) {
    state.place = place;
    state.scanResult = null;
    clearScanError();
    scanBusinessNameEl.textContent = place.name || 'your business';
    Object.keys(scanStepEls).forEach(function (k) { scanStepEls[k].classList.remove('is-active', 'is-done'); });
    showStage('scanning');
    openModal();

    var stepper = runScanStepper();
    var floorMs = reducedMotion ? 0 : MIN_SCAN_MS;

    fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId: place.placeId, sessionToken: SESSION_TOKEN }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        var waitLeft = Math.max(0, floorMs - stepper.elapsed());
        setTimeout(function () {
          stepper.finish();
          setTimeout(function () {
            if (!result.ok) { showScanError(); return; }
            state.scanResult = result.data;
            showResults(result.data);
          }, reducedMotion ? 0 : 500);
        }, waitLeft);
      })
      .catch(function () {
        var waitLeft = Math.max(0, floorMs - stepper.elapsed());
        setTimeout(function () { stepper.finish(); setTimeout(showScanError, reducedMotion ? 0 : 400); }, waitLeft);
      });
  }

  /* ============ results stage (reuses the hero gauge's arc geometry) ============ */
  var GRADE_CLASS = { Poor: 'poor', Fair: 'fair', Good: 'good', Excellent: 'excellent' };
  var GRADE_COLOR = { Poor: '#D96B27', Fair: '#E59E30', Good: '#10B981', Excellent: '#1A4DE5' };
  var CATEGORY_LABELS = { searchResults: 'Search results', guestExperience: 'Guest experience', localListings: 'Local listings' };

  function polar(cx, cy, r, angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
  }
  var GAUGE_R = (70 + 61.6) / 2;
  var GAUGE_STROKE = 70 - 61.6;
  var GAUGE_START = 310, GAUGE_SWEEP = 260;
  function describeArc(cx, cy, r, startAngle, endAngle) {
    var start = polar(cx, cy, r, startAngle);
    var end = polar(cx, cy, r, endAngle);
    var delta = endAngle - startAngle;
    var largeArc = Math.abs(delta) <= 180 ? 0 : 1;
    var sweep = delta >= 0 ? 1 : 0;
    return 'M ' + start.x + ' ' + start.y + ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' ' + sweep + ' ' + end.x + ' ' + end.y;
  }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  var gaugeTrack = stages.results.querySelector('[data-audit-gauge-track]');
  var gaugeProgress = stages.results.querySelector('[data-audit-gauge-progress]');
  if (gaugeTrack) {
    gaugeTrack.setAttribute('fill', 'none');
    gaugeTrack.setAttribute('stroke-width', GAUGE_STROKE);
    gaugeTrack.setAttribute('stroke-linecap', 'round');
    gaugeTrack.setAttribute('stroke', '#E8E2DD');
    gaugeTrack.setAttribute('d', describeArc(70, 70, GAUGE_R, 50, GAUGE_START));
  }
  if (gaugeProgress) {
    gaugeProgress.setAttribute('fill', 'none');
    gaugeProgress.setAttribute('stroke-width', GAUGE_STROKE);
    gaugeProgress.setAttribute('stroke-linecap', 'round');
  }

  var scoreNumEl = stages.results.querySelector('[data-audit-score-num]');
  var gradeEl = stages.results.querySelector('[data-audit-grade]');
  var lossEl = stages.results.querySelector('[data-audit-loss]');
  var categoriesEl = stages.results.querySelector('[data-audit-categories]');
  var findingsCountEl = stages.results.querySelector('[data-audit-findings-count]');
  var findingsBlurEl = stages.results.querySelector('[data-audit-findings-blur]');

  function gradeOf(pct) {
    if (pct >= 90) return 'Excellent';
    if (pct >= 75) return 'Good';
    if (pct >= 50) return 'Fair';
    return 'Poor';
  }

  function animateResultsGauge(target) {
    if (!gaugeProgress) return;
    var color = GRADE_COLOR[gradeOf(target)] || GRADE_COLOR.Poor;
    var duration = reducedMotion ? 1 : 1200;
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = easeOutCubic(t);
      var endAngle = GAUGE_START - eased * (target / 100) * GAUGE_SWEEP;
      gaugeProgress.setAttribute('stroke', color);
      gaugeProgress.setAttribute('d', describeArc(70, 70, GAUGE_R, GAUGE_START, endAngle));
      if (scoreNumEl) scoreNumEl.textContent = Math.round(eased * target);
      if (t < 1) requestAnimationFrame(frame);
      else if (scoreNumEl) scoreNumEl.textContent = target;
    }
    requestAnimationFrame(frame);
  }

  function showResults(data) {
    var score = data.score;
    animateResultsGauge(score.total);

    if (gradeEl) {
      gradeEl.textContent = score.grade;
      gradeEl.className = 'health-labels__status health-labels__status--' + (GRADE_CLASS[score.grade] || 'poor');
    }
    if (lossEl) {
      lossEl.textContent = score.estimatedMonthlyLoss > 0
        ? ('Est. $' + score.estimatedMonthlyLoss.toLocaleString('en-US') + '/mo in lost orders')
        : 'Nice — no major estimated revenue loss detected';
    }
    if (categoriesEl) {
      categoriesEl.innerHTML = '';
      Object.keys(CATEGORY_LABELS).forEach(function (key) {
        var cat = score.categories && score.categories[key];
        if (!cat) return;
        var row = document.createElement('div');
        row.className = 'audit-category-row';

        var name = document.createElement('span');
        name.className = 'audit-category-row__name';
        name.textContent = CATEGORY_LABELS[key] + ' (' + cat.points + '/' + cat.max + ')';

        var gradeSpan = document.createElement('span');
        gradeSpan.className = 'audit-category-row__grade audit-category-row__grade--' + (GRADE_CLASS[cat.grade] || 'poor');
        gradeSpan.textContent = cat.grade;

        row.appendChild(name);
        row.appendChild(gradeSpan);
        categoriesEl.appendChild(row);
      });
    }

    var findings = score.findings || [];
    if (findingsCountEl) findingsCountEl.textContent = findings.length;
    if (findingsBlurEl) {
      findingsBlurEl.innerHTML = '';
      findings.slice(0, 4).forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f.text;
        findingsBlurEl.appendChild(li);
      });
    }
    showStage('results');
  }

  /* ============ gate stages ============ */
  var phoneForm = stages['gate-phone'].querySelector('[data-audit-phone-form]');
  var phoneInput = stages['gate-phone'].querySelector('[data-audit-phone-input]');
  var nameForm = stages['gate-name'].querySelector('[data-audit-name-form]');
  var nameInput = stages['gate-name'].querySelector('[data-audit-name-input]');
  var whatsappLink = stages.confirm.querySelector('[data-audit-whatsapp-link]');
  var gotoGateBtn = stages.results.querySelector('[data-audit-goto-gate]');

  if (gotoGateBtn) {
    gotoGateBtn.addEventListener('click', function () {
      showStage('gate-phone');
      setTimeout(function () { phoneInput.focus(); }, 50);
    });
  }

  function isValidPhone(v) { return /^[0-9+()\-.\s]{7,20}$/.test(v.trim()); }

  if (phoneForm) {
    phoneForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = phoneInput.value.trim();
      if (!isValidPhone(v)) { phoneInput.classList.add('audit-input--error'); phoneInput.focus(); return; }
      phoneInput.classList.remove('audit-input--error');
      state.phone = v;
      showStage('gate-name');
      setTimeout(function () { nameInput.focus(); }, 50);
    });
  }

  if (nameForm) {
    nameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = nameInput.value.trim();
      if (!v) { nameInput.classList.add('audit-input--error'); nameInput.focus(); return; }
      nameInput.classList.remove('audit-input--error');
      state.name = v;
      submitLead();
    });
  }

  function submitLead() {
    var submitBtn = nameForm.querySelector('button[type="submit"]');
    var originalLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }

    fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.name,
        phone: state.phone,
        businessName: state.place.name,
        placeId: state.place.placeId,
        score: state.scanResult ? state.scanResult.score : {},
      }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) { state.leadRef = (result.data && result.data.leadRef) || null; })
      .catch(function () { /* best-effort logging — don't strand the lead over a Sheets hiccup */ })
      .then(function () {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
        showConfirm();
      });
  }

  function showConfirm() {
    var businessName = state.place ? state.place.name : 'my business';
    var message = "Hi! I just ran the free audit for " + businessName + " and I'd like my full results.";
    if (whatsappLink) whatsappLink.href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message);
    showStage('confirm');
  }

  if (whatsappLink) {
    whatsappLink.addEventListener('click', function () {
      if (!state.leadRef) return;
      fetch('/api/lead/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadRef: state.leadRef }),
        keepalive: true,
      }).catch(function () {});
    });
  }
})();
