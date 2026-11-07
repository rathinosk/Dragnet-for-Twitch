// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Diagnostics (diag/README.md), while settings.diagnostics is on. On every drops-page scan, looks for markup the
// scraper does not know yet and saves a sanitized copy of the surrounding block, once per
// distinct case, so a rare state (a claimable drop) is caught without anyone at the
// console. Saved under DIAG_KEY in chrome.storage.local; diag/diagnostics.html lists them.
//
// Cases:
// - claim-button: a button the parser takes for "Claim Now" (to check the live markup again).
// - claim-like: any button, link or role=button in <main> whose text or aria-label has the
//   word "claim" and that the parser does not take for "Claim Now".
// - full-bar: a progress bar at 100% with no claim button in its campaign block.
// - block: an in-progress campaign block, once per distinct set of button labels in it, so
//   a block that changes shape (bar replaced by something else) is saved again.
//
// With settings.twitchApi also on, recordGql saves scrubbed copies of the Twitch data (GQL
// responses) the page received, under DIAG_GQL_KEY, for the capture step.
//
// Stream watch: on other twitch.tv pages (channel pages), watchStream looks for
// the prompt Twitch shows when a drop completes while watching, which Dragnet has never
// captured: `stream:claim-like` (a control labelled "claim", other than channel points'
// "Claim Bonus", or one matching a guessed hook), `stream:drop-ui` (elements whose
// data-test-selector or data-a-target mentions drops, once per distinct set), and
// `stream:toast` (a toast or alert that mentions a drop or reward). The chat log and input
// are never captured (stripChat in capture.js).
//
// Each case has a check on the diagnostics page (diagChecks in sync storage, all on by
// default); the stream watch and the live watch follow changes at once, without a reload.
//
// Live watch (a setting on the diagnostics page): after the scan, keeps watching an open
// inventory tab and checks again whenever the page changes; optionally reloads the tab every
// few minutes, in case Twitch does not update progress in place. A label on the page says so.

import { HOOKS, STREAM_CLAIM_GUESSES, queryAll, itemRoot } from '../scraper/selectors.js';
import { claimNowButtons } from '../scraper/inventory-page.js';
import {
  KEYS, DIAG_KEY, DIAG_LIVE_KEY, DIAG_LIVE_MODES, DIAG_GQL_KEY, DIAG_CHECKS_KEY, STREAM_KINDS,
  sanitizeSettings, sanitizeDiagChecks, streamKinds,
} from '../core/schema.js';
import { scrubGql, viewerIdentities } from '../core/gql.js';
import { collected } from '../scraper/gql.js';
import { sanitize, stripChat, loginName, streamParts } from './capture.js';
import { readWatchState, channelOfPath } from '../scraper/stream.js';
import { stuckReason, stuckStep } from '../core/stall.js';

const MAX_ENTRIES = 40;
const MAX_HTML = 150_000;
const CLAIM_WORD = /\bclaim\b/i;

const squash = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const label = (el) => squash(el.textContent) || squash(el.getAttribute('aria-label')) || squash(el.getAttribute('title'));

function blocksOf(root) {
  const css = HOOKS.inventoryCampaignLink.css[0];
  const main = root.querySelector('main') ?? root.body ?? root;
  return [...main.querySelectorAll(css)].map((link) => ({ link, block: itemRoot(link, css, main) }));
}

/**
 * Unrecognized markup (and "Claim Now" buttons) on the page, as it is now.
 * @param {Document} root
 * @param {'campaigns'|'inventory'} page
 * @returns {{kind: string, key: string, summary: string, html: string}[]}
 */
