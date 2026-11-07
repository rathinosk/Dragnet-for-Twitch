// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Diagnostics (diag/README.md). The diagnostics page: probe or snapshot an open
// Twitch drops tab or channel tab (the work runs in that tab's content script, diag/capture.js), list the
// markup and Twitch data (GQL responses) saved by diag/watch.js, and download stored data.
// The checks (diagChecks) switch the automatic watchers one by one, or by scenario preset;
// the stall panel shows stall detection's live state. Captured markup comes from a
// page we do not control: it is only ever shown as text or downloaded, never rendered.

import {
  KEYS, DIAG_KEY, DIAG_LIVE_KEY, DIAG_LIVE_MODES, DIAG_GQL_KEY, DIAG_CHECKS_KEY,
  sanitizeSettings, sanitizeDiagChecks, sanitizeCampaigns, presetChecks, presetOf,
} from '../core/schema.js';
import { STALL_MINUTES } from '../core/stall.js';
import { fold } from '../core/gql.js';

const $ = (id) => document.getElementById(id);
const output = $('output');
const actions = $('result-actions');

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const show = (value) => { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };

// Twitch tabs ----------------------------------------------------------------------------

const DROPS_PAGE = /^https:\/\/www\.twitch\.tv\/drops\/(campaigns|inventory)\/?(?:[?#]|$)/;

// A channel page: one path segment that is not one of Twitch's own pages (the same check as
// scraper/stream.js, loosely: the tab's content script has the last word).
const CHANNEL_PAGE = /^https:\/\/www\.twitch\.tv\/([A-Za-z0-9_]{2,25})\/?(?:[?#]|$)/;
const NOT_CHANNELS = new Set(['directory', 'drops', 'settings', 'videos', 'search', 'downloads', 'subscriptions', 'inventory', 'wallet', 'friends', 'messages', 'turbo', 'jobs', 'prime', 'store', 'following']);

async function listStreamTabs() {
  const tabs = (await chrome.tabs.query({ url: 'https://www.twitch.tv/*' }))
    .map((tab) => ({ tab, channel: CHANNEL_PAGE.exec(tab.url ?? '')?.[1]?.toLowerCase() }))
    .filter((t) => t.channel && !NOT_CHANNELS.has(t.channel));
  $('stream-tabs').replaceChildren(...tabs.map(({ tab, channel }) => el('li', {},
    el('span', { className: 'name', textContent: `${channel} (tab ${tab.id})` }),
    el('button', { className: 'btn small', type: 'button', textContent: 'Probe stream', onclick: () => run(tab, 'stream', 'probe-stream') }),
    el('button', { className: 'btn small', type: 'button', textContent: 'Snapshot stream', onclick: () => run(tab, 'stream', 'capture-stream') }))));
  $('no-stream-tabs').hidden = tabs.length > 0;
}

async function listTabs() {
  listStreamTabs();
  const tabs = (await chrome.tabs.query({ url: 'https://www.twitch.tv/drops/*' }))
    .map((tab) => ({ tab, page: DROPS_PAGE.exec(tab.url ?? '')?.[1] }))
    .filter((t) => t.page);
  $('tabs').replaceChildren(...tabs.map(({ tab, page }) => {
    const buttons = [
      el('button', { className: 'btn small', type: 'button', textContent: 'Probe', onclick: () => run(tab, page, 'probe') }),
      el('button', { className: 'btn small', type: 'button', textContent: 'Snapshot', onclick: () => run(tab, page, 'capture', false) }),
    ];
    if (page === 'campaigns') {
      buttons.push(el('button', { className: 'btn small', type: 'button', textContent: 'Snapshot expanded', onclick: () => run(tab, page, 'capture', true) }));
    }
    return el('li', {}, el('span', { className: 'name', textContent: `${page} (tab ${tab.id})` }), ...buttons);
  }));
  $('no-tabs').hidden = tabs.length > 0;
}

let running = false;

async function run(tab, page, action, expand = false) {
  if (running) return;
  running = true;
  document.body.style.cursor = 'progress';
  actions.replaceChildren();
  const probing = action === 'probe' || action === 'probe-stream';
  show(probing ? 'Probing…' : `Capturing ${page}${expand ? ' (expanded)' : ''}… keep the Twitch tab in front.`);
  const self = await chrome.tabs.getCurrent();
  try {
    if (action === 'capture') {
      // Background tabs are throttled and may not mount card bodies.
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    const options = {
      expand,
      label: $('label').value.trim() || (page === 'stream' ? 'stream' : expand ? 'expanded' : 'collapsed'),
      loadMore: Number($('load-more').value) || 0,
    };
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'dragnet:diag', action, options });
    if (!reply?.ok) throw new Error(reply?.error ?? 'No reply from the tab.');
    if (probing) {
      show(reply.result);
      actions.append(el('button', {
        className: 'btn small', type: 'button', textContent: 'Download probe (JSON)',
        onclick: () => download(`probe-${page}-${stamp()}.json`, JSON.stringify(reply.result, null, 2), 'application/json'),
      }));
      return;
    }
    const { name, html, facts } = reply.result;
    const saveHtml = () => download(`${name}.html`, html, 'text/html');
    const saveFacts = () => download(`${name}.facts.json`, JSON.stringify(facts, null, 2), 'application/json');
    actions.append(
      el('button', { className: 'btn small', type: 'button', textContent: `Download ${name}.html`, onclick: saveHtml }),
      el('button', { className: 'btn small', type: 'button', textContent: `Download ${name}.facts.json`, onclick: saveFacts }),
    );
    show(`Captured ${name}: ${(html.length / 1024).toFixed(0)} KB. If the downloads did not start, use the buttons above.\n\n`
      + JSON.stringify(facts, null, 2));
    if (self) await chrome.tabs.update(self.id, { active: true });
    saveHtml();
    saveFacts();
  } catch (err) {
    show(`Failed: ${err?.message ?? err}\n\nIf the tab was open before Dragnet was loaded or reloaded, reload the Twitch tab and try again.`);
    if (self && action === 'capture') await chrome.tabs.update(self.id, { active: true }).catch(() => {});
  } finally {
    running = false;
    document.body.style.cursor = '';
  }
}

// Saved markup -----------------------------------------------------------------------------

const isStream = (e) => String(e.kind ?? '').startsWith('stream:');
let captureList = [];

function renderCaptures(list) {
  captureList = Array.isArray(list) ? list : [];
  const filter = $('capture-filter').value;
  const entries = captureList.filter((e) => filter === 'all' || (filter === 'stream') === isStream(e));
  $('capture-count').textContent = entries.length === captureList.length ? `(${entries.length})` : `(${entries.length} of ${captureList.length})`;
  $('captures').replaceChildren(...entries.slice().reverse().map((e) => el('tr', {},
    el('td', { textContent: new Date(e.at).toLocaleString() }),
    el('td', { textContent: e.url ?? '' }),
    el('td', { textContent: e.kind ?? '' }),
    el('td', { textContent: e.summary ?? '' }),
    el('td', {}, el('button', {
      className: 'btn small', type: 'button', textContent: 'Download',
      onclick: () => download(`dragnet-${String(e.kind).replace(/[^\w-]+/g, '-')}-${String(e.at).slice(0, 19).replace(/[:T]/g, '-')}.html`,
        `<!-- Dragnet diagnostics capture\n  kind: ${e.kind}\n  saved: ${e.at}\n  page: ${e.url}\n  lang: ${e.lang}\n  summary: ${String(e.summary).replace(/--/g, '- -')}\n-->\n${e.html}\n`,
        'text/html'),
    })),
  )));
}

async function loadCaptures() {
  const { [DIAG_KEY]: list } = await chrome.storage.local.get(DIAG_KEY);
  renderCaptures(list);
  return list;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[DIAG_KEY]) renderCaptures(changes[DIAG_KEY].newValue);
});
$('capture-filter').addEventListener('change', () => renderCaptures(captureList));

$('download-all').addEventListener('click', async () => {
  const list = await loadCaptures();
  download(`dragnet-captures-${stamp()}.json`, JSON.stringify(list ?? [], null, 2), 'application/json');
});

$('clear').addEventListener('click', async () => {
  if (confirm('Delete all saved markup?')) await chrome.storage.local.remove(DIAG_KEY);
});

// Twitch data ------------------------------------------------------------------------------

const fileStamp = (iso) => String(iso).slice(0, 19).replace(/[:T]/g, '-');

function renderGql(list) {
  const entries = Array.isArray(list) ? list : [];
  $('gql-count').textContent = `(${entries.length})`;
  $('gql-captures').replaceChildren(...entries.slice().reverse().map((e) => el('tr', {},
    el('td', { textContent: new Date(e.received ?? e.at).toLocaleString() }),
    el('td', { textContent: e.page ?? '' }),
    el('td', { textContent: e.operationName ?? '' }),
    el('td', { textContent: JSON.stringify(e.variables ?? null).slice(0, 200) }),
    el('td', { textContent: `${Math.ceil((e.bytes ?? 0) / 1024)} KB${e.response ? '' : ' (too large, not kept)'}` }),
    el('td', {}, el('button', {
      className: 'btn small', type: 'button', textContent: 'Download',
      onclick: () => download(`dragnet-gql-${e.operationName}-${fileStamp(e.received ?? e.at)}.json`, JSON.stringify(e, null, 2), 'application/json'),
    })),
  )));
}

async function loadGql() {
  const { [DIAG_GQL_KEY]: list } = await chrome.storage.local.get(DIAG_GQL_KEY);
  renderGql(list);
  return list;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[DIAG_GQL_KEY]) renderGql(changes[DIAG_GQL_KEY].newValue);
});

