// ==UserScript==
// @name         X / Twitter Image Zoom Enhancer
// @namespace    local.x-image-zoom
// @version      1.7.3
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
    rcheckInterval: 300,
    retryDelay: 400,
    retryLimit: 20,
    transitionDelay: 800,
    indicatorTimeout: 1400,
    leftPaneMaxX: 0.58,
  };

  var IDS = { style: 'xize-style', indicator: 'xize-indicator', overlay: 'xize-overlay' };

  var state = {
    enabled: false,
    listenersOn: false,
    scale: 1,
    x: 0, y: 0,
    dragging: false,
    dsX: 0, dsY: 0,
    sx: 0, sy: 0,
    src: '',
    rect: null,
    indicator: null, indicatorSpan: null, indicatorTimer: null,
    overlay: null, overlayImg: null,
    routeTimer: null, retryTimer: null, retries: 0,
    lastPath: '',
  };

  // helpers
  function isPhotoRoute() { return /\/status\/\d+\/photo\/\d+\/?$/.test(location.pathname); }
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

  // overlay
  function ensureOverlay() {
    if (state.overlay) return;
    var v = document.createElement('div'); v.id = IDS.overlay;
    var im = document.createElement('img'); im.alt = ''; im.draggable = false;
    v.appendChild(im);
    document.documentElement.appendChild(v);
    state.overlay = v; state.overlayImg = im;
  }
  function hideOverlay() {
    if (state.overlay) state.overlay.style.display = 'none';
    if (state.overlayImg) state.overlayImg.removeAttribute('src');
    state.src = ''; state.rect = null;
  }
  function showOverlay() {
    if (state.overlay) state.overlay.style.display = 'flex';
  }

  // indicator
  function ensureIndicator() {
    if (state.indicator) return;
    var el = document.createElement('div'); el.id = IDS.indicator;
    var sp = document.createElement('span'); el.appendChild(sp);
    document.documentElement.appendChild(el);
    state.indicator = el; state.indicatorSpan = sp;
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
    clearTimeout(state.indicatorTimer);
  }

  // find photo
  function findPhoto() {
    var best = null, bestDist = Infinity;
    var maxX = window.innerWidth * CONFIG.leftPaneMaxX;
    var tcX = window.innerWidth * 0.34, tcY = window.innerHeight * 0.5;

    for (var i = 0; i < document.images.length; i++) {
      var im = document.images[i];
      if (im.closest('#' + IDS.overlay) || im.closest('#' + IDS.indicator)) continue;
      if (im.closest('[data-testid="UserAvatar-Container"]')) continue;
      var s = imgSrc(im); if (!isTwitterMedia(s)) continue;
      var r = im.getBoundingClientRect(); if (!usable(r)) continue;
      if (r.left + r.width / 2 >= maxX) continue;
      var dx = r.left + r.width / 2 - tcX, dy = r.top + r.height / 2 - tcY;
      var dist = dx * dx + dy * dy - r.width * r.height * 0.02;
      if (dist < bestDist) { bestDist = dist; best = { src: normUrl(s), rect: r }; }
    }
    return best;
  }

  function tryLoad() {
    var p = findPhoto(); if (!p) return false;

    state.rect = p.rect;
    var v = state.overlay;
    // Position overlay exactly over X's image so its black background only
    // covers the image. overflow: visible lets scaled image spill out freely.
    v.style.left   = Math.round(p.rect.left) + 'px';
    v.style.top    = Math.round(p.rect.top) + 'px';
    v.style.width  = Math.round(p.rect.width) + 'px';
    v.style.height = Math.round(p.rect.height) + 'px';
    v.style.right  = 'auto';
    v.style.bottom = 'auto';

    if (state.src === p.src && state.overlay.style.display !== 'none') return true;

    state.src = p.src;
    state.overlayImg.src = p.src;
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    updateCursor();
    apply();
    showOverlay();
    updateIndicator();
    return true;
  }

  function startScan(delay) {
    clearTimeout(state.retryTimer); state.retries = 0;
    state.retryTimer = setTimeout(scan, delay || CONFIG.transitionDelay);
  }
  function scan() {
    if (!state.enabled) return;
    if (tryLoad()) return;
    state.retries += 1;
    if (state.retries <= CONFIG.retryLimit) state.retryTimer = setTimeout(scan, CONFIG.retryDelay);
  }

  // transform
  function apply() {
    var im = state.overlayImg; if (!im) return;
    if (Math.abs(state.scale - 1) <= 0.03) { state.scale = 1; state.x = 0; state.y = 0; }
    im.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(' + state.scale + ')';
    updateCursor();
    updateIndicator();
  }
  function updateCursor() {
    var v = state.overlay; if (!v) return;
    var d = state.scale !== 1;
    v.style.pointerEvents = d ? 'auto' : 'none';
    v.style.cursor = state.dragging ? 'grabbing' : (d ? 'grab' : '');
  }
  function updateIndicator() {
    var pct = Math.round(state.scale * 100);
    if (pct !== 100) showIndicator(pct);
    else if (state.indicator && state.indicator.style.display !== 'none') showIndicator(100);
  }

  // zoom / reset
  function zoomBy(f) {
    if (!state.src && !tryLoad()) return;
    var n = clamp(state.scale * f, CONFIG.minScale, CONFIG.maxScale);
    state.scale = Math.abs(n - 1) <= 0.03 ? 1 : n;
    apply();
  }
  function reset() {
    if (!state.src && !tryLoad()) return;
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    apply(); updateCursor();
  }

  // enable / disable
  function on() {
    if (state.enabled) return;
    state.enabled = true; state.lastPath = location.pathname;
    ensureOverlay(); ensureIndicator();
    if (!state.listenersOn) { state.listenersOn = true; bind(); }
    hideOverlay(); hideIndicator();
    startScan(CONFIG.transitionDelay);
  }
  function off() {
    if (!state.enabled) return;
    state.enabled = false;
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
    state.src = ''; state.rect = null; state.retries = 0;
    hideOverlay(); hideIndicator();
    clearTimeout(state.retryTimer);
  }
  function routeCheck() {
    if (isPhotoRoute()) {
      if (!state.enabled) return on();
      if (state.lastPath !== location.pathname) {
        state.lastPath = location.pathname;
        state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
        state.src = ''; state.rect = null; state.retries = 0;
        hideOverlay(); hideIndicator();
        clearTimeout(state.retryTimer);
        startScan(CONFIG.transitionDelay);
      }
      return;
    }
    off();
  }

  // events
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
    state.dragging = true; state.dsX = e.clientX; state.dsY = e.clientY;
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
    state.dragging = false; apply();
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

  // style
  function injectStyle() {
    if (document.getElementById(IDS.style)) return;
    var s = document.createElement('style'); s.id = IDS.style;
    s.textContent =
      '#' + IDS.overlay + '{position:fixed;z-index:2147483645;display:none;align-items:center;justify-content:center;overflow:visible;background:#000}' +
      '#' + IDS.overlay + ' img{display:block;max-width:100%;max-height:100%;object-fit:contain;transform-origin:center center;will-change:transform;user-select:none;-webkit-user-drag:none}' +
      '#' + IDS.indicator + '{position:fixed;bottom:24px;left:24px;z-index:2147483647;display:none;padding:4px 10px;border-radius:6px;color:#fff;background:rgba(15,20,25,0.78);font:13px system-ui,sans-serif;line-height:1.6;user-select:none;pointer-events:none}';
    document.documentElement.appendChild(s);
  }

  function init() {
    injectStyle();
    routeCheck();
    state.routeTimer = setInterval(routeCheck, CONFIG.rcheckInterval);
  }
  init();
})();