export function findAnomalies(root, page) {
  const main = root.querySelector('main') ?? root.body;
  if (!main) return [];
  const found = [];
  const add = (kind, keyText, summary, el) => {
    const html = sanitize(el);
    found.push({ kind, key: `${page}:${kind}:${squash(keyText).slice(0, 200)}`, summary: squash(summary).slice(0, 300), html: html.slice(0, MAX_HTML) });
  };
  const blocks = page === 'inventory' ? blocksOf(root) : [];
  const blockOf = (el) => blocks.find((b) => b.block.contains(el))?.block ?? null;
  const context = (el) => blockOf(el) ?? itemRoot(el, 'button, a, [role="button"]', main).parentElement ?? el;

  const known = new Set(page === 'inventory' ? claimNowButtons(root) : []);
  for (const button of known) {
    add('claim-button', label(button) + ' ' + label(context(button)), `"${label(button)}" in: ${label(context(button))}`, context(button));
  }
  for (const el of main.querySelectorAll('button, a, [role="button"]')) {
    if (known.has(el)) continue;
    const text = squash(el.textContent);
    const aria = squash(el.getAttribute('aria-label'));
    if (!CLAIM_WORD.test(text) && !CLAIM_WORD.test(aria)) continue;
    const ctx = context(el);
    add('claim-like', `${el.tagName} ${text} ${aria} ${label(ctx)}`, `<${el.tagName.toLowerCase()}> "${text || aria}" in: ${label(ctx)}`, ctx);
  }
  if (page === 'inventory') {
    for (const bar of queryAll(root, 'inventoryProgressBar').elements) {
      const value = Number.parseFloat(bar.getAttribute('aria-valuenow') ?? '');
      if (!(value >= 100)) continue;
      const block = blockOf(bar);
      if (block && claimNowButtons(block).length) continue;
      const row = itemRoot(bar, HOOKS.inventoryProgressBar.css[0], block ?? main);
      add('full-bar', label(row), `100% without "Claim Now": ${label(row)}`, block ?? row);
    }
    for (const { link, block } of blocks) {
      const buttons = [...block.querySelectorAll('button, [role="button"]')].map(label).sort();
      const bars = queryAll(block, 'inventoryProgressBar').elements.length;
      add('block', `${label(link)} | bars:${bars > 0} | ${buttons.join(' | ')}`,
        `${label(link)}: ${bars} bar(s), buttons [${buttons.join(', ')}]`, block);
    }
  }
  return found;
}

/**
 * Saves anomalies not saved before (by key). Content scripts in several Twitch tabs share
 * the twitch.tv origin, so a Web Lock serializes their read-modify-write of DIAG_KEY.
 * @returns {Promise<number>} entries added
 */
export async function recordAnomalies(root, page) {
  return saveCaptures(findAnomalies(root, page), location.pathname);
}

async function saveCaptures(found, url, page = null) {
  if (!found.length) return 0;
  const write = async () => {
    const { [DIAG_KEY]: stored } = await chrome.storage.local.get(DIAG_KEY);
    const list = Array.isArray(stored) ? stored : [];
    const keys = new Set(list.map((e) => e.key));
    const at = new Date().toISOString();
    const added = found.filter((f) => !keys.has(f.key) && keys.add(f.key))
      .map((f) => ({ ...f, at, url, lang: document.documentElement.lang, ...(page ? { page } : {}) }));
    if (added.length) await chrome.storage.local.set({ [DIAG_KEY]: [...list, ...added].slice(-MAX_ENTRIES) });
    return added.length;
  };
  return navigator.locks ? navigator.locks.request('dragnet-diag', write) : write();
}

// Stream watch ------------------------------------------------------------------

// Channel points' button shares the chat input bar; it is not a drop.
const BONUS = /\bclaim bonus\b/i;
const DROP_HOOK = /drop/i;
const NOT_DROP_HOOK = /dropdown|backdrop|droplet/i;
const CHAT_LOG = '[role="log"], [data-a-target^="chat-line"]';
const TOASTS = '[data-a-target="toast"], [role="alert"], [role="status"], [data-test-selector="onsite-notification-toast__mouse-enter-detector"]';

const inChat = (el) => !!el.closest(CHAT_LOG);
const hooksOf = (el) => ['data-test-selector', 'data-a-target'].map((a) => el.getAttribute(a)).filter(Boolean);

