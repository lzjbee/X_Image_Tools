// ==UserScript==
// @name         X / Twitter Image Zoom Enhancer
// @namespace    local.x-image-zoom
// @version      1.7.4
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
    preferredImageName: 'large',
    relayoutDelay: 100,
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
    overlay: null, overlayImg: null, loadingSrc: '', loadToken: 0,
    routeTimer: null, retryTimer: null, layoutTimer: null,
    retries: 0,
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
      if (CONFIG.preferredImageName && !u.searchParams.get('name')) u.searchParams.set('name', CONFIG.preferredImageName);
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
    // Invalidate pending image load callbacks before removing the source.
    state.loadToken += 1;
    state.loadingSrc = '';
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
    var best = null, bestScore = -Infinity;
    var maxX = window.innerWidth * CONFIG.leftPaneMaxX;
    var tcX = window.innerWidth * 0.34, tcY = window.innerHeight * 0.5;

    for (var i = 0; i < document.images.length; i++) {
      var im = document.images[i];
      if (im.closest('#' + IDS.overlay) || im.closest('#' + IDS.indicator)) continue;
      if (im.closest('[data-testid="UserAvatar-Container"]')) continue;
      var s = imgSrc(im); if (!isTwitterMedia(s)) continue;
      var r = im.getBoundingClientRect(); if (!usable(r)) continue;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx >= maxX) continue;

      // During X's carousel animation several media <img>s can coexist. The
      // visible main image is normally the largest candidate; distance only
      // breaks ties, so an animating neighbour cannot replace it accidentally.
      var dx = cx - tcX, dy = cy - tcY;
      var score = r.width * r.height - (dx * dx + dy * dy) * 0.08;
      if (score > bestScore) { bestScore = score; best = { src: normUrl(s), rect: r }; }
    }
    return best;
  }

  function resetTransform() {
    state.scale = 1; state.x = 0; state.y = 0; state.dragging = false;
  }

  function positionOverlay(rect) {
    var v = state.overlay; if (!v || !rect) return;
    // Position overlay exactly over X's image so its black background only
    // covers the image. overflow: visible lets scaled image spill out freely.
    v.style.left = Math.round(rect.left) + 'px';
    v.style.top = Math.round(rect.top) + 'px';
    v.style.width = Math.round(rect.width) + 'px';
    v.style.height = Math.round(rect.height) + 'px';
    v.style.right = 'auto';
    v.style.bottom = 'auto';
  }

  function tryLoad() {
    var p = findPhoto(); if (!p) return false;

    state.rect = p.rect;
    positionOverlay(p.rect);
    if (state.src === p.src &&
        (state.overlay.style.display !== 'none' || state.loadingSrc === p.src)) return true;

    // Never leave the preceding photo visible while a new route/carousel item
    // is loading. X keeps outgoing and incoming <img>s in the DOM briefly;
    // displaying the old overlay in that interval is what causes two photos to
    // appear stacked.
    var token = ++state.loadToken;
    state.src = p.src;
    state.loadingSrc = p.src;
    state.overlay.style.display = 'none';
    state.overlayImg.removeAttribute('src');
    resetTransform();
    updateCursor();

    state.overlayImg.onload = function () {
      if (token !== state.loadToken || state.src !== p.src) return;
      state.loadingSrc = '';
      // Re-read the source rect: X may have finished its transition while the
      // large image was loading.
      var current = findPhoto();
      if (!current || current.src !== p.src) { startScan(CONFIG.retryDelay); return; }
      state.rect = current.rect;
      positionOverlay(current.rect);
      apply();
      showOverlay();
      updateIndicator();
    };
    state.overlayImg.onerror = function () {
      if (token !== state.loadToken) return;
      state.loadingSrc = '';
      state.src = '';
      startScan(CONFIG.retryDelay);
    };
    state.overlayImg.src = p.src;
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
    if (Math.abs(state.scale - 1) <= 0.03) resetTransform();
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
  function zoomBy(f, anchorX, anchorY) {
    if (!state.src && !tryLoad()) return;

    var oldScale = state.scale;
    var newScale = clamp(oldScale * f, CONFIG.minScale, CONFIG.maxScale);
    if (Math.abs(newScale - 1) <= 0.03) {
      resetTransform();
      apply();
      return;
    }

    var rect = state.rect || (state.overlay && state.overlay.getBoundingClientRect());
    if (!rect || oldScale === 0) return;

    if (typeof anchorX !== 'number' || typeof anchorY !== 'number') {
      anchorX = rect.left + rect.width / 2;
      anchorY = rect.top + rect.height / 2;
    }

    var centerX = rect.left + rect.width / 2;
    var centerY = rect.top + rect.height / 2;
    var ratio = newScale / oldScale;
    state.x = anchorX - centerX - ratio * (anchorX - centerX - state.x);
    state.y = anchorY - centerY - ratio * (anchorY - centerY - state.y);
    state.scale = newScale;
    apply();
  }
  function reset() {
    if (!state.src && !tryLoad()) return;
    resetTransform();
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
    resetTransform();
    state.src = ''; state.rect = null; state.retries = 0;
    hideOverlay(); hideIndicator();
    clearTimeout(state.retryTimer);
    clearTimeout(state.layoutTimer);
  }
  function routeCheck() {
    if (isPhotoRoute()) {
      if (!state.enabled) return on();
      if (state.lastPath !== location.pathname) {
        state.lastPath = location.pathname;
        resetTransform();
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
  function pointInRect(x, y, r) {
    return Boolean(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }
  function visible(el) {
    return Boolean(el && el.style.display !== 'none');
  }
  function shouldHandleWheel(e) {
    if (!state.enabled || !e.ctrlKey || e.defaultPrevented) return false;
    if (!state.rect || !usable(state.rect)) return false;
    if (pointInRect(e.clientX, e.clientY, state.rect)) return true;
    if (visible(state.overlay) && pointInRect(e.clientX, e.clientY, state.overlay.getBoundingClientRect())) return true;
    if (visible(state.overlay) && state.overlayImg && pointInRect(e.clientX, e.clientY, state.overlayImg.getBoundingClientRect())) return true;
    return false;
  }
  function scheduleRelayout() {
    if (!state.enabled) return;
    clearTimeout(state.layoutTimer);
    state.layoutTimer = setTimeout(function () {
      if (!state.enabled) return;
      if (!tryLoad()) startScan(CONFIG.retryDelay);
    }, CONFIG.relayoutDelay);
  }
  function onWheel(e) {
    if (!shouldHandleWheel(e)) return;
    e.preventDefault(); e.stopPropagation();
    zoomBy(e.deltaY < 0 ? CONFIG.wheelStep : 1 / CONFIG.wheelStep, e.clientX, e.clientY);
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
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('mousedown', onMD, true);
    document.addEventListener('mousemove', onMM, true);
    document.addEventListener('mouseup', onMU, true);
    document.addEventListener('dblclick', onDbl, true);
    document.addEventListener('keydown', onKD, true);
    window.addEventListener('resize', scheduleRelayout, true);
    window.addEventListener('orientationchange', scheduleRelayout, true);
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
