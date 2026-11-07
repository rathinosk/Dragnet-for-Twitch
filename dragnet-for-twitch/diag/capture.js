// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Diagnostics (diag/README.md). Runs in the Twitch tab's content script, on
// request from diag/diagnostics.html: a full sanitized page snapshot (the same steps as
// tools/capture-snapshot.js, which stays as the console version) and a dry-run probe of
// the parsers against the page as it is; on a channel page, a probe of the stream finders
// and a snapshot of the player, the chat input bar and the toasts, without the chat. Also
// exports the sanitizer used by watch.js.

import { selfCheck, queryAll, STREAM_CLAIM_GUESSES } from '../scraper/selectors.js';
import { parseInventoryPage, claimNowButtons } from '../scraper/inventory-page.js';
import { scanCampaigns, scanRunning } from '../scraper/run.js';
import { useLocale } from '../scraper/tokens.js';
import { findAnomalies, findStreamAnomalies } from './watch.js';
import { readWatchState } from '../scraper/stream.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until the DOM stops mutating for `quietMs`, or `timeoutMs` passes.
const settle = (quietMs = 400, timeoutMs = 5000) =>
  new Promise((resolve) => {
    let timer;
    const done = () => { obs.disconnect(); clearTimeout(timer); resolve(); };
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, quietMs);
    setTimeout(done, timeoutMs);
  });

async function scrollToEnd() {
  const log = [];
  let last = -1, same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const scroller = document.querySelector('.simplebar-scroll-content, [data-test-selector="root-scrollable"]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    await sleep(700);
    const h = document.documentElement.scrollHeight + (scroller ? scroller.scrollHeight : 0);
    log.push(h);
    same = h === last ? same + 1 : 0;
    last = h;
  }
  window.scrollTo(0, 0);
  return log;
}

async function loadMore(max) {
  let clicks = 0;
  for (let i = 0; i < max; i++) {
    const btn = [...document.querySelectorAll('main button')].find((b) => /^load more$/i.test(b.textContent.trim()));
    if (!btn) break;
    btn.click();
    clicks++;
    await sleep(800);
    await settle();
  }
  return clicks;
}

// Single-open accordion: open one card at a time and keep a clone of each body.
async function expandAll(progress) {
  const sel = 'main .accordion-header button[aria-expanded]';
  const oldZoom = document.body.style.zoom;
  document.body.style.zoom = '25%';
  await sleep(1000);
  const total = document.querySelectorAll(sel).length;
  const bodies = new Map();
  let failed = 0;
  try {
    for (let i = 0; i < total; i++) {
      const b = document.querySelectorAll(sel)[i];
      if (!b) break;
      progress(`Diagnostics: card ${i + 1} of ${total}`);
      if (b.getAttribute('aria-expanded') !== 'true') {
        b.scrollIntoView({ behavior: 'instant', block: 'center' });
        await sleep(60);
        b.click();
        for (let t = 0; t < 30 && b.getAttribute('aria-expanded') !== 'true'; t++) await sleep(100);
        if (b.getAttribute('aria-expanded') !== 'true') { failed++; continue; }
        await settle(300, 3000);
      }
      const body = b.closest('.accordion-header')?.nextElementSibling;
      if (body && body.childElementCount) bodies.set(i, body.cloneNode(true));
      else failed++;
    }
  } finally {
    document.body.style.zoom = oldZoom;
    window.scrollTo(0, 0);
  }
  return { bodies, total, failed };
}

function stitch(clone, bodies) {
  const buttons = clone.querySelectorAll('main .accordion-header button[aria-expanded]');
  bodies.forEach((body, i) => {
    const b = buttons[i];
    const slot = b?.closest('.accordion-header')?.nextElementSibling;
    if (!slot) return;
    const copy = body.cloneNode(true);
    copy.setAttribute('data-dragnet-stitched', '');
    slot.replaceWith(copy);
    b.setAttribute('aria-expanded', 'true');
  });
}

/** The viewer's login name (Twitch's `login` cookie), to scrub it from captures. */
export const loginName = () => (document.cookie.match(/(?:^|; )login=([^;]+)/) || [])[1] ?? '';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sanitized outerHTML of a clone of `el`: no scripts, styles, svg contents, event handlers,
 * account nav, followed-channel list or avatars; the login name replaced by USER.
 * @param {Element} el
 * @param {(clone: Element) => void} [prepare]  runs on the clone first (stitching)
 */