/** The nearest small container of `el`: a few levels up, short of the chat and the video. */
function streamContext(el, body) {
  let ctx = el;
  for (let i = 0, p = el.parentElement; i < 6 && p && p !== body; i++, p = p.parentElement) {
    if ((p.textContent ?? '').length > 1500 || p.querySelector('video, [role="log"]')) break;
    ctx = p;
  }
  return ctx;
}

const sanitizeStream = (el) => sanitize(el, stripChat).slice(0, MAX_HTML);

const ALL_STREAM_KINDS = Object.values(STREAM_KINDS);

/**
 * Markup on a channel page that may be the on-stream drop claim prompt, as it is now.
 * @param {Document} root
 * @param {string[]} [kinds]  which to look for: 'claim-like', 'drop-ui', 'toast' (default all)
 * @returns {{kind: string, key: string, summary: string, html: string}[]}
 */
export function findStreamAnomalies(root, kinds = ALL_STREAM_KINDS) {
  const body = root.body ?? root;
  if (!body?.querySelectorAll) return [];
  const want = new Set(kinds);
  const found = [];
  const add = (kind, keyText, summary, html) => {
    found.push({ kind: `stream:${kind}`, key: `stream:${kind}:${squash(keyText).slice(0, 200)}`, summary: squash(summary).slice(0, 300), html });
  };

  const claims = want.has('claim-like');
  const guessed = new Set(claims ? STREAM_CLAIM_GUESSES.flatMap((css) => [...body.querySelectorAll(css)]) : []);
  const controls = new Set(claims ? [...body.querySelectorAll('button, a, [role="button"]'), ...guessed] : []);
  for (const el of controls) {
    if (inChat(el)) continue;
    const text = squash(el.textContent);
    const aria = squash(el.getAttribute('aria-label'));
    const isGuess = guessed.has(el);
    if (!isGuess && (!(CLAIM_WORD.test(text) || CLAIM_WORD.test(aria)) || BONUS.test(`${text} ${aria}`))) continue;
    const ctx = streamContext(el, body);
    add('claim-like', `${el.tagName} ${text} ${aria} ${hooksOf(el).join(' ')}`,
      `<${el.tagName.toLowerCase()}> "${text || aria}"${isGuess ? ' (guessed hook)' : ''} in: ${label(ctx).slice(0, 150)}`, sanitizeStream(ctx));
  }

  const dropEls = !want.has('drop-ui') ? [] : [...body.querySelectorAll('[data-test-selector], [data-a-target]')]
    .filter((el) => !inChat(el) && hooksOf(el).some((h) => DROP_HOOK.test(h) && !NOT_DROP_HOOK.test(h)));
  if (dropEls.length) {
    const byHook = new Map();
    for (const el of dropEls) {
      const hook = hooksOf(el).filter((h) => DROP_HOOK.test(h)).join(' ');
      if (!byHook.has(hook)) byHook.set(hook, el);
    }
    const hooks = [...byHook.keys()].sort();
    const html = hooks.map((h) => `<!-- ${h.replace(/--/g, '- -')} -->\n${sanitizeStream(streamContext(byHook.get(h), body))}`).join('\n');
    add('drop-ui', hooks.join(' | '), `drop hooks: ${hooks.join(', ')}`, html.slice(0, MAX_HTML));
  }

  for (const el of want.has('toast') ? body.querySelectorAll(TOASTS) : []) {
    if (inChat(el)) continue;
    const text = squash(el.textContent) || squash(el.querySelector('span[title]')?.getAttribute('title'));
    if (!/\b(drops?|rewards?)\b/i.test(text) || /^Dragnet\b/.test(text)) continue;
    add('toast', text, `toast: ${text}`, sanitizeStream(el));
  }
  return found;
}

/** The channel part of the path (`/<channel>`), so no further detail is kept. */
const streamUrl = () => `/${location.pathname.split('/')[1] ?? ''}`;

/** Saves stream anomalies not saved before (by key). @returns {Promise<number>} entries added */
export async function recordStream(root, kinds = ALL_STREAM_KINDS) {
  return saveCaptures(findStreamAnomalies(root, kinds), streamUrl(), 'stream');
}

let streamWatch = null;
let streamListening = false;

