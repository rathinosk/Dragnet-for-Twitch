// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Service worker: tells each drops-page visit how to scan (a passive sweep, or a full read
// in the Full sync tab), merges scan results into storage, runs the Full sync round-trip
// (open the campaigns page, let it scan, move the tab on to the inventory, let it scan,
// close it), the timed inventory check (settings.inventoryCheck) and stall detection
// (settings.stallDetect, core/stall.js). Makes no network calls. Scan messages come from a content script on
// a page we do not control, so every payload is sanitized before use.

import {
  SCHEMA_VERSION, KEYS, sanitizeCampaigns, sanitizeWarnings, sanitizeInventory, sanitizeClaims, sanitizeSettings,
} from './core/schema.js';
import { applyCampaignScan, isFatal, byEndDate } from './core/merge.js';
import { applyInventory, mergeClaims } from './core/inventory.js';
import {
  applyGqlDetails, applyGqlDashboard, sanitizeGqlDetails, sanitizeGqlDashboard, fold,
} from './core/gql.js';
import {
  trackProgress, updateWatch, findStalls, planStalls, sanitizeWatchReport,
} from './core/stall.js';

// With the incremental setting, a passive campaigns sweep re-reads old cards at most this
// often (each visit still reads new cards).
const REVISIT_INTERVAL_MS = 15 * 60 * 1000;
const CAMPAIGNS_URL = 'https://www.twitch.tv/drops/campaigns';
const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';

chrome.runtime.onInstalled.addListener(async () => {
  const { schemaVersion } = await chrome.storage.local.get(KEYS.schemaVersion);
  if (schemaVersion === undefined) await chrome.storage.local.set({ [KEYS.schemaVersion]: SCHEMA_VERSION });
  await syncGqlHook();
  await syncInventoryAlarm();
});

// Twitch page data: the main-world hook that copies the GQL responses Twitch's own
// drops pages receive is registered only while settings.twitchApi is on; off, Twitch's page
// is untouched. It matches all of twitch.tv because the drops pages are reached by in-app
// navigation (same reason as content.js), and checks the path itself. Tabs already open
// get the change on their next load.
const GQL_HOOK_ID = 'dragnet-gql';

// Serialized, so two quick setting changes cannot both register it.
let hookQueue = Promise.resolve();
function syncGqlHook(rawSettings) {
  hookQueue = hookQueue.then(() => applyGqlHook(rawSettings));
  return hookQueue;
}

async function applyGqlHook(rawSettings) {
  try {
    const settings = sanitizeSettings(rawSettings ?? (await chrome.storage.sync.get(KEYS.settings))[KEYS.settings]);
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [GQL_HOOK_ID] })).length > 0;
    if (settings.twitchApi && !registered) {
      await chrome.scripting.registerContentScripts([{
        id: GQL_HOOK_ID,
        matches: ['https://www.twitch.tv/*'],
        js: ['scraper/gql-hook.js'],
        world: 'MAIN',
        runAt: 'document_start',
        persistAcrossSessions: true,
      }]);
    } else if (!settings.twitchApi && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [GQL_HOOK_ID] });
    }
  } catch (err) {
    console.error('[Dragnet] gql hook', err);
  }
}

chrome.runtime.onStartup.addListener(() => {
  syncGqlHook();
  syncInventoryAlarm();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[KEYS.settings]) return;
  const settings = changes[KEYS.settings].newValue ?? {};
  syncGqlHook(settings);
  syncInventoryAlarm(settings);
  // Stall detection switched off (clears everything) or its reload settings changed.
  evaluateStalls().catch((err) => console.error('[Dragnet] stalls', err));
});

// All read-modify-write of storage goes through this queue, so concurrent scans (two
// tabs, a visit during a Full sync) cannot overwrite each other's results.
let writeQueue = Promise.resolve();
function serialized(task) {
  const result = writeQueue.then(task);
  writeQueue = result.catch(() => {});
  return result;
}

const handlers = {
  'dragnet:should-scan': { from: 'twitch', handle: shouldScan },
  'dragnet:scan': { from: 'twitch', handle: storeScan },
  'dragnet:refresh': { from: 'extension', handle: refresh },
  'dragnet:watch': { from: 'twitch', handle: watchReport },
  'dragnet:drop-signal': { from: 'twitch', handle: dropSignal },
  'dragnet:reload-stream': { from: 'extension', handle: reloadStream },
  'dragnet:dismiss-stall': { from: 'extension', handle: dismissStall },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler || !(handler.from === 'twitch' ? isTwitchSender(sender) : isExtensionPage(sender))) return false;
  (async () => {
    try {
      sendResponse({ ok: true, ...(await handler.handle(message, sender)) });
    } catch (err) {
      console.error('[Dragnet]', message.type, err);
      sendResponse({ ok: false });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await forgetRefreshTab(tabId);
  await forgetCheckTab(tabId);
  await forgetWatchTab(tabId);
});

// A check tab the user took elsewhere is theirs now: forget it and leave it open.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.url && !info.url.startsWith(INVENTORY_URL)) await forgetCheckTab(tabId);
});

