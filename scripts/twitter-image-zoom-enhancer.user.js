// ==UserScript==
// @name         X / Twitter Image Zoom Enhancer
// @namespace    local.x-image-zoom
// @version      1.6.0
// @description  Add zoom, drag, and reset support to X / Twitter photo pages.
// @author       local
// @match        https://x.com/*
// @match        https://www.x.com/*
// @match        https://twitter.com/*
// @match        https://www.twitter.com/*
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var CONFIG = {
    minScale: 0.5,
    maxScale: 8,
    wheelStep: 1.12,
    buttonStep: 1.12,
    routeCheckInterval: 800,
    retryDelay: 400,
    retryLimit: 20,
    transitionDelay: 800,
    indicatorTimeout: 1400,
  };

  var IDS = {
    style: 'xize-style',
    indicator: 'xize-indicator',
    viewer: 'xize-viewer',
  };

  var state = {
    enabled: false,
    listenersOn: false,
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    dsX: 0,
    dsY: 0,
    sx: 0,
    sy: 0,
    src: '',
    rect: null,
    indicator: null,
    indicatorSpan: null,
    indicatorTimer: null,
    viewer: null,
    viewerImg: null,
    routeTimer: null,
    retryTimer: null,
    retries: 0,
    lastPath: '',
    pendingSrc: '',
  };

  // ---- helpers ----

  function isPhotoRoute() {
    return /\/status\/\d+\/photo\/\d+\/?$/.test(location.pathname);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function editable(el) {
    return Boolean(el && (el.nodeType === Node.ELEMENT_NODE ? el : el.parentElement)
      .closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
  }

  function imgSrc(img) { return (img && (img.currentSrc || img.src)) || ''; }

  function isTwitterMedia(s) { return /^https:\/\/pbs\.twimg\.com\/media\//.test(s); }

  function normUrl(s) {
    try {
      var u = new URL(s);
      if (!u.hostname.includes('pbs.twimg.com') || !u.pathname.includes('/media/')) return s;
      if (!u.searchParams.get('name')) u.searchParams.set('name', 'large');
      return u.toString();
    } catch (e) { return s; }
  }

  function usable(r) {
    return r && r.width >= 40 && r.height >= 40 && r.right > 0 && r.bottom > 0 &&
      r.left < window.innerWidth && r.top < window.innerHeight;
  }

  // ---- viewer layer ----

  function ensureViewer() {
    if (state.viewer) return;
    var v = document.createElement('div');
    v.id = IDS.viewer;
    var im = document.createElement('img');
    im.alt = ''; im.draggable = false;
    v.appendChild(im);
    document.documentElement.appendChild(v);
    state.viewer = v;
    state.viewerImg = im;
  }

  function hideViewer() {
    if (state.viewer) state.viewer.style.display = 'none';
    if (state.viewerImg) state.viewerImg.removeAttribute('src');
    state.src = '';
  }

  function showViewer() {
    if (state.viewer) state.viewer.style.display = 'flex';
  }

  // ---- percentage indicator (top-right) ----

  function ensureIndicator() {
    if (state.indicator) return;
    var el = document.createElement('div');
    el.id = IDS.indicator;
    var sp = document.createElement('span');
    el.appendChild(sp);
    document.documentElement.appendChild(el);
    state.indicator = el;
    state.indicatorSpan = sp;
  }

  function showIndicator(pct) {
    ensureIndicator();
    state.indicatorSpan.textContent = pct + '%';
    state.indicator.style.display = 'block';
    clearTimeout(state.indicatorTimer);
    if (pct === 100) {
      state.indicatorTimer = setTimeout(function () {
        state.indicator.style.display = 'none';
      }, CONFIG.indicatorTimeout);
    }
  }

  function hideIndicator() {
    if (state.indicator) state.indicator.style.display = 'none';
  }

  // ---- pick the current photo ----

  function findPhoto() {
    var best = null, bestDist = Infinity;
    var targetCX = window.innerWidth * 0.34, targetCY = window.innerHeight * 0.5;
    var maxX = window.innerWidth * 0.58;

    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.closest('#' + IDS.viewer) || im.closest('#' + IDS.indicator)) continue;
      if (im.closest('[data-testid="UserAvatar-Container"]')) continue;
      var s = imgSrc(im);
      if (!isTwitterMedia(s)) continue;
      var r = im.getBoundingClientRect();
      if (!usable(r)) continue;
      if (r.left + r.width / 2 >= maxX) continue;

      var dx = r.left + r.width / 2 - targetCX;
      var dy = r.top + r.height / 2 - targetCY;
      var dist = dx * dx + dy * dy - r.width * r.height * 0.02;
      if (dist < bestDist) { bestDist = dist; best = { src: normUrl(s), rect: r }; }
    }
    return best;
  }

  function tryLoad() {
    var p = findPhoto();
    if (!p) return false;

    state.rect = p.rect;
    var v = state.viewer;
    v.style.left = Math.round(p.rect.left) + 'px';
    v.style.top = Math.round(p.rect.top) + 'px';
    v.style.width = Math.round(p.rect.width) + 'px';
    v.style.height = Math.round(p.rect.height) + 'px';

    if (state.src === p.src && state.viewer.style.display !== 'none') return true;

    state.src = p.src;
    state.viewerImg.src = p.src;
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    updateCursor();
    apply();
    showViewer();
    updateIndicator();
    return true;
  }

  function startScan(delay) {
    clearTimeout(state.retryTimer);
    state.retries = 0;
    state.retryTimer = setTimeout(scan, delay || CONFIG.transitionDelay);
  }

  function scan() {
    if (!state.enabled) return;
    if (tryLoad()) return;
    state.retries += 1;
    if (state.retries <= CONFIG.retryLimit) {
      state.retryTimer = setTimeout(scan, CONFIG.retryDelay);
    }
  }

  // ---- transform & cursor ----

  function apply() {
    var im = state.viewerImg;
    if (!im) return;
    if (Math.abs(state.scale - 1) <= 0.03) { state.scale = 1; state.x = 0; state.y = 0; }
    im.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(' + state.scale + ')';
    updateCursor();
    updateIndicator();
  }

  function updateCursor() {
    var v = state.viewer;
    if (!v) return;
    var d = state.scale !== 1;
    v.style.pointerEvents = d ? 'auto' : 'none';
    v.style.cursor = state.dragging ? 'grabbing' : (d ? 'grab' : '');
  }

  function updateIndicator() {
    var pct = Math.round(state.scale * 100);
    if (pct !== 100) showIndicator(pct);
    else if (state.indicator && state.indicator.style.display !== 'none') {
      showIndicator(100);
    }
  }

  // ---- zoom / reset ----

  function zoomBy(f) {
    if (!state.src && !tryLoad()) return;
    var n = clamp(state.scale * f, CONFIG.minScale, CONFIG.maxScale);
    state.scale = Math.abs(n - 1) <= 0.03 ? 1 : n;
    apply();
  }

  function reset() {
    if (!state.src && !tryLoad()) return;
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    apply();
    updateCursor();
  }

  // ---- enable / disable ----

  function on() {
    if (state.enabled) return;
    state.enabled = true;
    state.lastPath = location.pathname;
    ensureViewer();
    ensureIndicator();
    if (!state.listenersOn) { state.listenersOn = true; bind(); }
    hideViewer();
    hideIndicator();
    startScan(CONFIG.transitionDelay);
  }

  function off() {
    if (!state.enabled) return;
    state.enabled = false;
    resetState();
    hideViewer();
    hideIndicator();
    clearTimeout(state.retryTimer);
  }

  function resetState() {
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    state.src = ''; state.rect = null; state.retries = 0;
  }

  function routeCheck() {
    if (isPhotoRoute()) {
      if (!state.enabled) return on();
      if (state.lastPath !== location.pathname) {
        state.lastPath = location.pathname;
        resetState();
        // Aggressively hide so no stale image flashes
        hideViewer();
        hideIndicator();
        clearTimeout(state.retryTimer);
        startScan(CONFIG.transitionDelay);
      }
      return;
    }
    off();
  }

  // ---- event handlers ----

  function onWheel(e) {
    if (!state.enabled || !e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    zoomBy(e.deltaY < 0 ? CONFIG.wheelStep : 1 / CONFIG.wheelStep);
  }

  function onMD(e) {
    if (!state.enabled || e.button !== 0 || state.scale === 1) return;
    if (state.indicator && state.indicator.contains(e.target)) return;
    if (!state.src) return;
    e.preventDefault(); e.stopPropagation();
    state.dragging = true;
    state.dsX = e.clientX; state.dsY = e.clientY;
    state.sx = state.x; state.sy = state.y;
    apply();
  }

  function onMM(e) {
    if (!state.enabled || !state.dragging) return;
    e.preventDefault(); e.stopPropagation();
    state.x = state.sx + e.clientX - state.dsX;
    state.y = state.sy + e.clientY - state.dsY;
    apply();
  }

  function onMU(e) {
    if (!state.dragging) return;
    e.preventDefault(); e.stopPropagation();
    state.dragging = false;
    apply();
  }

  function onDbl(e) {
    if (!state.enabled || state.scale === 1) return;
    e.preventDefault(); e.stopPropagation();
    reset();
  }

  function onKD(e) {
    if (!state.enabled || editable(e.target)) return;
    var k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); reset(); }
    if (k === 'escape') { hideIndicator(); }
  }

  function bind() {
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('mousedown', onMD, true);
    document.addEventListener('mousemove', onMM, true);
    document.addEventListener('mouseup', onMU, true);
    document.addEventListener('dblclick', onDbl, true);
    document.addEventListener('keydown', onKD, true);
  }

  // ---- style ----

  function injectStyle() {
    if (document.getElementById(IDS.style)) return;
    var s = document.createElement('style');
    s.id = IDS.style;
    s.textContent =
      '#' + IDS.viewer + '{position:fixed;z-index:2147483645;display:none;align-items:center;justify-content:center;overflow:hidden;background:#000}' +
      '#' + IDS.viewer + ' img{display:block;max-width:100%;max-height:100%;object-fit:contain;transform-origin:center center;will-change:transform;user-select:none;-webkit-user-drag:none}' +
      '#' + IDS.indicator + '{position:fixed;bottom:24px;left:24px;z-index:2147483647;display:none;padding:4px 10px;border-radius:6px;color:#fff;background:rgba(15,20,25,0.78);font:13px system-ui,sans-serif;line-height:1.6;user-select:none;pointer-events:none}';
    document.documentElement.appendChild(s);
  }

  // ---- init ----

  function init() {
    injectStyle();
    routeCheck();
    state.routeTimer = setInterval(routeCheck, CONFIG.routeCheckInterval);
  }

  init();
})();