/**
 * Starts the stream watch on this (non-drops) page, or updates its options: a MutationObserver
 * on the whole page (toasts, the notification menu and the player overlay are outside
 * <main>), checking at most once a second, ignoring changes inside the chat log, for the
 * kinds whose checks are on (none on: no observer). With Twitch data and the gqlStream check
 * also on, the drops operations Twitch sent on this page are saved every minute.
 */
export async function watchStream({ twitchApi = false } = {}) {
  if (!streamListening) {
    streamListening = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[DIAG_CHECKS_KEY] && streamWatch && chrome.runtime?.id) {
        applyStreamChecks(sanitizeDiagChecks(changes[DIAG_CHECKS_KEY].newValue));
      }
    });
  }
  if (streamWatch) {
    streamWatch.twitchApi = twitchApi;
    return;
  }
  const state = { twitchApi, kinds: [], pending: 0, gqlAt: 0, observer: null, timer: 0, stuckTimer: 0, stuck: null };
  streamWatch = state;
  const { [DIAG_CHECKS_KEY]: stored } = await chrome.storage.sync.get(DIAG_CHECKS_KEY);
  if (streamWatch === state) applyStreamChecks(sanitizeDiagChecks(stored));
}

const streamAlive = () => {
  if (chrome.runtime?.id && !/^\/drops\//.test(location.pathname)) return true;
  stopStreamWatch();
  return false;
};

async function streamCheck() {
  const state = streamWatch;
  if (!state) return;
  state.pending = 0;
  if (!streamAlive() || !state.kinds.length) return;
  try {
    await recordStream(document, state.kinds);
  } catch (err) {
    if (chrome.runtime?.id) console.warn('[Dragnet] stream watch', err);
  }
}

async function streamGql() {
  const state = streamWatch;
  if (!state || !streamAlive() || !state.twitchApi) return;
  const latest = Math.max(0, ...collected().map((i) => i.at));
  if (latest <= state.gqlAt) return;
  state.gqlAt = latest;
  try {
    await recordGql('stream');
  } catch (err) {
    if (chrome.runtime?.id) console.warn('[Dragnet] stream watch', err);
  }
}

// A page that was watching a drops stream (this tab, this channel) and is not any more, for a
// few minutes: saves one `stream:stuck` capture per spell. The marker survives the reload in
// the tab's sessionStorage, so it is known the page was fine before.
const GOOD_KEY = 'dragnet:streamGood';
const sessionGet = () => { try { return sessionStorage.getItem(GOOD_KEY); } catch { return null; } };
const sessionSet = (v) => { try { sessionStorage.setItem(GOOD_KEY, v); } catch { /* blocked storage */ } };

async function stuckTick() {
  const state = streamWatch;
  if (!state || !streamAlive()) return;
  const channel = channelOfPath(location.pathname);
  if (!channel) {
    state.stuck = null;
    return;
  }
  const watch = readWatchState(document, location.pathname);
  const reason = stuckReason(watch);
  if (!reason && watch && !watch.offline) sessionSet(channel);
  const now = Date.now();
  const step = stuckStep(state.stuck, reason, now, sessionGet() === channel);
  state.stuck = step.track;
  if (!step.fire) return;
  try {
    const { html, parts } = streamParts();
    const minutes = Math.round((now - step.track.since) / 60000);
    const summary = `stuck: ${reason} for ${minutes} min on /${channel} (game "${watch?.game ?? ''}", drops tag ${watch?.dropsEnabled ?? '?'}, playing ${watch?.playing ?? '?'}); parts: ${parts.map(([n]) => n).join(', ')}`;
    await saveCaptures([{
      kind: 'stream:stuck',
      key: `stream:stuck:${channel}:${reason}:${new Date(step.track.since).toISOString().slice(0, 16)}`,
      summary,
      html: `<!-- ${JSON.stringify({ watch, reason, minutes }).replace(/--/g, '- -')} -->\n${html}`.slice(0, MAX_HTML),
    }], streamUrl(), 'stream');
  } catch (err) {
    if (chrome.runtime?.id) console.warn('[Dragnet] stream watch', err);
  }
}

/** Starts or stops the observer and the Twitch data timer to match the checks. */
function applyStreamChecks(checks) {
  const state = streamWatch;
  if (checks.streamStuck && !state.stuckTimer) {
    state.stuckTimer = setInterval(stuckTick, 30000);
  } else if (!checks.streamStuck && state.stuckTimer) {
    clearInterval(state.stuckTimer);
    state.stuckTimer = 0;
    state.stuck = null;
  }
  state.kinds = streamKinds(checks);
  if (state.kinds.length && !state.observer) {
    state.observer = new MutationObserver((records) => {
      if (state.pending || records.every((r) => r.target instanceof Element && inChat(r.target))) return;
      state.pending = setTimeout(streamCheck, 1000);
    });
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'disabled', 'data-a-target', 'data-test-selector'] });
  } else if (!state.kinds.length && state.observer) {
    state.observer.disconnect();
    state.observer = null;
    clearTimeout(state.pending);
    state.pending = 0;
  }
  // A kind switched on saves what is already on the page.
  if (state.kinds.length) streamCheck();
  if (checks.gqlStream && !state.timer) {
    state.timer = setInterval(streamGql, 60000);
  } else if (!checks.gqlStream && state.timer) {
    clearInterval(state.timer);
    state.timer = 0;
  }
}

