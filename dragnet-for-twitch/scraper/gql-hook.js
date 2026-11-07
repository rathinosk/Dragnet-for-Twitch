// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Main-world hook, registered by the background only while settings.twitchApi is on
// Twitch's own drops pages fetch their data as JSON from
// gql.twitch.tv; this copies those responses as they arrive and posts them to the content
// script (scraper/gql.js). It sends no request, reads no headers or cookies, never alters
// or delays Twitch's response, and never throws into Twitch's code.
//
// The content script loads at document_idle, after the first responses may have arrived,
// so the newest response per operation and variables is kept here and posted again when the
// content script asks ('dragnet-gql-replay'). Besides the drops pages, it also copies the
// drops operations Twitch's player sends on channel pages, which only the stream diagnostics
// save (diag/watch.js, settings.diagnostics); nothing is kept or posted on other pages.

(() => {
  if (window.__dragnetGqlHook) return;
  Object.defineProperty(window, '__dragnetGqlHook', { value: true });

  const GQL_URL = 'https://gql.twitch.tv/gql';
  const DROPS_PATH = /^\/drops\//;
  const CHANNEL_PATH = /^\/[A-Za-z0-9_]{2,25}\/?$/;
  const kindOf = (path) => (DROPS_PATH.test(path) ? 'drops' : CHANNEL_PATH.test(path) ? 'stream' : '');
  // Keep in sync with GQL_OPERATION in core/gql.js: drops operations only, so nothing else
  // the page loads (followed channels in the side nav, chat) is ever copied.
  const OPERATION = /drop|inventory|campaign|reward|claim/i;
  // On channel pages only operations named for drops: the broader pattern also matches
  // channel points and charity campaigns there (seen live 2026-10-06).
  const STREAM_OPERATION = /drop/i;
  const MAX_KEPT = 40;
  const kept = new Map();
  const origFetch = window.fetch;
  const post = (item) => window.postMessage({ source: 'dragnet-gql', ...item }, location.origin);

  // operationName and variables of each request in a body (one object, or an array for a
  // batch), in order; the response holds the results in the same order.
  function requestOps(body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : null;
      return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
        operationName: typeof r?.operationName === 'string' ? r.operationName : '',
        variables: r?.variables && typeof r.variables === 'object' ? r.variables : null,
      }));
    } catch {
      return [];
    }
  }

  async function copy(response, ops, pattern) {
    try {
      const json = await response.clone().json();
      const results = Array.isArray(json) ? json : [json];
      results.forEach((result, i) => {
        const operationName = ops[i]?.operationName || result?.extensions?.operationName;
        if (typeof operationName !== 'string' || !pattern.test(operationName) || !result?.data) return;
        const item = { operationName, variables: ops[i]?.variables ?? null, data: result.data, at: Date.now() };
        // One per operation and variables (a details query per campaign).
        const key = operationName + JSON.stringify(item.variables).slice(0, 500);
        kept.delete(key);
        kept.set(key, item);
        if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
        post(item);
      });
    } catch {
      // not JSON, or the body was consumed: ignore
    }
  }

  window.fetch = function dragnetFetch(input, init) {
    const promise = origFetch.apply(window, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const kind = kindOf(location.pathname);
      if (kind && typeof url === 'string' && url.startsWith(GQL_URL)) {
        const ops = requestOps(init?.body);
        const pattern = kind === 'stream' ? STREAM_OPERATION : OPERATION;
        promise.then((response) => { if (response.ok) copy(response, ops, pattern); }, () => {});
      }
    } catch {
      // never break Twitch's request
    }
    return promise;
  };

  // In-app navigation: forget what was kept, except between the drops pages.
  let lastPath = location.pathname;
  setInterval(() => {
    const path = location.pathname;
    if (path === lastPath) return;
    if (!(kindOf(path) === 'drops' && kindOf(lastPath) === 'drops')) kept.clear();
    lastPath = path;
  }, 1000);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'dragnet-gql-replay') return;
    if (!kindOf(location.pathname)) return;
    for (const item of kept.values()) post(item);
  });
})();