$('gql-download-all').addEventListener('click', async () => {
  const list = await loadGql();
  download(`dragnet-gql-${stamp()}.json`, JSON.stringify(list ?? [], null, 2), 'application/json');
});

$('gql-clear').addEventListener('click', async () => {
  if (confirm('Delete all saved Twitch data?')) await chrome.storage.local.remove(DIAG_GQL_KEY);
});

$('download-storage').addEventListener('click', async () => {
  // Session storage: Full sync and check tabs, stall detection's watch tabs and alerts.
  const [local, sync, session] = await Promise.all([
    chrome.storage.local.get(null), chrome.storage.sync.get(null), chrome.storage.session.get(null),
  ]);
  delete local[DIAG_KEY];
  delete local[DIAG_GQL_KEY];
  const manifest = chrome.runtime.getManifest();
  download(`dragnet-storage-${stamp()}.json`, JSON.stringify({ version: manifest.version, local, sync, session }, null, 2), 'application/json');
});

// Checks (read by diag/watch.js and scraper/run.js in the Twitch tabs) --------------------

const presetSelect = $('preset');
const liveSelect = $('live-watch');
const checkBoxes = [...document.querySelectorAll('[data-check]')];
let checks = sanitizeDiagChecks(null);

function showChecks(value) {
  checks = sanitizeDiagChecks(value);
  for (const box of checkBoxes) box.checked = checks[box.dataset.check];
  presetSelect.value = presetOf(checks);
  liveSelect.disabled = !checks.liveWatch;
  $('stall-section').hidden = !checks.stallPanel;
  syncStallPanel();
}