/** Stops the stream watch (diagnostics off, or the tab went to the drops pages). */
export function stopStreamWatch() {
  if (!streamWatch) return;
  streamWatch.observer?.disconnect();
  clearTimeout(streamWatch.pending);
  clearInterval(streamWatch.timer);
  clearInterval(streamWatch.stuckTimer);
  streamWatch = null;
}

// Twitch data -----------------------------------------------------------

// A Full sync fetches one details response per card (about 100), so the caps leave room for
// all of them, and trimming drops repeats of an operation before the last of another.
const MAX_GQL_ENTRIES = 250;
const MAX_GQL_BYTES = 2_000_000;
const MAX_GQL_TOTAL = 6_000_000;

/**
 * Saves scrubbed copies of the Twitch data (GQL responses) this tab has collected, while
 * settings.twitchApi is also on: the newest per operation and variables, replacing an older
 * copy of the same, so the shapes can be studied before the parsers are written.
 * @returns {Promise<number>} entries added or replaced
 */
export async function recordGql(page) {
  const items = collected();
  if (!items.length) return 0;
  const identities = new Set([loginName()].filter(Boolean));
  for (const item of items) viewerIdentities(item.data).forEach((v) => identities.add(v));
  const at = new Date().toISOString();
  const found = items.map((item) => {
    const variables = scrubGql(item.variables, identities);
    const response = scrubGql(item.data, identities);
    const bytes = JSON.stringify(response).length;
    return {
      key: `${page}:${item.operationName}:${JSON.stringify(variables).slice(0, 300)}`,
      operationName: item.operationName,
      variables,
      received: new Date(item.at).toISOString(),
      at,
      page,
      lang: document.documentElement.lang,
      bytes,
      response: bytes <= MAX_GQL_BYTES ? response : null,
    };
  });
  const write = async () => {
    const { [DIAG_GQL_KEY]: stored } = await chrome.storage.local.get(DIAG_GQL_KEY);
    const keys = new Set(found.map((f) => f.key));
    const list = [...(Array.isArray(stored) ? stored : []).filter((e) => !keys.has(e.key)), ...found];
    const size = (e) => (e.response ? e.bytes : 0);
    let total = list.reduce((n, e) => n + size(e), 0);
    while (list.length > 1 && (list.length > MAX_GQL_ENTRIES || total > MAX_GQL_TOTAL)) {
      // The oldest entry of an operation saved more than once, else the oldest.
      const counts = new Map();
      for (const e of list) counts.set(e.operationName, (counts.get(e.operationName) ?? 0) + 1);
      const i = Math.max(0, list.findIndex((e) => counts.get(e.operationName) > 1));
      total -= size(list.splice(i, 1)[0]);
    }
    await chrome.storage.local.set({ [DIAG_GQL_KEY]: list });
    return found.length;
  };
  return navigator.locks ? navigator.locks.request('dragnet-diag-gql', write) : write();
}

