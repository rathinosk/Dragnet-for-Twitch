// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Content-script loader, injected on every twitch.tv page. Twitch is a single-page app, so
// reaching the drops pages by in-app navigation does not inject a new content script:
// this script watches the URL (Navigation API event, plus a 1 s poll as a fallback) and
// runs the scraper when a drops page is shown. Manifest content scripts cannot be ES
// modules, so it import()s the real entry point (scraper/run.js) only then; the modules
// are listed in web_accessible_resources. The import runs in the isolated world.
//
// On channel pages it also reports what the tab is watching, for stall detection (while
// settings.stallDetect is on, scraper/stream.js), and starts the stream diagnostics watcher
// (while settings.diagnostics is on, diag/watch.js).

(() => {
  // Keep in sync with detectPage() in scraper/run.js.
  const DROPS_PAGE = /^\/drops\/(campaigns|inventory)\/?$/;
  let lastPath = '';
  let entry = null;
  let poll = 0;

  // Twitch data (scraper/gql.js), while settings.twitchApi is on: collect the GQL responses
  // the main-world hook (scraper/gql-hook.js) posts. Off, the module is never loaded.
  let gql = null;
  let settings = null;
  async function syncCollector() {
    try {
      if (settings?.twitchApi === true) {
        gql ??= import(chrome.runtime.getURL('scraper/gql.js'));
        (await gql).startCollector();
      } else if (gql) {
        (await gql).stopCollector();
      }
    } catch (err) {
      console.error('[Dragnet]', err);
    }
  }
  function applySettings(value) {
    settings = value && typeof value === 'object' ? value : {};
    syncCollector();
    reportWatch(true);
    syncStreamWatch();
    syncDropAlert();
  }
  chrome.storage.sync.get('settings').then(({ settings: value }) => applySettings(value), () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) applySettings(changes.settings.newValue);
  });

  const onDropsPage = () => /^\/drops\//.test(location.pathname);

  // Stall detection (core/stall.js): on a channel page, what it plays, on load, on in-app
  // navigation and every minute; null once when it leaves the channel page. Off: nothing.
  let stream = null;
  let reported = false;
  async function reportWatch(force = false) {
    try {
      if (!chrome.runtime?.id) return;
      if (settings?.stallDetect === false) {
        reported = false;
        return;
      }
      let state = null;
      if (!onDropsPage()) {
        stream ??= import(chrome.runtime.getURL('scraper/stream.js'));
        state = (await stream).readWatchState(document, location.pathname);
      }
      if (!state && !reported && !force) return;
      reported = !!state;
      await chrome.runtime.sendMessage({ type: 'dragnet:watch', state });
    } catch (err) {
      if (chrome.runtime?.id) console.warn('[Dragnet] watch', err);
    }
  }
  const watchTimer = setInterval(() => reportWatch(), 60000);

  // Drop alert (settings.dropAlert): on a channel page, tell the background when the page
  // starts signalling a drop (the Drops & More dot, a drops toast) so it checks the inventory.
  // Reported when the signal first appears or changes, not while it stays; the background
  // rate-limits the check. Off, or on the drops pages: no observer.
  let alertObserver = null;
  let alertTimer = 0;
  let lastSignal = '';
  async function syncDropAlert() {
    try {
      const want = settings?.dropAlert === true && !onDropsPage();
      if (!want) {
        alertObserver?.disconnect();
        alertObserver = null;
        clearTimeout(alertTimer);
        lastSignal = '';
        return;
      }
      if (alertObserver) return;
      stream ??= import(chrome.runtime.getURL('scraper/stream.js'));
      const { readDropSignal } = await stream;
      const scan = async () => {
        if (!chrome.runtime?.id) return;
        const signal = readDropSignal(document);
        if (signal && signal !== lastSignal) {
          await chrome.runtime.sendMessage({ type: 'dragnet:drop-signal' }).catch(() => {});
        }
        lastSignal = signal;
      };
      alertObserver = new MutationObserver(() => {
        clearTimeout(alertTimer);
        alertTimer = setTimeout(scan, 1500);
      });
      alertObserver.observe(document.body, { childList: true, subtree: true });
      alertTimer = setTimeout(scan, 3000);
    } catch (err) {
      console.warn('[Dragnet] drop alert', err);
    }
  }

  // Stream diagnostics (diag/README.md): watch for on-stream claim prompts off the drops pages.
  let diagWatch = null;
  async function syncStreamWatch() {
    try {
      if (settings?.diagnostics === true && !onDropsPage()) {
        diagWatch ??= import(chrome.runtime.getURL('diag/watch.js'));
        (await diagWatch).watchStream({ twitchApi: settings.twitchApi === true });
      } else if (diagWatch) {
        (await diagWatch).stopStreamWatch();
      }
    } catch (err) {
      console.warn('[Dragnet] diagnostics', err);
    }
  }

  async function check() {
    if (!chrome.runtime?.id) {
      // extension reloaded or removed: this copy is orphaned
      clearInterval(poll);
      clearInterval(watchTimer);
      return;
    }
    if (location.pathname === lastPath) return;
    const wasDrops = /^\/drops\//.test(lastPath);
    lastPath = location.pathname;
    // Twitch data is kept per page: forget it on leaving a page other than the drops pages
    // and on arriving at them (a channel page may have collected some for diagnostics).
    if (!onDropsPage() || !wasDrops) gql?.then((m) => m.clearCollected(), () => {});
    if (settings) {
      reportWatch();
      // The player mounts a moment after an in-app navigation.
      setTimeout(reportWatch, 5000);
      syncStreamWatch();
      syncDropAlert();
    }
    if (!DROPS_PAGE.test(lastPath)) return;
    try {
      entry ??= import(chrome.runtime.getURL('scraper/run.js'));
      const { run } = await entry;
      await run();
    } catch (err) {
      console.error('[Dragnet]', err);
    }
  }

  // diag/diagnostics.html asks this tab for a probe or a snapshot (of a drops page or, with
  // `probe-stream` / `capture-stream`, a channel page), while the diagnostics setting is on
  // (diag/README.md). Only extension pages may ask.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'dragnet:diag' || sender.id !== chrome.runtime.id
      || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
    chrome.storage.sync.get('settings')
      .then(({ settings }) => {
        if (settings?.diagnostics !== true) throw new Error('Diagnostics are off (Dragnet settings, Danger Zone).');
        return import(chrome.runtime.getURL('diag/capture.js'));
      })
      .then((diag) => ({
        probe: () => diag.probe(),
        capture: () => diag.capture(message.options),
        'probe-stream': () => diag.probeStream(),
        'capture-stream': () => diag.captureStream(message.options),
      })[message.action]?.() ?? Promise.reject(new Error('Unknown action.')))
      .then((result) => sendResponse({ ok: true, result }), (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  });

  // The navigate event fires before the URL changes; check once it has.
  window.navigation?.addEventListener('navigate', () => setTimeout(check, 100));
  poll = setInterval(check, 1000);
  check();
})();
