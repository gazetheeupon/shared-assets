/*
 * RunLocal shared site chrome + consent + analytics/ads loader.
 * One include (`<script defer src=".../shared-assets/site.js"></script>`) gives a
 * new tool page: header, "more free tools" nav (built live from tools.json),
 * footer with Privacy Policy link, a consent banner gating Google Analytics /
 * AdSense / the AADS ad, and (if the page has a `<div id="ad-slot">`) the ad
 * itself. Nothing here ever touches file content the user drops into a tool;
 * this only concerns page-view analytics and ad delivery.
 */
(function () {
  'use strict';

  var BASE = 'https://gazetheeupon.github.io';
  var GA_ID = 'G-S56YMT587E';
  var ADSENSE_CLIENT = 'ca-pub-9691619403787602';
  var DEFAULT_AADS_UNIT = '2455639'; // catchall unit, used unless #ad-slot sets data-aads-unit
  var CONSENT_KEY = 'runlocal_consent_v1';

  // ---- 1. Consent Mode v2 defaults. Must run before any GA/Ads script loads. ----
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500
  });

  var consentChoice = null;
  try { consentChoice = localStorage.getItem(CONSENT_KEY); } catch (e) {}

  function loadScript(src, attrs) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (attrs) { for (var k in attrs) { if (attrs.hasOwnProperty(k)) s.setAttribute(k, attrs[k]); } }
    document.head.appendChild(s);
    return s;
  }

  function injectAd() {
    var slot = document.getElementById('ad-slot');
    if (!slot) return;
    var unit = slot.getAttribute('data-aads-unit') || DEFAULT_AADS_UNIT;
    slot.innerHTML =
      '<!-- BEGIN AADS AD UNIT ' + unit + ' -->' +
      '<div id="frame" style="width:100%;margin:auto;position:relative;z-index:99998;">' +
      '<iframe data-aa="' + unit + '" src="//acceptable.a-ads.com/' + unit + '/?size=Adaptive" ' +
      'style="border:0;padding:0;width:70%;height:auto;overflow:hidden;display:block;margin:auto"></iframe>' +
      '</div><!-- END AADS AD UNIT ' + unit + ' -->';
  }

  function enableAnalyticsAndAds() {
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + GA_ID);
    gtag('js', new Date());
    gtag('config', GA_ID);
    loadScript(
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + ADSENSE_CLIENT,
      { crossorigin: 'anonymous' }
    );
    injectAd();
  }

  function grantConsent() {
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted'
    });
    try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch (e) {}
    enableAnalyticsAndAds();
  }

  function rejectConsent() {
    try { localStorage.setItem(CONSENT_KEY, 'rejected'); } catch (e) {}
    // Deliberately does nothing else: no GA, no AdSense, no AADS ad this session.
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
      'view-source friendly, redistribution not permitted.</div>';
    document.body.appendChild(footer);
  }

  function renderNav() {
    fetch(BASE + '/shared-assets/tools.json')
      .then(function (r) { return r.json(); })
      .then(function (tools) {
        var selfSlug = location.pathname.split('/').filter(Boolean)[0] || '';
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

  // ---- 3. Consent banner ----
  function showConsentBanner() {
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
  // own full tool grid, so it skips the injected header/nav and only gets the footer
  // (with the Privacy Policy link) plus the same consent/analytics/ads behavior.
  var scriptEl = document.currentScript;
  var isHub = !!(scriptEl && scriptEl.hasAttribute('data-hub'));

  function boot() {
    if (isHub) {
      renderFooter();
    } else {
      renderHeader();
      renderNav(); // renders footer once tools.json resolves (or immediately on failure)
    }
    if (consentChoice === 'accepted') {
      enableAnalyticsAndAds();
    } else if (consentChoice === 'rejected') {
      // respect prior choice, do nothing
    } else {
      showConsentBanner();
    }
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