export function sanitize(el, prepare) {
  const clone = el.cloneNode(true);
  prepare?.(clone);
  clone.querySelectorAll('script, style, noscript, link, iframe, canvas, video, audio').forEach((n) => n.remove());
  clone.querySelectorAll('svg').forEach((s) => {
    // Keep a <title> (the "Claimed" button's only label), drop the drawing.
    const title = s.querySelector('title')?.textContent ?? '';
    s.textContent = '';
    if (title) s.append(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'), { textContent: title }));
  });
  clone.querySelectorAll('nav[data-a-target="top-nav-container"], #side-nav, [data-a-target="side-nav-bar"], img[src*="jtv_user_pictures"], img[src*="amazon-adsystem"]')
    .forEach((n) => n.remove());
  clone.querySelector?.('body')?.style.removeProperty('zoom');
  const user = loginName();
  const userRe = user ? new RegExp(escapeRe(user), 'gi') : null;
  const all = [clone, ...clone.querySelectorAll('*')];
  for (const n of all) {
    for (const a of [...n.attributes]) {
      if (a.name.startsWith('on') || a.name === 'nonce' || a.name === 'srcset') n.removeAttribute(a.name);
      else if (userRe && userRe.test(a.value)) n.setAttribute(a.name, a.value.replace(userRe, 'USER'));
      if (userRe) userRe.lastIndex = 0;
    }
  }
  let html = clone.outerHTML;
  if (userRe) html = html.replace(userRe, 'USER');
  return html;
}

// The chat input bar holds the Drops & More button, the likeliest home of a claim prompt, so
// it is kept; the chat log, its messages and the input field are not.
const CHAT_BAR = '[data-test-selector="chat-input-buttons-container"]';
const CHAT_PARTS = '[role="log"], [data-a-target^="chat-line"], [data-a-target="chat-input"], textarea, [contenteditable], [data-test-selector*="chat" i]';

/** Removes the chat log, messages and input from a clone (for stream captures). */
export function stripChat(clone) {
  for (const n of [...clone.querySelectorAll(CHAT_PARTS)]) {
    const wrapper = n.matches('[data-test-selector*="chat" i]') && !n.matches('[role="log"], [data-a-target^="chat-line"]');
    if (wrapper && (n.matches(CHAT_BAR) || n.querySelector(CHAT_BAR) || n.closest(CHAT_BAR))) continue;
    n.remove();
  }
}

function collectFacts(page, mode, extra) {
  const count = (sel) => document.querySelectorAll(sel).length;
  const tally = (attr) => {
    const m = {};
    document.querySelectorAll(`[${attr}]`).forEach((n) => { const v = n.getAttribute(attr); m[v] = (m[v] || 0) + 1; });
    return m;
  };
  const links = {};
  document.querySelectorAll('a[href]').forEach((a) => {
    const p = a.getAttribute('href').replace(/[0-9a-f-]{8,}/gi, ':id').replace(/\/[^/]+$/, '/…');
    links[p] = (links[p] || 0) + 1;
  });
  return {
    capturedAt: new Date().toISOString(),
    url: location.pathname + location.search,
    page,
    mode,
    lang: document.documentElement.lang,
    title: document.title,
    ...extra,
    counts: {
      expandedFalse: count('[aria-expanded="false"]'),
      expandedTrue: count('[aria-expanded="true"]'),
      buttons: count('button'),
      images: count('img'),
      timeElements: count('time[datetime]'),
      progressbars: count('[role="progressbar"], progress'),
      headings: count('h1,h2,h3,h4,h5'),
    },
    dataATarget: tally('data-a-target'),
    dataTestSelector: tally('data-test-selector'),
    roles: tally('role'),
    linkPatterns: links,
    buttonLabels: [...new Set([...document.querySelectorAll('button')].map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '')).filter(Boolean))].slice(0, 80),
    headings: [...document.querySelectorAll('h1,h2,h3,h4,h5')].map((h) => h.tagName + ': ' + h.textContent.trim().slice(0, 60)).slice(0, 80),
  };
}

const pageOf = () => /^\/drops\/(campaigns|inventory)\/?$/.exec(location.pathname)?.[1] ?? null;

// A Dragnet scan clicks the same accordion and Load More button: let it finish first.
async function whenScanIdle(progress) {
  for (let i = 0; scanRunning() && i < 600; i++) {
    if (i === 0) progress('Diagnostics: waiting for the Dragnet scan to finish');
    await sleep(500);
  }
}

let busy = false;

/**
 * Full snapshot of the current drops page.
 * @param {{expand?: boolean, label?: string, loadMore?: number}} options
 * @returns {Promise<{name: string, html: string, facts: object}>}
 */
export async function capture({ expand = false, label = '', loadMore: maxLoadMore = 10 } = {}) {
  const page = pageOf();
  if (!page) throw new Error('This tab is not on /drops/campaigns or /drops/inventory.');
  if (busy) throw new Error('A capture is already running in this tab.');
  busy = true;
  const badge = statusBadge();
  try {
    await whenScanIdle(badge.show);
    badge.show('Diagnostics: capturing');
    await settle();
    const scrollHeights = await scrollToEnd();
    const loadMoreClicks = page === 'inventory' ? await loadMore(Math.max(0, Math.min(40, maxLoadMore))) : 0;
    const expanded = page === 'campaigns' && expand ? await expandAll(badge.show) : null;
    badge.remove();
    await settle();
    const mode = (label || (expanded ? 'expanded' : 'collapsed')).replace(/[^\w.-]+/g, '-').slice(0, 40);
    const html = '<!doctype html>\n' + sanitize(document.documentElement, expanded ? (c) => stitch(c, expanded.bodies) : null);
    const facts = collectFacts(page, mode, {
      scrollHeights,
      loadMoreClicks,
      expandedCount: expanded?.bodies.size ?? 0,
      cardCount: expanded?.total ?? null,
      expandFailed: expanded?.failed ?? null,
    });
    return { name: `${page}-${mode}`, html, facts };
  } finally {
    badge.remove();
    busy = false;
  }
}