const showLive = (mode) => { liveSelect.value = Object.hasOwn(DIAG_LIVE_MODES, mode) ? mode : 'off'; };

chrome.storage.sync.get([DIAG_CHECKS_KEY, DIAG_LIVE_KEY]).then((stored) => {
  showChecks(stored[DIAG_CHECKS_KEY]);
  showLive(stored[DIAG_LIVE_KEY]);
});
for (const box of checkBoxes) {
  box.addEventListener('change', () => chrome.storage.sync.set({ [DIAG_CHECKS_KEY]: { ...checks, [box.dataset.check]: box.checked } }));
}
presetSelect.addEventListener('change', () => {
  const update = { [DIAG_CHECKS_KEY]: presetChecks(presetSelect.value) };
  // The live watch does nothing in mode Off: this scenario needs it watching.
  if (presetSelect.value === 'autoClaim' && liveSelect.value === 'off') update[DIAG_LIVE_KEY] = 'observe';
  chrome.storage.sync.set(update);
});
liveSelect.addEventListener('change', () => chrome.storage.sync.set({ [DIAG_LIVE_KEY]: liveSelect.value }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes[DIAG_CHECKS_KEY]) showChecks(changes[DIAG_CHECKS_KEY].newValue);
  if (changes[DIAG_LIVE_KEY]) showLive(changes[DIAG_LIVE_KEY].newValue);
});

// Stall panel (read-only): stall detection's state in session and local storage ----------

$('stall-minutes').textContent = String(STALL_MINUTES);
let stallTimer = 0;