// Live watch ---------------------------------------------------------------------------------

const onInventory = () => /^\/drops\/inventory\/?$/.test(location.pathname);
let live = null;
let listening = false;

function stopLiveWatch() {
  if (!live) return;
  live.observer.disconnect();
  clearTimeout(live.debounce);
  clearTimeout(live.reload);
  clearInterval(live.path);
  live.badge.remove();
  live = null;
}

function applyLiveMode(mode) {
  stopLiveWatch();
  if (!Object.hasOwn(DIAG_LIVE_MODES, mode) || mode === 'off' || !onInventory()) return;
  const minutes = DIAG_LIVE_MODES[mode];
  const badge = document.createElement('div');
  Object.assign(badge.style, {
    position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647',
    padding: '4px 8px', borderRadius: '6px', font: '12px/1.4 system-ui, sans-serif',
    background: '#5b21b6', color: '#fff', opacity: '.85', pointerEvents: 'none',
  });
  const started = Date.now();
  const show = (checks) => {
    badge.textContent = `Dragnet live watch: ${checks} check${checks === 1 ? '' : 's'}`
      + (minutes ? `, reloads ${new Date(started + minutes * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '');
  };
  let checks = 0;
  show(checks);
  document.body.append(badge);
  const check = async () => {
    // Extension reloaded or removed: this copy is orphaned and chrome.* now throws.
    if (!chrome.runtime?.id || !onInventory()) return stopLiveWatch();
    checks++;
    show(checks);
    try {
      await recordAnomalies(document, 'inventory');
    } catch (err) {
      // The context can also go away mid-check, between the guard above and the storage call.
      if (!chrome.runtime?.id) return stopLiveWatch();
      console.warn('[Dragnet] live watch', err);
    }
  };
  const observer = new MutationObserver((records) => {
    if (!live || records.every((r) => badge.contains(r.target))) return;
    clearTimeout(live.debounce);
    live.debounce = setTimeout(check, 2000);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuenow', 'disabled'] });
  // In-app navigation away does not reload the page: stop then.
  const path = setInterval(() => { if (!chrome.runtime?.id || !onInventory()) stopLiveWatch(); }, 2000);
  live = { observer, badge, debounce: 0, reload: 0, path };
  if (minutes) {
    live.reload = setTimeout(() => {
      if (onInventory()) location.reload();
      else stopLiveWatch();
    }, minutes * 60000);
  }
}

/** The live watch mode as stored, or 'off' while its check (liveWatch) is off. */
async function liveMode() {
  const { [DIAG_LIVE_KEY]: mode = 'off', [DIAG_CHECKS_KEY]: checks } = await chrome.storage.sync.get([DIAG_LIVE_KEY, DIAG_CHECKS_KEY]);
  return sanitizeDiagChecks(checks).liveWatch ? mode : 'off';
}

/** Starts (or restarts) the live watch on the inventory page if it is switched on. */
export async function startLiveWatch(page) {
  if (page !== 'inventory') return stopLiveWatch();
  if (!listening) {
    listening = true;
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'sync' || !chrome.runtime?.id) return;
      // Diagnostics switched off on the settings page: stop at once.
      if (changes[KEYS.settings] && !sanitizeSettings(changes[KEYS.settings].newValue).diagnostics) return applyLiveMode('off');
      const checks = changes[DIAG_CHECKS_KEY];
      const toggled = checks && sanitizeDiagChecks(checks.oldValue).liveWatch !== sanitizeDiagChecks(checks.newValue).liveWatch;
      if (!changes[DIAG_LIVE_KEY] && !toggled) return;
      try {
        applyLiveMode(await liveMode());
      } catch (err) {
        if (chrome.runtime?.id) console.warn('[Dragnet] live watch', err);
      }
    });
  }
  applyLiveMode(await liveMode());
}