/**
 * Dry run: parse the page as it is (no clicks) and report what the parsers see.
 * @returns {Promise<object>}
 */
export async function probe() {
  const page = pageOf();
  if (!page) throw new Error('This tab is not on /drops/campaigns or /drops/inventory.');
  const lang = document.documentElement.lang;
  const out = { page, lang, localeSupported: !!useLocale(lang), at: new Date().toISOString(), scanRunning: scanRunning() };
  out.selfCheck = selfCheck(document, page);
  if (page === 'inventory') {
    const { data, warnings } = parseInventoryPage(document);
    out.warnings = warnings;
    out.progressBlocks = data.progress.map((b) => ({
      title: b.title,
      endDate: b.endDate,
      rows: b.rows.map((r) => ({ rewards: r.rewards.map((w) => w.name), percent: r.percent, requiredMinutes: r.requiredMinutes, claimable: r.claimable })),
    }));
    out.claimNowButtons = claimNowButtons(document).length;
    out.claims = data.claims.length;
    out.oldestDays = Math.round(data.oldestAgeMs / 864e5);
    out.hasLoadMore = data.hasLoadMore;
    out.earned = data.earned.map((e) => `${e.name} (${e.type})`);
  } else {
    // Open nothing: headers plus any bodies already rendered.
    const { data, warnings } = await scanCampaigns(document, { select: () => [] });
    out.warnings = warnings;
    out.cards = data.campaigns.length;
    out.bodiesRead = data.campaigns.filter((c) => c.bodyParsed).length;
    out.drops = data.campaigns.reduce((n, c) => n + c.drops.length, 0);
    out.sections = [...new Set(data.campaigns.map((c) => c.section))];
  }
  out.anomalies = findAnomalies(document, page).map(({ kind, key, summary, html }) => ({ kind, key, summary, bytes: html.length }));
  return out;
}

/**
 * Dry run on a channel page: what the watch state reads and what the stream watcher would save.
 * @returns {Promise<object>}
 */
export async function probeStream() {
  if (pageOf()) throw new Error('This tab is on a drops page: use Probe.');
  const count = (name) => queryAll(document, name).elements.length;
  return {
    page: 'stream',
    url: `/${location.pathname.split('/')[1] ?? ''}`,
    lang: document.documentElement.lang,
    at: new Date().toISOString(),
    watchState: readWatchState(document, location.pathname),
    hooks: {
      streamDropsEnabled: count('streamDropsEnabled'),
      streamGameLink: count('streamGameLink'),
      streamToast: count('streamToast'),
      streamDropsButton: count('streamDropsButton'),
      claimGuesses: STREAM_CLAIM_GUESSES.map((css) => `${css}: ${document.querySelectorAll(css).length}`),
    },
    anomalies: findStreamAnomalies(document).map(({ kind, key, summary, html }) => ({ kind, key, summary, bytes: html.length })),
  };
}

/** The sanitized parts of a channel page (chat log and input left out) and the HTML made of them. */
export function streamParts(doc = document) {
  const parts = [
    ['main', doc.querySelector('main')],
    ['chat input bar', doc.querySelector(CHAT_BAR)],
    ['toasts', doc.querySelector('[data-test-selector="onsite-notifications-toast-manager"]')],
  ].filter(([, el]) => el);
  const html = '<!doctype html>\n<html><body>\n'
    + parts.map(([name, el]) => `<!-- ${name} -->\n${sanitize(el, stripChat)}`).join('\n')
    + '\n</body></html>';
  return { parts, html };
}

/**
 * Snapshot of a channel page: the player column (<main>), the chat input bar and the toast
 * area, each sanitized without the chat log or input.
 * @param {{label?: string}} options
 * @returns {Promise<{name: string, html: string, facts: object}>}
 */
export async function captureStream({ label = '' } = {}) {
  if (pageOf()) throw new Error('This tab is on a drops page: use Snapshot.');
  await settle();
  const { parts, html } = streamParts();
  const mode = (label || 'stream').replace(/[^\w.-]+/g, '-').slice(0, 40);
  const facts = collectFacts('stream', mode, { parts: parts.map(([name]) => name), watchState: readWatchState(document, location.pathname) });
  facts.url = `/${location.pathname.split('/')[1] ?? ''}`;
  return { name: `stream-${mode}`, html, facts };
}

function statusBadge() {
  let el = null;
  return {
    show(message) {
      if (!el) {
        el = document.createElement('div');
        Object.assign(el.style, {
          position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647',
          padding: '6px 10px', borderRadius: '6px', font: '13px/1.4 system-ui, sans-serif',
          background: '#5b21b6', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.4)', pointerEvents: 'none',
        });
        el.setAttribute('role', 'status');
        document.body.append(el);
      }
      el.textContent = message;
    },
    remove() {
      el?.remove();
      el = null;
    },
  };
}