function isTwitchSender(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith('https://www.twitch.tv/');
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

// Every visit scans; a passive sweep only reads what can have changed, so it needs what
// is stored: campaign ids and when their bodies were read, and the claim history.
async function shouldScan(message, sender) {
  const page = message.page;
  if (page !== 'campaigns' && page !== 'inventory') return { scan: false };
  const mode = (await isRefreshTab(sender.tab?.id)) ? 'full' : 'passive';
  const [{ [KEYS.settings]: rawSettings }, stored] = await Promise.all([
    chrome.storage.sync.get(KEYS.settings),
    chrome.storage.local.get(page === 'campaigns' ? [KEYS.campaigns, KEYS.scans] : [KEYS.claims]),
  ]);
  const settings = sanitizeSettings(rawSettings);
  const messages = await badgeMessages(settings.language);
  if (page === 'inventory') {
    return {
      scan: true,
      mode,
      messages,
      historyDays: settings.historyDays,
      autoClaim: settings.autoClaim,
      knownClaims: mode === 'full' ? null
        : sanitizeClaims(stored[KEYS.claims]).map(({ id, claimedAt, unit }) => ({ id, claimedAt, unit })),
    };
  }
  if (mode === 'full') return { scan: true, mode, messages };
  const last = Date.parse(stored[KEYS.scans]?.campaigns?.revisitedAt ?? '');
  const due = settings.incremental && (!Number.isFinite(last) || Date.now() - last >= REVISIT_INTERVAL_MS);
  return {
    scan: true,
    mode,
    messages,
    revisit: due ? settings.incrementalCount : 0,
    known: sanitizeCampaigns(stored[KEYS.campaigns]).map(({
      id, bodyParsed, bodyReadAt, connection, twitchDropIds,
    }) => ({
      id, bodyParsed, bodyReadAt, connection, ...(twitchDropIds ? { twitchDropIds } : {}),
    })),
  };
}

// The scan label's text on the Twitch page when the user picked a UI language (chrome.i18n
// in the content script always answers in Chrome's own pick); null for the automatic choice.
const BADGE_KEYS = ['badgeReadingCampaigns', 'badgeReadingClaims', 'badgeClaiming'];
async function badgeMessages(language) {
  if (language === 'auto') return null;
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${language}/messages.json`));
    const all = await res.json();
    return Object.fromEntries(BADGE_KEYS.filter((k) => typeof all[k]?.message === 'string').map((k) => [k, all[k].message]));
  } catch (err) {
    console.warn('[Dragnet] messages', language, err);
    return null;
  }
}

const counter = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1e6) : null);

async function storeScan(message, sender) {
  const page = message.page === 'campaigns' || message.page === 'inventory' ? message.page : null;
  if (!page) return {};
  const warnings = sanitizeWarnings(message.warnings);
  const tabId = sender.tab?.id;
  const mode = (await isRefreshTab(tabId)) ? 'full' : 'passive';
  const stats = message.stats && typeof message.stats === 'object' ? message.stats : {};
  const interrupted = page === 'campaigns' && stats.interrupted === true;
  const settings = await readSettings();
  const summary = await serialized(async () => {
    const stored = await chrome.storage.local.get([KEYS.campaigns, KEYS.scans, KEYS.inventory, KEYS.claims, KEYS.progressTrack]);
    const scans = { ...stored[KEYS.scans] };
    const update = {};
    const now = Date.now();
    const at = new Date(now).toISOString();
    if (page === 'campaigns') {
      const campaigns = sanitizeCampaigns(message.campaigns);
      const result = applyCampaignScan(stored[KEYS.campaigns] ?? [], { campaigns, warnings }, now);
      // Twitch data (settings.twitchApi): the details of the cards opened.
      const details = sanitizeGqlDetails(message.gql?.details);
      const gql = message.gql && typeof message.gql === 'object'
        ? { details: details.length, changed: counter(message.gql.changed) ?? 0, matched: 0, added: 0 } : null;
      if (result.accepted && details.length) {
        const applied = applyGqlDetails(result.campaigns, details, now);
        result.campaigns = applied.campaigns;
        Object.assign(gql, { matched: applied.matched, added: applied.added });
      }
      // Games the dashboard lists that the page did not show get a card of their own; without
      // a dashboard this time, the ones stored are kept. With Twitch data off, they go.
      if (result.accepted && gql) {
        const previous = sanitizeCampaigns(stored[KEYS.campaigns]).filter((c) => c.fromTwitchData);
        const dashboard = Array.isArray(message.gql.dashboard) ? sanitizeGqlDashboard(message.gql.dashboard) : null;
        if (dashboard) {
          const applied = applyGqlDashboard(result.campaigns, dashboard, now, previous);
          result.campaigns = applied.campaigns.sort(byEndDate);
          gql.games = applied.added;
        } else {
          const games = new Set(result.campaigns.map((c) => fold(c.game)));
          const kept = previous.filter((c) => !games.has(fold(c.game)) && Date.parse(c.endDate) >= now);
          result.campaigns = [...result.campaigns, ...kept].sort(byEndDate);
        }
      }
      const revisited = mode === 'passive' && counter(stats.revisit) > 0 && !interrupted;
      scans.campaigns = {
        at,
        mode,
        // Cards opened, of those planned: a passive sweep with nothing new opens none.
        cardsOpened: counter(stats.cardsOpened),
        cardsPlanned: counter(stats.cardsPlanned),
        interrupted,
        revisitedAt: revisited ? at : scans.campaigns?.revisitedAt ?? '',
        cardCount: campaigns.length,
        campaignCount: result.campaigns.length,
        dropCount: result.campaigns.reduce((n, c) => n + c.drops.length, 0),
        accepted: result.accepted,
        gql,
        warnings,
      };
      if (result.accepted) {
        // Re-apply the last inventory read, so drops new to the list get their progress
        // and claims at once (status and progress only ever rise, so this is idempotent).
        const inventory = sanitizeInventory(stored[KEYS.inventory]);
        const claims = sanitizeClaims(stored[KEYS.claims]);
        update[KEYS.campaigns] = applyInventory(result.campaigns, inventory, claims).campaigns;
      }
    } else {
      const inventory = sanitizeInventory(message.inventory);
      const accepted = !isFatal(warnings);
      scans.inventory = {
        at,
        mode,
        progressRows: inventory.progress.reduce((n, b) => n + b.rows.length, 0),
        claimCount: inventory.claims.length,
        // Diagnostics for the Load More loop: clicks made, and the oldest item reached.
        loadMoreClicks: counter(message.inventory?.loadMoreClicks),
        oldestDays: Number.isFinite(message.inventory?.oldestAgeMs) ? Math.round(message.inventory.oldestAgeMs / 864e5) : null,
        // A passive sweep stopped at a claim already stored.
        reachedKnown: message.inventory?.reachedKnown === true,
        claimClicks: counter(message.inventory?.claimClicks),
        // Progress and claim times read from Twitch data (settings.twitchApi).
        gql: message.gql?.inventory === true ? { claims: counter(message.gql.claims) ?? 0 } : null,
        accepted,
        warnings,
      };
      if (accepted) {
        const claims = mergeClaims(sanitizeClaims(stored[KEYS.claims]), inventory.claims, now, settings.historyDays);
        const result = applyInventory(sanitizeCampaigns(stored[KEYS.campaigns]), inventory, claims);
        // Rows of campaigns that have ended (Twitch lists them for a while) or are not stored.
        scans.inventory.unmatchedRows = result.unmatchedRows;
        update[KEYS.inventory] = { at, progress: inventory.progress, earned: inventory.earned };
        update[KEYS.claims] = claims;
        update[KEYS.campaigns] = result.campaigns;
        // Stall detection: the progress history, fed by every inventory read.
        if (settings.stallDetect) update[KEYS.progressTrack] = trackProgress(stored[KEYS.progressTrack], result.campaigns, now);
      }
    }
    update[KEYS.scans] = scans;
    await chrome.storage.local.set(update);
    return scans[page];
  });
  if (mode === 'full') {
    if (interrupted) {
      // The user took the tab elsewhere mid-sync: leave it alone.
      await forgetRefreshTab(tabId);
    } else if (page === 'campaigns') {
      await chrome.tabs.update(tabId, { url: INVENTORY_URL }).catch(() => forgetRefreshTab(tabId));
    } else {
      await forgetRefreshTab(tabId);
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  } else if (page === 'inventory' && (await forgetCheckTab(tabId))) {
    // A timed check's own tab: done.
    await tabEdit(() => chrome.tabs.remove(tabId)).catch(() => {});
  }
  if (page === 'inventory' && settings.stallDetect) await evaluateStalls();
  return { accepted: summary.accepted };
}

// Full sync: open the campaigns page in a focused tab (background tabs are throttled and
// may not render), let its content script read every card, then send the tab on to the
// inventory, and close it when the inventory scan arrives.
async function refresh() {
  const tab = await chrome.tabs.create({ url: CAMPAIGNS_URL, active: true });
  const { refreshTabs = [] } = await chrome.storage.session.get('refreshTabs');
  await chrome.storage.session.set({ refreshTabs: [...refreshTabs, tab.id].slice(-10) });
  return {};
}

async function isRefreshTab(tabId) {
  if (tabId === undefined) return false;
  const { refreshTabs = [] } = await chrome.storage.session.get('refreshTabs');
  return refreshTabs.includes(tabId);
}

async function forgetRefreshTab(tabId) {
  const { refreshTabs = [] } = await chrome.storage.session.get('refreshTabs');
  if (refreshTabs.includes(tabId)) {
    await chrome.storage.session.set({ refreshTabs: refreshTabs.filter((id) => id !== tabId) });
  }
}

async function readSettings() {
  return sanitizeSettings((await chrome.storage.sync.get(KEYS.settings))[KEYS.settings]);
}

// Timed inventory check (settings.inventoryCheck) ------------------------------------------
// On the user's timer: reload an open inventory tab (not the one the user is looking at), or
// open one unfocused and close it after its scan. Its passive scan reads progress and, with
// auto-claim on, clicks "Claim Now". Nothing is requested from Twitch but the page itself.

const CHECK_ALARM = 'dragnet-inventory';
const CHECK_TIMEOUT_ALARM = 'dragnet-check-timeout';
// A check tab still open after this (logged out, a layout change, a service worker restart)
// is closed.
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;

async function syncInventoryAlarm(rawSettings) {
  try {
    const settings = rawSettings ? sanitizeSettings(rawSettings) : await readSettings();
    const minutes = settings.inventoryCheck;
    const alarm = await chrome.alarms.get(CHECK_ALARM);
    if (!minutes) {
      if (alarm) await chrome.alarms.clear(CHECK_ALARM);
    } else if (alarm?.periodInMinutes !== minutes) {
      await chrome.alarms.create(CHECK_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
    }
  } catch (err) {
    console.error('[Dragnet] inventory alarm', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const task = alarm.name === CHECK_ALARM ? inventoryCheck
    : alarm.name === CHECK_TIMEOUT_ALARM ? closeStaleChecks : null;
  task?.().catch((err) => console.error('[Dragnet]', alarm.name, err));
});

/** Runs a tab edit, retrying while Chrome refuses it because the user is dragging a tab. */
async function tabEdit(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4 || !/cannot be edited right now/i.test(err?.message ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

const liveTabs = async (ids) => (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);

/** The active tab of the focused window (the one the user is looking at), or null. */
async function watchedTab() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab?.id ?? null;
}

// A channel page signalled a fresh drop (settings.dropAlert, scraper/content.js): check the
// inventory now, like the timed check but independent of its setting. The dot can stay up for
// a while (until the popover is opened), so one alert-driven check per cooldown.
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

async function dropSignal() {
  if (!(await readSettings()).dropAlert) return {};
  const { lastAlertCheck = 0 } = await chrome.storage.session.get('lastAlertCheck');
  if (Date.now() - lastAlertCheck < ALERT_COOLDOWN_MS) return {};
  await chrome.storage.session.set({ lastAlertCheck: Date.now() });
  await runInventoryCheck();
  return {};
}

async function inventoryCheck() {
  if (!(await readSettings()).inventoryCheck) return;
  await runInventoryCheck();
}

async function runInventoryCheck() {
  const { refreshTabs = [], checkTabs = [] } = await chrome.storage.session.get(['refreshTabs', 'checkTabs']);
  // A Full sync or an earlier check is still at work.
  if ((await liveTabs(refreshTabs)).length || (await liveTabs(checkTabs.map((c) => c.id))).length) return;
  const open = await chrome.tabs.query({ url: `${INVENTORY_URL}*` });
  if (open.length) {
    // The user's own tab: reloaded (a passive scan) and never closed; left alone while in
    // front, where its own scan and claim watch already run.
    const watched = await watchedTab();
    if (!open.some((t) => t.id === watched)) await tabEdit(() => chrome.tabs.reload(open[0].id));
    return;
  }
  const tab = await tabEdit(() => chrome.tabs.create({ url: INVENTORY_URL, active: false }));
  await chrome.storage.session.set({ checkTabs: [{ id: tab.id, at: Date.now() }] });
  await chrome.alarms.create(CHECK_TIMEOUT_ALARM, { delayInMinutes: CHECK_TIMEOUT_MS / 60000 });
}

async function closeStaleChecks() {
  const { checkTabs = [] } = await chrome.storage.session.get('checkTabs');
  const now = Date.now();
  const stale = checkTabs.filter((c) => now - c.at >= CHECK_TIMEOUT_MS - 5000);
  if (!stale.length) return;
  await chrome.storage.session.set({ checkTabs: checkTabs.filter((c) => !stale.includes(c)) });
  for (const c of stale) await tabEdit(() => chrome.tabs.remove(c.id)).catch(() => {});
}

/** Forgets a check tab; true if it was one. */
async function forgetCheckTab(tabId) {
  if (tabId === undefined) return false;
  const { checkTabs = [] } = await chrome.storage.session.get('checkTabs');
  if (!checkTabs.some((c) => c.id === tabId)) return false;
  await chrome.storage.session.set({ checkTabs: checkTabs.filter((c) => c.id !== tabId) });
  return true;
}

// Stall detection (settings.stallDetect, core/stall.js) -------------------------------------
// Channel tabs report what they play (session storage, `watchTabs`); each inventory read
// feeds the progress history (`progressTrack`). A stall shows as a "!" badge and a line in
// the popup and full page (`stalls`); with auto-reload on, the stalled tab is reloaded.
// Dragnet stays on the channel the user chose: it never opens or suggests another one.

async function watchReport(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return {};
  if (!(await readSettings()).stallDetect) return { stop: true };
  const report = sanitizeWatchReport(message.state);
  await serialized(async () => {
    const { watchTabs = {} } = await chrome.storage.session.get('watchTabs');
    const next = updateWatch(watchTabs[tabId], report, Date.now());
    if (next) watchTabs[tabId] = next;
    else delete watchTabs[tabId];
    await chrome.storage.session.set({ watchTabs });
  });
  await evaluateStalls();
  return {};
}

async function forgetWatchTab(tabId) {
  const known = await serialized(async () => {
    const { watchTabs = {}, stallState = {} } = await chrome.storage.session.get(['watchTabs', 'stallState']);
    if (!watchTabs[tabId] && !stallState[tabId]) return false;
    delete watchTabs[tabId];
    delete stallState[tabId];
    await chrome.storage.session.set({ watchTabs, stallState });
    return true;
  });
  if (known) await evaluateStalls();
}

async function clearStalls() {
  await chrome.storage.session.remove(['watchTabs', 'stallState', 'stalls']);
  await chrome.storage.local.remove(KEYS.progressTrack);
  await chrome.action.setBadgeText({ text: '' });
}

async function evaluateStalls() {
  const settings = await readSettings();
  if (!settings.stallDetect) return clearStalls();
  const protectedTab = await watchedTab();
  const reload = await serialized(async () => {
    const [{ watchTabs = {}, stallState = {} }, local] = await Promise.all([
      chrome.storage.session.get(['watchTabs', 'stallState']),
      chrome.storage.local.get([KEYS.progressTrack, KEYS.campaigns]),
    ]);
    const now = Date.now();
    const found = findStalls(local[KEYS.progressTrack] ?? {}, watchTabs, sanitizeCampaigns(local[KEYS.campaigns]), now);
    const plan = planStalls(found, stallState, watchTabs, settings, now, { protectedTab });
    await chrome.storage.session.set({ stallState: plan.state, stalls: plan.alerts });
    if (plan.alerts.length) await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    await chrome.action.setBadgeText({ text: plan.alerts.length ? '!' : '' });
    return plan.reload;
  });
  // The browser reloads the page as normal; Dragnet sends nothing itself.
  for (const id of reload) await chrome.tabs.reload(id).catch(() => {});
}

// Reload stream (popup and full page): only a tab that reported watching. Does not count
// toward auto-reload's limit.
async function reloadStream(message) {
  const tabId = Number(message.tabId);
  const { watchTabs = {} } = await chrome.storage.session.get('watchTabs');
  if (!Number.isInteger(tabId) || !watchTabs[tabId]) return {};
  await chrome.tabs.reload(tabId);
  return {};
}

async function dismissStall(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return {};
  await serialized(async () => {
    const { stallState = {} } = await chrome.storage.session.get('stallState');
    if (!stallState[tabId]) return;
    stallState[tabId].dismissed = true;
    await chrome.storage.session.set({ stallState });
  });
  await evaluateStalls();
  return {};
}
