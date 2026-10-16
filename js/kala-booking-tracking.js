/* Kala Westlake · Uzeli (GZBooker) booking tracking
   - Single GZBOOKER.init, single delegated CTA listener.
   - booking_confirmed is a CANDIDATE signal from bookingCallback only (pending the real test);
     closeCallback keeps legacy booking_completed / booking_abandoned and never confirms.
   - booking_confirmed is pushed from the parent page only (no cross-domain dependency).
   - userInfo is NEVER pushed to dataLayer, analytics or logs; only a strict whitelist is read.
   - Westlake/Uzeli only. Do not reuse this block for Anaheim/Vagaro. */
(function (w, d) {
  'use strict';
  if (w.__kalaUzeliInit) return;
  w.__kalaUzeliInit = true;

  var CFG = {
    businessId: '1b4840f9-8dcc-4cb8-a33d-13f276dfac29',
    location: 'westlake',
    provider: 'uzeli',
    value: 0,
    currency: 'USD',
    attemptTtlMs: 30 * 60 * 1000
  };

  // Discovery logging (keys/types only, never values) runs ONLY on staging/local hosts with ?kala_debug=1
  var DEBUG = /[?&]kala_debug=1(&|$)/.test(w.location.search) &&
    /(\.workers\.dev|\.pages\.dev)$|^(localhost|127\.0\.0\.1)$/.test(w.location.hostname);

  /* ---------- storage helpers (all guarded) ---------- */
  function ssGet(k) { try { return w.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { w.sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function ssDel(k) { try { w.sessionStorage.removeItem(k); } catch (e) { /* noop */ } }
  var memSent = {};

  function readSent() {
    var o = {};
    try { var raw = ssGet('kala_bk_sent'); if (raw) o = JSON.parse(raw) || {}; } catch (e) { o = {}; }
    for (var k in memSent) { if (memSent.hasOwnProperty(k)) o[k] = 1; }
    return o;
  }
  function markSent(key) {
    memSent[key] = 1;
    var o = readSent(); o[key] = 1;
    ssSet('kala_bk_sent', JSON.stringify(o));
  }

  /* ---------- attribution capture (gclid / gbraid / wbraid / UTMs) ----------
     sessionStorage ONLY. Not pushed to dataLayer and no custom cookie until the GTM,
     Consent Mode, Conversion Linker and privacy-policy audit is done. */
  var ATTR_KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  function captureAttribution() {
    var found = {}, any = false;
    var q = String(w.location.search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < q.length; i++) {
      var idx = q[i].indexOf('=');
      if (idx < 1) continue;
      var k = q[i].slice(0, idx), v = q[i].slice(idx + 1);
      if (ATTR_KEYS.indexOf(k) === -1 || !v) continue;
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { continue; }
      if (/^[\w\-.~ ]{1,200}$/.test(v)) { found[k] = v; any = true; }
    }
    if (any) ssSet('kala_attr', JSON.stringify(found));
  }

  /* ---------- booking attempt (created BEFORE Uzeli opens, reused until it closes) ---------- */
  function uuid() {
    try { if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  var attempt = null;

  function loadAttempt() {
    if (attempt) return attempt;
    var raw = ssGet('kala_bk_attempt');
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      if (o && o.id && (Date.now() - o.t) < CFG.attemptTtlMs) { attempt = o; return attempt; }
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveAttempt() { if (attempt) ssSet('kala_bk_attempt', JSON.stringify(attempt)); }
  function openAttempt(placement) {
    var cur = loadAttempt();
    if (cur) return cur;
    attempt = { id: uuid(), t: Date.now(), placement: placement || 'other', confirmed: false };
    saveAttempt();
    return attempt;
  }
  function closeAttempt() { attempt = null; ssDel('kala_bk_attempt'); }

  /* ---------- PII-safe reading of Uzeli payloads ---------- */
  var ID_KEYS = ['booking_id', 'bookingId', 'appointment_id', 'appointmentId',
    'confirmation_id', 'confirmationId', 'confirmation_number', 'confirmationNumber'];
  var SERVICE_KEYS = ['service', 'serviceName', 'service_name'];

  function safeService(v) {
    if (typeof v !== 'string') return null;
    v = v.replace(/^\s+|\s+$/g, '');
    if (!v || v.length > 80) return null;
    if (v.indexOf('@') > -1) return null;
    if (/\d{7,}/.test(v.replace(/[\s\-().]/g, ''))) return null;   // looks like a phone number
    return v;
  }
  function pickSafe(info) {
    var out = {};
    if (!info || typeof info !== 'object') return out;
    var i, v;
    for (i = 0; i < ID_KEYS.length; i++) {
      v = info[ID_KEYS[i]];
      if (typeof v === 'number') v = String(v);
      if (typeof v === 'string' && /^[A-Za-z0-9_\-:.]{4,80}$/.test(v)) { out.booking_id = v; break; }
    }
    for (i = 0; i < SERVICE_KEYS.length; i++) {
      v = safeService(info[SERVICE_KEYS[i]]);
      if (v) { out.service = v; break; }
    }
    return out;
  }

  /* ---------- staging-only discovery: key names and types, never values ---------- */
  function describe(o) {
    if (o === null || o === undefined) return String(o);
    if (typeof o !== 'object') return typeof o;
    if (Object.prototype.toString.call(o) === '[object Array]') return 'array(' + o.length + ')';
    var parts = [];
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      var t = typeof o[k];
      if (t === 'object' && o[k] !== null && Object.prototype.toString.call(o[k]) !== '[object Array]') {
        t = 'object{' + Object.keys(o[k]).join(',') + '}';
      } else if (t === 'object' && o[k] !== null) {
        t = 'array(' + o[k].length + ')';
      }
      parts.push(k + ':' + t);
    }
    return parts.join(' | ');
  }
  function debugLog(label, o) {
    if (!DEBUG) return;
    try { w.console && w.console.log('[kala-debug]', label, describe(o)); } catch (e) { /* noop */ }
  }
  if (DEBUG) {
    w.addEventListener('message', function (ev) {
      debugLog('postMessage from ' + ev.origin, ev.data);
    });
  }

  /* ---------- dataLayer ---------- */
  function push(obj) { w.dataLayer = w.dataLayer || []; w.dataLayer.push(obj); }

  function confirmBooking(source, info) {
    var a = loadAttempt() || openAttempt('unknown');
    var safe = pickSafe(info);
    var key = safe.booking_id || a.id;
    if (readSent()[key]) { debugLog('dedup-skip', { source: source }); return null; }
    markSent(key);
    a.confirmed = true;
    saveAttempt();
    var payload = {
      event: 'booking_confirmed',
      location: CFG.location,
      booking_provider: CFG.provider,
      event_id: key,
      booking_attempt_id: a.id,
      cta_placement: a.placement,
      confirm_source: source,
      value: CFG.value,
      currency: CFG.currency
    };
    if (safe.booking_id) payload.booking_id = safe.booking_id;
    if (safe.service) payload.service = safe.service;
    push(payload);
    return payload;
  }

  function onBookingCallback(userInfo) {
    debugLog('bookingCallback', userInfo);
    var sent = confirmBooking('bookingCallback', userInfo);
    if (sent) {
      // legacy event name kept (sanitized, no userInfo) until the GTM container is audited
      push({ event: 'appointment_booked', location: CFG.location, booking_provider: CFG.provider, booking_attempt_id: sent.booking_attempt_id });
    }
  }

  function onCloseCallback(count, businessInfo) {
    debugLog('closeCallback', { count: count, businessInfo: businessInfo });
    // closeCallback does NOT confirm bookings (count > 0 is unverified). Legacy events only.
    var n = parseInt(count, 10) || 0;
    push({
      event: n > 0 ? 'booking_completed' : 'booking_abandoned',   // legacy names kept
      location: CFG.location,
      booking_provider: CFG.provider,
      appointments_booked: n,
      booking_attempt_id: (loadAttempt() || {}).id
    });
    closeAttempt();
  }

  /* ---------- CTAs: one delegated listener ---------- */
  function placementFor(el) {
    var explicit = el.getAttribute && el.getAttribute('data-cta-placement');
    if (explicit) return explicit;
    if (!el.closest) return 'other';
    if (el.closest('.sticky-bar')) return 'sticky';
    if (el.closest('nav, #mobileMenu')) return 'nav';
    if (el.closest('.hero')) return 'hero';
    if (el.closest('.loc-selector')) return 'location_selector';
    if (el.closest('#services')) return 'services';
    if (el.closest('#booking')) return 'booking_section';
    if (el.closest('#deals')) return 'deals';
    return 'other';
  }

  d.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('.gz-book');
    if (!el) return;
    e.preventDefault();
    var placement = placementFor(el);
    var a = openAttempt(placement);
    push({
      event: 'booking_button_clicked',
      location: CFG.location,
      booking_provider: CFG.provider,
      cta_placement: placement,
      booking_attempt_id: a.id
    });
    if (w.GZBOOKER && w.GZBOOKER.show) w.GZBOOKER.show();
  });

  /* ---------- init (once) ---------- */
  var inited = false;
  function start() {
    if (inited || !w.GZBOOKER) return;
    inited = true;
    // Any other entry point (e.g. chatbot buttons calling GZBOOKER.show()) still gets a booking attempt.
    var origShow = w.GZBOOKER.show;
    if (typeof origShow === 'function') {
      w.GZBOOKER.show = function () { openAttempt('other'); return origShow.apply(this, arguments); };
    }
    w.GZBOOKER.init({
      businessId: CFG.businessId,
      disableDefaultButton: true,
      widgetPrimaryColor: '#0a0a0a',
      bookingCallback: onBookingCallback,
      closeCallback: onCloseCallback
    });
    // Auto-open when URL has ?gzauto=1 (e.g. Facebook "Book Now")
    if (String(w.location.search).indexOf('gzauto=1') > -1) {
      openAttempt('auto');
      w.GZBOOKER.show();
    }
  }

  captureAttribution();
  if (w.GZBOOKER) { start(); } else { w.addEventListener('load', start); }
}(window, document));
