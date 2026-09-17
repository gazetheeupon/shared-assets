/*
 * RunLocal shared site chrome + consent + analytics/ads loader.
 * One include (`<script defer src=".../shared-assets/site.js"></script>`) gives a
 * new tool page: header, "more free tools" nav (built live from tools.json),
 * footer with Privacy Policy link, and (if the page has a `<div id="ad-slot">`)
 * the AADS ad -- gated behind consent for visitors who need that. Nothing here
 * ever touches file content the user drops into a tool; this only concerns
 * page-view analytics and ad delivery.
 *
 * Consent architecture (as of the Google-CMP integration):
 * - Google Analytics (GA4) and Google AdSense are Google's own tags, and they load
 *   unconditionally on every page. Their actual behavior is governed by Google
 *   Consent Mode v2 signals, which default to "denied" for the EU/EEA, UK, and
 *   Switzerland (via Consent Mode's own `region` scoping, resolved by Google's
 *   tags using Google's own geo-IP detection -- more reliable than anything we can
 *   do client-side) and "granted" everywhere else. For EEA/UK/CH visitors, Google's
 *   own AdSense-hosted consent message (configured in AdSense > Privacy & messaging)
 *   is what actually prompts them and calls `gtag('consent','update', ...)` when
 *   they respond -- this script does NOT show its own banner to those visitors
 *   automatically, to avoid double-prompting on top of Google's official one.
 * - A-Ads (AADS) is a separate, non-Google ad network with no awareness of Consent
 *   Mode at all, so it can't be gated by Google's mechanism directly. Instead, this
 *   script listens for any `consent update` command (however it was triggered --
 *   by Google's CMP, or by this script's own fallback UI) via a thin wrap around
 *   `dataLayer.push`, and uses that same signal to show or withdraw the AADS ad.
 *   For a first visit with no prior decision, AADS's own initial state is decided
 *   by a client-side timezone heuristic (`isConsentRegion`, no network call, no
 *   geo-IP lookup): visitors outside the EU/EEA/UK/Switzerland get the ad
 *   immediately with no prompt; visitors inside those regions have it withheld
 *   until a real consent decision is recorded.
 * - Every visitor, anywhere, can open "Cookie preferences" in the footer at any
 *   time: it reopens Google's own consent dialog if present (`googlefc`), or falls
 *   back to this script's own simple Accept/Reject banner otherwise.
 *
 * SEO additions (per SEO_NOTES.md):
 * - A "100% client-side" privacy badge is injected at the top of every tool page's
 *   <main>, phrased from that tool's `tech`/`hasFileInput` fields in tools.json.
 * - Every page's WebApplication JSON-LD block gets `browserRequirements` and
 *   `permissions` fields added at runtime if the page's own script omitted them,
 *   so this applies retroactively to already-shipped pages with no per-page edit.
 * - Tools that share a `cluster` in tools.json (e.g. "Windows Forensics",
 *   "Data Science") get a prominent "Part of the X toolkit" cross-link block near
 *   the top of the page, in addition to the general "More free tools" nav.
 * - A dormant ad-block-detected donation nudge: only activates once DONATION_LINKS
 *   below has a real Ko-fi and/or crypto link configured; until then it's a no-op.
 */