const minutesSince = (t, now) => Math.max(0, Math.floor((now - t) / 60000));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function stallTable(head, rows) {
  return el('table', { className: 'captures' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', { textContent: c }))))));
}

/** One watch tab: its state, then the drops in progress of its game and how near each is to a stall. */
function stallTab(tabId, w, { track, campaigns, state, alerts }, now) {
  const alert = alerts.find((a) => String(a.tabId) === tabId);
  const s = state[tabId];
  const watching = Number.isFinite(w.goodSince) && w.goodSince > 0;
  const facts = [
    `game: ${w.game || 'unknown (no stall can be found)'}`,
    ...(w.offline ? ['channel offline'] : [
      `drops enabled: ${w.dropsEnabled ? 'yes' : 'no'}`,
      `playing: ${w.playing ? 'yes' : 'no'}`,
    ]),
    watching ? `watching since ${clock(w.goodSince)} (${minutesSince(w.goodSince, now)} min)` : 'not counted as watching',
    `last report ${minutesSince(w.seen, now)} min ago`,
  ];
  if (s) facts.push(`auto-reloads: ${s.reloads}${s.gaveUp ? ', gave up' : ''}${s.dismissed ? ', banner dismissed' : ''}`);
  const span = STALL_MINUTES * 60000;
  const rows = [];
  const game = fold(w.game);
  for (const c of game ? campaigns : []) {
    if (fold(c.game) !== game) continue;
    for (const d of c.drops) {
      const t = track[d.id];
      if (!t) continue;
      const left = c.connection === 'not_connected' ? 'not counted: account not connected'
        : d.channelScope === 'listed' && !d.channels.some((ch) => ch.login === w.channel) ? 'not counted: other channels only'
          : !watching ? (w.offline ? 'waiting: the channel is offline' : 'waiting for a drops-enabled stream to play')
            : (() => {
              const from = Math.max(t.since, w.goodSince);
              const due = from + span;
              if (t.reads >= 2 && t.lastRead >= due) return 'stalled';
              if (now >= due) return `due: needs ${t.reads >= 2 ? 'a' : 'another'} read after ${clock(due)}`;
              return `${Math.ceil((due - now) / 60000)} min (at ${clock(due)})`;
            })();
      rows.push([d.name || c.name, `${t.percent}% (${t.minutes} min)`, String(t.reads), clock(t.since), `${minutesSince(t.since, now)} min`, left]);
    }
  }
  return el('div', { className: 'stall-tab' },
    el('h3', { textContent: `${w.channel} (tab ${tabId})${alert ? (alert.gaveUp ? ': STALLED, auto-reload gave up' : ': STALLED') : ''}` }),
    el('p', { className: 'hint', textContent: facts.join(' · ') }),
    rows.length ? stallTable(['Drop', 'Value', 'Reads', 'Last rise', 'No rise for', 'Stall in'], rows)
      : el('p', { className: 'hint', textContent: 'No tracked drop in progress for this game.' }));
}

async function renderStallPanel() {
  const [session, local, sync] = await Promise.all([
    chrome.storage.session.get(['watchTabs', 'stallState', 'stalls']),
    chrome.storage.local.get([KEYS.progressTrack, KEYS.campaigns]),
    chrome.storage.sync.get(KEYS.settings),
  ]);
  const now = Date.now();
  const data = {
    track: local[KEYS.progressTrack] ?? {},
    campaigns: sanitizeCampaigns(local[KEYS.campaigns]),
    state: session.stallState ?? {},
    alerts: Array.isArray(session.stalls) ? session.stalls : [],
  };
  $('stall-off').hidden = sanitizeSettings(sync[KEYS.settings]).stallDetect;
  const tabs = Object.entries(session.watchTabs ?? {}).filter(([, w]) => w && typeof w === 'object');
  const tracked = Object.keys(data.track).length;
  $('stall-panel').replaceChildren(
    el('p', { className: 'hint', textContent: `${tracked} drop${tracked === 1 ? '' : 's'} in progress tracked across all games.` }),
    ...(tabs.length ? tabs.map(([id, w]) => stallTab(id, w, data, now))
      : [el('p', { className: 'hint', textContent: 'No channel tab is reporting. Open a drops-enabled stream (stall detection must be on).' })]),
  );
}

function syncStallPanel() {
  clearInterval(stallTimer);
  stallTimer = 0;
  if (!checks.stallPanel) return $('stall-panel').replaceChildren();
  const render = () => renderStallPanel().catch((err) => { $('stall-panel').textContent = `Failed: ${err?.message ?? err}`; });
  render();
  stallTimer = setInterval(render, 60000);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (!checks.stallPanel) return;
  const keys = { session: ['watchTabs', 'stallState', 'stalls'], local: [KEYS.progressTrack, KEYS.campaigns], sync: [KEYS.settings] }[area] ?? [];
  if (keys.some((k) => changes[k])) renderStallPanel().catch(() => {});
});

$('refresh-tabs').addEventListener('click', listTabs);
window.addEventListener('focus', listTabs);
chrome.tabs.onUpdated.addListener((_, info) => { if (info.url || info.status === 'complete') listTabs(); });
chrome.tabs.onRemoved.addListener(listTabs);

listTabs();
loadCaptures();
loadGql();

// The page still opens with the setting off (a bookmark); say why nothing works.
const showOff = (settings) => {
  const s = sanitizeSettings(settings);
  $('diag-off').hidden = s.diagnostics;
  $('gql-off').hidden = s.twitchApi;
};
chrome.storage.sync.get(KEYS.settings).then((stored) => showOff(stored[KEYS.settings]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[KEYS.settings]) showOff(changes[KEYS.settings].newValue);
});