(function () {
  'use strict';

  var BASE = 'https://gazetheeupon.github.io';
  var GA_ID = 'G-S56YMT587E';
  var ADSENSE_CLIENT = 'ca-pub-9691619403787602';
  var DEFAULT_AADS_UNIT = '2455639'; // catchall unit, used unless #ad-slot sets data-aads-unit
  var CONSENT_KEY = 'runlocal_consent_v1';

  // Fill these in to switch on the ad-block donation nudge below; both null = feature is inert.
  var DONATION_LINKS = {
    kofi: null,   // e.g. 'https://ko-fi.com/yourname'
    crypto: null  // e.g. a page with wallet addresses, or a direct address string
  };

  var CLUSTER_LABELS = {
    'windows-forensics': 'Windows Forensics',
    'data-science': 'Data Science'
  };

  // ISO 3166-1 alpha-2 codes: EU27 + EEA (Iceland, Liechtenstein, Norway) + UK + Switzerland.
  var CONSENT_REGION_CODES = [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
    'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO', 'GB', 'CH'
  ];

  // ---- 1. Consent Mode v2 defaults for Google's own tags (GA4 / AdSense). ----
  // Must run before those scripts load. Region-scoped: denied for the EEA/UK/CH list
  // above (Google's own tags resolve whether a visitor is actually in that list using
  // Google's geo-IP, not anything computed here); granted as the fallback for everyone
  // else. This is Google's documented pattern for pairing Consent Mode with a CMP.
  window.dataLayer = window.dataLayer || [];
  var _dataLayerPush = window.dataLayer.push.bind(window.dataLayer);
  window.dataLayer.push = function () {
    var result = _dataLayerPush.apply(null, arguments);
    try { observeDataLayerPush(arguments); } catch (e) {}
    return result;
  };
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500,
    region: CONSENT_REGION_CODES
  });
  gtag('consent', 'default', {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted'
  });

  // Fires on every dataLayer push, from any source (our own gtag() shim, Google's real
  // gtag.js runtime once GA4 loads, or Google's AdSense-hosted consent message). Only
  // reacts to explicit `consent update` commands -- a real decision having been made --
  // never to `default` commands, since region-scoping on those is resolved inside
  // Google's own tag runtime and isn't visible from the raw command arguments here.
  function observeDataLayerPush(pushArgs) {
    var cmd = pushArgs[0];
    if (!cmd || cmd[0] !== 'consent' || cmd[1] !== 'update') return;
    var params = cmd[2] || {};
    onConsentUpdate(params);
  }

  function onConsentUpdate(params) {
    var granted = params.ad_storage === 'granted' || params.ad_user_data === 'granted';
    if (granted) {
      injectAd();
    } else {
      var slot = document.getElementById('ad-slot');
      if (slot) { slot.innerHTML = ''; }
    }
    try { localStorage.setItem(CONSENT_KEY, granted ? 'accepted' : 'rejected'); } catch (e) {}
  }

  var consentChoice = null;
  try { consentChoice = localStorage.getItem(CONSENT_KEY); } catch (e) {}

  // ---- Region gate: used only to decide AADS's own initial state (see header comment). ----
  // Heuristic, not exhaustive: IANA "Europe/*" zones cover the EU/EEA, UK, and Switzerland.
  // A handful of non-"Europe/*" zones for EU member territories/EEA members are added below.
  // Falls back to "treat as a consent region" (the safer default) if the timezone can't be read.
  var EXTRA_CONSENT_TZ = [
    'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Reykjavik',
    'Africa/Ceuta', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne',
    'Indian/Reunion', 'Indian/Mayotte'
  ];
  function isConsentRegion() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return tz.indexOf('Europe/') === 0 || EXTRA_CONSENT_TZ.indexOf(tz) !== -1;
    } catch (e) {
      return true; // can't tell -> be conservative and withhold AADS until asked
    }
  }

  function loadScript(src, attrs) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) s.setAttribute(k, attrs[k]); } }
    document.head.appendChild(s);
    return s;
  }

  var adWasAttempted = false; // set true whenever injectAd() actually tries to show an ad

  function injectAd() {
    adWasAttempted = true;
    var slot = document.getElementById('ad-slot');
    if (!slot) return;
    var unit = slot.getAttribute('data-aads-unit') || DEFAULT_AADS_UNIT;
    slot.innerHTML =
      '<!-- BEGIN AADS AD UNIT ' + unit + ' -->' +
      '<div id="frame" style="width:100%;margin:auto;position:relative;z-index:99998;">' +
      '<iframe data-aa="' + unit + '" src="//acceptable.a-ads.com/' + unit + '/?size=Adaptive" ' +
      'style="border:0;padding:0;width:70%;height:auto;overflow:hidden;display:block;margin:auto"></iframe>' +
      '</div><!-- END AADS AD UNIT ' + unit + ' -->';
    maybeShowDonationNudge();
  }

  // GA4 + AdSense load unconditionally: Consent Mode + Google's own consent message
  // (for EEA/UK/CH visitors) govern what those tags actually do with the signals above.
  function loadGoogleTags() {
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + GA_ID);
    gtag('js', new Date());
    gtag('config', GA_ID);
    loadScript(
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADSENSE_CLIENT,
      { crossorigin: 'anonymous' }
    );
  }

  function grantConsent() {
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted'
    });
  }

  function rejectConsent() {
    gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied'
    });
  }

  // ---- 1b. Ad-block-detected donation nudge (dormant until DONATION_LINKS is filled in). ----
  // Classic bait-element technique: an ad blocker's filter lists hide elements matching
  // common ad-related class names, whether or not any real ad network is even present.
  // Only checked when we actually tried to show an ad for this visitor (never nags a
  // visitor who is still mid-consent-decision, or who explicitly rejected ads/analytics).
  function maybeShowDonationNudge() {
    if (!DONATION_LINKS.kofi && !DONATION_LINKS.crypto) return;
    try {
      if (sessionStorage.getItem('runlocal_donation_dismissed') === '1') return;
    } catch (e) {}
    var bait = document.createElement('div');
    bait.className = 'ad-banner ads ad-placement adsbygoogle adsbox';
    bait.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(bait);
    setTimeout(function () {
      var baitBlocked = bait.offsetHeight === 0 || bait.offsetParent === null ||
        getComputedStyle(bait).display === 'none' || getComputedStyle(bait).visibility === 'hidden';
      var slot = document.getElementById('ad-slot');
      var slotEmpty = !!slot && slot.querySelector('iframe') === null;
      bait.remove();
      if (adWasAttempted && (baitBlocked || slotEmpty)) {
        showDonationBanner();
      }
    }, 1200);
  }

  function showDonationBanner() {
    if (document.getElementById('donation-banner')) return;
    var links = [];
    if (DONATION_LINKS.kofi) links.push('<a href="' + DONATION_LINKS.kofi + '" target="_blank" rel="noopener">Ko-fi</a>');
    if (DONATION_LINKS.crypto) links.push('<a href="' + DONATION_LINKS.crypto + '" target="_blank" rel="noopener">Crypto</a>');
    if (!links.length) return;
    var bar = document.createElement('div');
    bar.id = 'donation-banner';
    bar.className = 'donation-banner';
    bar.innerHTML =
      '<span>Looks like you’re blocking ads. Good for you — these tools stay free either way. ' +
      'If you’d like to help keep them running: ' + links.join(' &middot; ') + '</span>' +
      '<button id="donation-dismiss" aria-label="Dismiss">&times;</button>';
    document.body.appendChild(bar);
    document.getElementById('donation-dismiss').addEventListener('click', function () {
      bar.remove();
      try { sessionStorage.setItem('runlocal_donation_dismissed', '1'); } catch (e) {}
    });
  }

  // ---- 2. Chrome: header, nav (from tools.json), footer ----
  function renderHeader() {
    var header = document.createElement('div');
    header.className = 'site-header';
    header.innerHTML =
      '<a class="site-header__brand" href="' + BASE + '/">RunLocal</a>' +
      '<span class="site-header__tagline">Free tools that run entirely in your browser</span>';
    document.body.insertBefore(header, document.body.firstChild);
  }

  function renderFooter() {
    var footer = document.createElement('footer');
    footer.innerHTML =
      'Free, no signup, runs entirely offline in your browser once loaded.' +
      '<div style="margin-top:.6rem;">&copy; 2026 GazeTheeUpon. All rights reserved. ' +
      '<a href="' + BASE + '/LICENSE" style="color:inherit;">Source license</a> &mdash; ' +
      '<a href="' + BASE + '/privacy-policy/" style="color:inherit;">Privacy Policy</a> &mdash; ' +
      '<a href="#" id="cookie-prefs" style="color:inherit;">Cookie preferences</a> &mdash; ' +
      'view-source friendly, redistribution not permitted.</div>';
    document.body.appendChild(footer);
    document.getElementById('cookie-prefs').addEventListener('click', function (ev) {
      ev.preventDefault();
      if (window.googlefc && typeof window.googlefc.showRevocationMessage === 'function') {
        window.googlefc.showRevocationMessage();
      } else {
        showConsentBanner();
      }
    });
  }

  // ---- 2b. Privacy badge + cluster cross-links (SEO_NOTES items 1 and 6) ----
  function techPhrase(tech) {
    if (!tech) return 'plain JavaScript';
    if (tech.indexOf('WebAssembly') === 0) return tech + ', a sandboxed, no-install runtime the browser executes locally';
    return tech;
  }

  function renderPrivacyBadge(selfEntry) {
    var main = document.querySelector('main');
    if (!main || !selfEntry) return;
    var text = selfEntry.hasFileInput
      ? '100% client-side: your file never leaves this browser tab, and nothing is ever uploaded. Runs on ' + techPhrase(selfEntry.tech) + ' plus the HTML5 File API.'
      : '100% client-side: nothing you enter here is ever sent to a server. Runs on ' + techPhrase(selfEntry.tech) + '.';
    var badge = document.createElement('div');
    badge.className = 'privacy-badge';
    badge.textContent = text;
    main.insertBefore(badge, main.firstChild);
    return badge;
  }

  function renderClusterNav(tools, selfEntry, afterEl) {
    if (!selfEntry || !selfEntry.cluster) return;
    var clusterTools = tools.filter(function (t) { return t.cluster === selfEntry.cluster && t.slug !== selfEntry.slug; });
    if (!clusterTools.length) return;
    var label = CLUSTER_LABELS[selfEntry.cluster] || selfEntry.cluster;
    var main = document.querySelector('main');
    if (!main) return;
    var box = document.createElement('div');
    box.className = 'cluster-nav';
    box.innerHTML = '<strong>Part of the ' + label + ' toolkit:</strong> ' +
      clusterTools.map(function (t) {
        return '<a href="' + BASE + '/' + t.slug + '/">' + t.title + '</a>';
      }).join(' &middot; ');
    if (afterEl && afterEl.nextSibling) {
      main.insertBefore(box, afterEl.nextSibling);
    } else if (afterEl) {
      main.appendChild(box);
    } else {
      main.insertBefore(box, main.firstChild);
    }
  }

  function renderNav() {
    fetch(BASE + '/shared-assets/tools.json')
      .then(function (r) { return r.json(); })
      .then(function (tools) {
        var selfSlug = location.pathname.split('/').filter(Boolean)[0] || '';
        var selfEntry = null;
        for (var i = 0; i < tools.length; i++) { if (tools[i].slug === selfSlug) { selfEntry = tools[i]; break; } }

        var badgeEl = renderPrivacyBadge(selfEntry);
        renderClusterNav(tools, selfEntry, badgeEl);

        var items = tools
          .filter(function (t) { return t.slug !== selfSlug; })
          .map(function (t) {
            return '<li><a href="' + BASE + '/' + t.slug + '/">' + t.title + '</a><p>' + t.desc + '</p></li>';
          })
          .join('');
        var nav = document.createElement('nav');
        nav.className = 'more-tools';
        nav.innerHTML = '<h2>More free tools</h2><ul>' + items + '</ul>';
        document.body.appendChild(nav);
        renderFooter();
      })
      .catch(function () { renderFooter(); });
  }

  // ---- 2c. JSON-LD enhancement (SEO_NOTES item 7) ----
  // Adds fields to the page's own WebApplication schema if it didn't already include
  // them, so every already-shipped page benefits without a per-page edit. Google's
  // indexer executes page JS before reading structured data, so a script-added field
  // here is read the same as one authored directly in the page's HTML.
  function enhanceJsonLd() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var el = scripts[i];
      var data;
      try { data = JSON.parse(el.textContent); } catch (e) { continue; }
      if (!data || data['@type'] !== 'WebApplication') continue;
      var changed = false;
      if (!data.browserRequirements) {
        data.browserRequirements = 'Requires HTML5 File API. JavaScript must be enabled.';
        changed = true;
      }
      if (!data.permissions) {
        data.permissions = 'Runs entirely client-side. No file data is uploaded to a server.';
        changed = true;
      }
      if (changed) {
        try { el.textContent = JSON.stringify(data, null, 2); } catch (e) {}
      }
    }
  }

  // ---- 3. Fallback consent banner (our own UI) ----
  // Shown only via "Cookie preferences" when Google's own consent dialog isn't present
  // (e.g. this visitor's region variant isn't configured with one, an ad blocker
  // interfered, or Google's script hasn't loaded yet). Never shown automatically.
  function showConsentBanner() {
    if (document.getElementById('consent-banner')) return; // already open
    var bar = document.createElement('div');
    bar.id = 'consent-banner';
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;background:var(--card,#1a2532);color:var(--text,#e8edf2);' +
      'padding:1rem;border-top:1px solid var(--border,#2a3745);z-index:999999;display:flex;flex-wrap:wrap;' +
      'gap:.8rem;align-items:center;justify-content:space-between;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:.9rem;';
    bar.innerHTML =
      '<span style="flex:1;min-width:240px;">This site uses cookies for analytics and ads (Google, AADS). ' +
      'Your files never leave your browser regardless of this choice. See our ' +
      '<a href="' + BASE + '/privacy-policy/" style="color:var(--accent,#4fa8ff);">Privacy Policy</a>.</span>' +
      '<span style="display:flex;gap:.6rem;flex-shrink:0;">' +
      '<button id="consent-reject" style="background:transparent;border:1px solid var(--border,#2a3745);' +
      'color:var(--text,#e8edf2);border-radius:8px;padding:.5rem 1rem;cursor:pointer;font-size:.85rem;">Reject non-essential</button>' +
      '<button id="consent-accept" style="background:var(--accent,#4fa8ff);border:none;color:#04121f;' +
      'border-radius:8px;padding:.5rem 1rem;font-weight:600;cursor:pointer;font-size:.85rem;">Accept</button>' +
      '</span>';
    document.body.appendChild(bar);
    document.getElementById('consent-accept').addEventListener('click', function () {
      grantConsent();
      bar.remove();
    });
    document.getElementById('consent-reject').addEventListener('click', function () {
      rejectConsent();
      bar.remove();
    });
  }

  // ---- 4. Boot (assumes this script tag has the `defer` attribute, so DOM is parsed) ----
  // The hub page (`data-hub` on the script tag) already has its own hero header and its
  // own full tool grid, so it skips the injected header/nav/badge/cluster-nav and only
  // gets the footer (with the Privacy Policy link) plus the same consent/analytics/ads
  // behavior and JSON-LD enhancement.
  var scriptEl = document.currentScript;
  var isHub = !!(scriptEl && scriptEl.hasAttribute('data-hub'));

  function boot() {
    enhanceJsonLd();

    if (isHub) {
      renderFooter();
    } else {
      renderHeader();
      renderNav(); // renders badge/cluster-nav/footer once tools.json resolves (or footer-only on failure)
    }

    loadGoogleTags(); // always: Consent Mode + Google's own consent message govern behavior

    if (consentChoice === 'accepted') {
      injectAd();
    } else if (consentChoice === 'rejected') {
      // respect prior choice, do nothing
    } else if (isConsentRegion()) {
      // No prior choice, and this region legally requires one: withhold the AADS ad
      // until a real consent decision arrives (Google's own message, or "Cookie
      // preferences" in the footer) -- never show our own banner unprompted here.
    } else {
      // No prior choice, and this region has no legal consent requirement: enable the
      // ad by default rather than interrupting the visitor with a prompt they don't
      // need. They can still open "Cookie preferences" in the footer at any time.
      injectAd();
      try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch (e) {}
    }
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
