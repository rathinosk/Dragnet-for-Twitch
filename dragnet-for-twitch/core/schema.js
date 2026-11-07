// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Storage schema: constants, and sanitizers that turn an untrusted scan payload into the
// stored shape (known fields only, coerced, https URLs, bounded sizes). Pure: no chrome.*,
// so the test harness can import it.

export const SCHEMA_VERSION = 1;

/** Drop statuses in order; a stored status never moves to an earlier one. */
export const DROP_STATUSES = Object.freeze(['locked', 'in_progress', 'claimable', 'claimed']);

export const CONNECTIONS = Object.freeze(['not_required', 'connected', 'not_connected']);
export const CHANNEL_SCOPES = Object.freeze(['any', 'listed', 'listed_more']);
export const DROP_TYPES = Object.freeze(['watch', 'sub']);

/**
 * Storage keys. `settings` lives in chrome.storage.sync (the user's choices, small, follows
 * their Chrome profile); everything else is chrome.storage.local, a cache rebuilt from the
 * Twitch pages that can be deleted at any time (only claim history beyond what the
 * inventory still shows, and first-seen dates, are lost).
 */
export const KEYS = Object.freeze({
  schemaVersion: 'schemaVersion',
  campaigns: 'campaigns', // Campaign[], sorted by endDate
  scans: 'scans', // {campaigns?: ScanSummary, inventory?: ScanSummary}
  inventory: 'inventory', // {at, progress: ProgressBlock[], earned: Reward[]} from the last inventory scan
  claims: 'claims', // Claim[]: claimed-history items, newest first
  settings: 'settings', // chrome.storage.sync: {historyDays, incremental, incrementalCount, autoClaim, inventoryCheck, dropAlert, stallDetect, stallReload, stallReloadActive, stallReloadMax, connectionFilter, groupBy, hideComplete, hideSubDrops, language, diagnostics, twitchApi}
  progressTrack: 'progressTrack', // {[dropId]: {percent, minutes, since, reads, lastRead}}: progress history for stall detection (core/stall.js)
  gameFilter: 'gameFilter', // chrome.storage.sync: {mode, games}; its own key for the 8 KB per-key limit
});

/**
 * Time units for relative times ("2 months ago"); a month is 30 days, a year 365. `exact` is
 * the precision of a claim time read from Twitch data (core/gql.js), finer than any.
 */
export const TIME_UNITS = Object.freeze({
  exact: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000,
  week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000,
});

/** UI locales shipped in _locales (folder names). */
export const UI_LOCALES = Object.freeze(['en', 'de', 'es', 'es_419', 'fr', 'ja', 'pt_BR', 'ru']);

/**
 * User settings.
 * - historyDays: how far back a full inventory read goes in the claimed history (it clicks
 *   "Load More" until an item is at least this old). Twitch prints days up to about 4 weeks
 *   and months after that ("last month", "2 months ago"), so the choices are weeks, then
 *   whole months; more than 3 months buys nothing for current campaigns. Stored claims older
 *   than this are pruned (core/inventory.js).
 * - incremental: a passive campaigns sweep also re-reads the `incrementalCount` cards read
 *   longest ago (not-connected cards count as twice as stale), so connection changes and
 *   drops added to running campaigns are picked up over a few visits.
 * - autoClaim: click "Claim Now" on the inventory page (default off). Forced off while
 *   AUTO_CLAIM_AVAILABLE is false.
 * - inventoryCheck: minutes between timed inventory checks (0 = off): the background reloads
 *   an open inventory tab, or opens one unfocused, lets its passive scan run (and click
 *   "Claim Now" with autoClaim), and closes the tab it opened.
 * - dropAlert: on a channel page, when the "Drops & More" button shows its new-item dot (or an
 *   "eligible" toast appears), check the inventory at once, as the timed check does (default
 *   off; independent of inventoryCheck, rate-limited in the background).
 * - stallDetect: warn when drop progress stops rising while a drops-enabled stream plays
 *   (core/stall.js; default on). Off sends no watch state and clears the progress history.
 * - stallReload: reload the stalled stream tab by itself, at most every 30 minutes (default
 *   off); stallReloadActive: even the active tab of the focused window; stallReloadMax: give
 *   up after this many reloads without a rise.
 * - connectionFilter: which campaigns the lists show by game-account connection: all,
 *   hide the not-connected ones, or only the not-connected ones (core/filter.js).
 * - groupBy: the lists are one list by end date (`expiry`) or grouped by `game`.
 * - hideComplete: hide campaigns whose every drop is claimed.
 * - hideSubDrops: hide subscription drops; a campaign with nothing but sub drops is hidden,
 *   and one whose only unclaimed drops are sub drops counts as finished for hideComplete.
 * - language: the UI language, `auto` (the locale Chrome picks from its own language) or a
 *   folder name under _locales (UI_LOCALES). Applies to Dragnet's pages and its scan label on
 *   Twitch; the extension's name and description in Chrome always follow Chrome.
 * - diagnostics: the Diagnostics page (diag/), its button, and the watcher that saves markup
 *   the scraper does not recognize (default off; settings page, Danger Zone).
 * - twitchApi: read the Twitch data (GQL responses) Twitch's own drops pages receive, through
 *   a main-world script registered only while it is on (scraper/gql-hook.js; default off;
 *   Danger Zone). Dragnet still sends nothing to Twitch.
 */
export const SETTINGS = Object.freeze({
  historyDays: Object.freeze({ options: Object.freeze([7, 14, 21, 30, 60, 90]), default: 30 }),
  incremental: Object.freeze({ default: false }),
  incrementalCount: Object.freeze({ options: Object.freeze([3, 5, 10]), default: 5 }),
  autoClaim: Object.freeze({ default: false }),
  inventoryCheck: Object.freeze({ options: Object.freeze([0, 15, 30, 60, 120, 240]), default: 0 }),
  dropAlert: Object.freeze({ default: false }),
  stallDetect: Object.freeze({ default: true }),
  stallReload: Object.freeze({ default: false }),
  stallReloadActive: Object.freeze({ default: false }),
  stallReloadMax: Object.freeze({ options: Object.freeze([1, 2, 3, 5]), default: 3 }),
  connectionFilter: Object.freeze({ options: Object.freeze(['all', 'hide_not_connected', 'only_not_connected']), default: 'all' }),
  groupBy: Object.freeze({ options: Object.freeze(['expiry', 'game']), default: 'expiry' }),
  hideComplete: Object.freeze({ default: false }),
  hideSubDrops: Object.freeze({ default: false }),
  language: Object.freeze({ options: Object.freeze(['auto', ...UI_LOCALES]), default: 'auto' }),
  diagnostics: Object.freeze({ default: false }),
  twitchApi: Object.freeze({ default: false }),
});

/**
 * Game filter (chrome.storage.sync, key `gameFilter`): `hide` hides the listed games,
 * `include` shows only them (an empty list hides nothing). Games are matched by display
 * name, ignoring case. The list is capped to stay under sync's 8 KB per-key limit.
 */
export const GAME_FILTER = Object.freeze({
  modes: Object.freeze(['hide', 'include']),
  defaultMode: 'hide',
  maxBytes: 7000,
  maxName: 100,
});

// The real "Claim Now" markup was captured on 2026-10-03 (test/README.md, DOM notes);
// set to false to force the setting off again if Twitch changes it.
export const AUTO_CLAIM_AVAILABLE = true;

// Diagnostics (diag/README.md), switched by settings.diagnostics: unrecognized markup saved
// by the scraper (chrome.storage.local).
export const DIAG_KEY = 'diagCaptures';
// chrome.storage.sync: live watch of an open inventory tab ('off', 'observe', or 'reload5' /
// 'reload15': observe, and reload the tab every 5 / 15 minutes).
export const DIAG_LIVE_KEY = 'diagLiveWatch';
export const DIAG_LIVE_MODES = Object.freeze({ off: 0, observe: 0, reload5: 5, reload15: 15 });
// chrome.storage.local: scrubbed copies of the Twitch data (GQL responses) a drops page
// received, saved while both settings.diagnostics and settings.twitchApi are on.
export const DIAG_GQL_KEY = 'diagGql';
// chrome.storage.sync: which diagnostics checks run ({id: boolean}, every check on by
// default), under the settings.diagnostics master switch. The diagnostics page offers
// scenario presets; only the toggles are stored (a preset is recognized from them).
export const DIAG_CHECKS_KEY = 'diagChecks';
export const DIAG_CHECKS = Object.freeze([
  'dropsMarkup', 'liveWatch', 'gqlDrops', 'streamClaim', 'streamDropUi', 'streamToast', 'streamStuck', 'gqlStream', 'stallPanel',
]);
// The stream watcher's kinds (diag/watch.js findStreamAnomalies) by check.
export const STREAM_KINDS = Object.freeze({ streamClaim: 'claim-like', streamDropUi: 'drop-ui', streamToast: 'toast' });
export const DIAG_PRESETS = Object.freeze({
  quiet: Object.freeze([]),
  streamClaim: Object.freeze(['streamClaim', 'streamDropUi', 'streamToast', 'gqlStream']),
  autoClaim: Object.freeze(['dropsMarkup', 'liveWatch']),
  stall: Object.freeze(['stallPanel', 'gqlStream']),
  stuck: Object.freeze(['streamStuck', 'stallPanel', 'gqlStream']),
  gqlShapes: Object.freeze(['gqlDrops', 'gqlStream']),
  everything: DIAG_CHECKS,
});

export function sanitizeDiagChecks(value) {
  const v = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(DIAG_CHECKS.map((id) => [id, typeof v[id] === 'boolean' ? v[id] : true]));
}

/** The toggles a preset sets. */
export function presetChecks(name) {
  const on = new Set(DIAG_PRESETS[name] ?? DIAG_CHECKS);
  return Object.fromEntries(DIAG_CHECKS.map((id) => [id, on.has(id)]));
}

/** The preset the toggles match, or 'custom'. */
export function presetOf(checks) {
  const c = sanitizeDiagChecks(checks);
  return Object.keys(DIAG_PRESETS).find((name) => {
    const p = presetChecks(name);
    return DIAG_CHECKS.every((id) => p[id] === c[id]);
  }) ?? 'custom';
}

/** The stream watcher kinds switched on. */
export const streamKinds = (checks) => Object.entries(STREAM_KINDS)
  .filter(([id]) => sanitizeDiagChecks(checks)[id]).map(([, kind]) => kind);

const LIMITS = {
  campaigns: 500, drops: 100, rewards: 30, channels: 30, warnings: 50, text: 300,
  claims: 1000, progressBlocks: 50, progressRows: 50, earned: 200,
};

export function statusRank(status) {
  return DROP_STATUSES.indexOf(status);
}

function str(value, max = LIMITS.text) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function oneOf(value, list, fallback) {
  return list.includes(value) ? value : fallback;
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1e6) : null;
}

/** Absolute https URL or ''. */
export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function percent(value) {
  return Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value)) * 100) / 100 : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !value) return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function id(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : '';
}

function twitchIdOf(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:#-]{1,120}$/.test(value) ? value : '';
}

function list(value, max, fn) {
  return Array.isArray(value) ? value.slice(0, max).map(fn).filter(Boolean) : [];
}

function reward(r) {
  return r && typeof r === 'object'
    ? { name: str(r.name), imageUrl: httpsUrl(r.imageUrl), type: str(r.type, 60) }
    : null;
}

export function sanitizeDrop(d) {
  if (!d || typeof d !== 'object' || !id(d.id)) return null;
  const drop = {
    id: d.id,
    name: str(d.name),
    groupName: str(d.groupName),
    imageUrl: httpsUrl(d.imageUrl),
    rewards: list(d.rewards, LIMITS.rewards, reward),
    dropType: oneOf(d.dropType, DROP_TYPES, 'watch'),
    requiredMinutes: count(d.requiredMinutes),
    requiredSubs: count(d.requiredSubs),
    progressMinutes: count(d.progressMinutes) ?? 0,
    progressPercent: percent(d.progressPercent) ?? 0,
    status: oneOf(d.status, DROP_STATUSES, 'locked'),
    startAt: isoDate(d.startAt),
    endAt: isoDate(d.endAt),
    channelScope: oneOf(d.channelScope, CHANNEL_SCOPES, 'any'),
    channels: list(d.channels, LIMITS.channels, (c) => {
      const login = typeof c?.login === 'string' && /^[a-z0-9_]{1,25}$/.test(c.login) ? c.login : '';
      return login ? { login, displayName: str(c.displayName, 60) || login } : null;
    }),
    watchURL: httpsUrl(d.watchURL),
  };
  if (typeof d.firstSeen === 'string') drop.firstSeen = isoDate(d.firstSeen);
  if (typeof d.claimedAt === 'string' && isoDate(d.claimedAt)) drop.claimedAt = isoDate(d.claimedAt);
  // Twitch's id for the drop, from Twitch data (core/gql.js).
  if (twitchIdOf(d.twitchId)) drop.twitchId = d.twitchId;
  return drop;
}

export function sanitizeCampaign(c) {
  if (!c || typeof c !== 'object' || !id(c.id)) return null;
  const campaign = {
    id: c.id,
    game: str(c.game),
    gameSlug: str(c.gameSlug, 100),
    name: str(c.name),
    publisher: str(c.publisher),
    imageUrl: httpsUrl(c.imageUrl),
    startDate: isoDate(c.startDate),
    endDate: isoDate(c.endDate),
    detailsURL: httpsUrl(c.detailsURL),
    accountLinkURL: httpsUrl(c.accountLinkURL),
    // '' = unknown (card body not read).
    connection: oneOf(c.connection, CONNECTIONS, ''),
    isRewardCampaign: c.isRewardCampaign === true,
    closed: c.closed === true,
    bodyParsed: c.bodyParsed === true,
    drops: list(c.drops, LIMITS.drops, sanitizeDrop),
  };
  // A card made from Twitch data for a game the campaigns page did not show (core/gql.js).
  if (c.fromTwitchData === true) campaign.fromTwitchData = true;
  if (typeof c.firstSeen === 'string') campaign.firstSeen = isoDate(c.firstSeen);
  // When the card body was last read: orders the incremental re-reads (core/scan-plan.js).
  if (typeof c.bodyReadAt === 'string' && isoDate(c.bodyReadAt)) campaign.bodyReadAt = isoDate(c.bodyReadAt);
  // From Twitch data (core/gql.js): Twitch's ids of the campaigns in the card and of every
  // drop they listed, which the dashboard is compared with (changedCards).
  const twitchIds = list(c.twitchIds, 50, twitchIdOf);
  if (twitchIds.length) campaign.twitchIds = twitchIds;
  const twitchDropIds = list(c.twitchDropIds, 300, twitchIdOf);
  if (twitchDropIds.length) campaign.twitchDropIds = twitchDropIds;
  return campaign;
}

export function sanitizeCampaigns(value) {
  return list(value, LIMITS.campaigns, sanitizeCampaign);
}

export function sanitizeWarnings(value) {
  return list(value, LIMITS.warnings, (w) => str(String(w), 120));
}

// The offered choice nearest to `value` (the default when it is not a number).
function snap(value, { options, default: fallback }) {
  const v = Number.isFinite(value) ? value : fallback;
  return options.reduce((best, o) => (Math.abs(o - v) < Math.abs(best - v) ? o : best));
}

export function sanitizeSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    historyDays: snap(v.historyDays, SETTINGS.historyDays),
    incremental: typeof v.incremental === 'boolean' ? v.incremental : SETTINGS.incremental.default,
    incrementalCount: snap(v.incrementalCount, SETTINGS.incrementalCount),
    autoClaim: AUTO_CLAIM_AVAILABLE && v.autoClaim === true,
    inventoryCheck: snap(v.inventoryCheck, SETTINGS.inventoryCheck),
    dropAlert: v.dropAlert === true,
    stallDetect: typeof v.stallDetect === 'boolean' ? v.stallDetect : SETTINGS.stallDetect.default,
    stallReload: v.stallReload === true,
    stallReloadActive: v.stallReloadActive === true,
    stallReloadMax: snap(v.stallReloadMax, SETTINGS.stallReloadMax),
    connectionFilter: oneOf(v.connectionFilter, SETTINGS.connectionFilter.options, SETTINGS.connectionFilter.default),
    groupBy: oneOf(v.groupBy, SETTINGS.groupBy.options, SETTINGS.groupBy.default),
    hideComplete: typeof v.hideComplete === 'boolean' ? v.hideComplete : SETTINGS.hideComplete.default,
    hideSubDrops: typeof v.hideSubDrops === 'boolean' ? v.hideSubDrops : SETTINGS.hideSubDrops.default,
    language: oneOf(v.language, SETTINGS.language.options, SETTINGS.language.default),
    diagnostics: v.diagnostics === true,
    twitchApi: v.twitchApi === true,
  };
}

export function sanitizeGameFilter(value) {
  const v = value && typeof value === 'object' ? value : {};
  const games = [];
  const seen = new Set();
  let bytes = 0;
  for (const g of Array.isArray(v.games) ? v.games : []) {
    const name = str(g, GAME_FILTER.maxName);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    // JSON string size in UTF-8, plus quotes and a comma.
    const size = new TextEncoder().encode(JSON.stringify(name)).length + 1;
    if (bytes + size > GAME_FILTER.maxBytes) break;
    bytes += size;
    seen.add(key);
    games.push(name);
  }
  return { mode: oneOf(v.mode, GAME_FILTER.modes, GAME_FILTER.defaultMode), games };
}

/**
 * One in-progress campaign block from the inventory page: its heading (a campaign or a
 * drop-block name), end date, and one row per drop with its rewards and progress.
 */
function sanitizeProgressBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const rows = list(b.rows, LIMITS.progressRows, (r) => {
    if (!r || typeof r !== 'object') return null;
    const rewards = list(r.rewards, LIMITS.rewards, reward).filter((x) => x.name || x.imageUrl);
    return rewards.length ? {
      ...(twitchIdOf(r.twitchId) ? { twitchId: r.twitchId } : {}),
      rewards,
      percent: percent(r.percent) ?? 0,
      requiredMinutes: count(r.requiredMinutes),
      claimable: r.claimable === true,
    } : null;
  });
  return rows.length ? { title: str(b.title), endDate: isoDate(b.endDate), rows } : null;
}

/**
 * A claimed-history item. `claimedAt` is estimated from a relative time ("3 days ago") and
 * `unit` is its precision; the id is the reward (name and image), so the same reward seen
 * in later scans, at a coarser age, is the same claim.
 */
export function sanitizeClaim(c) {
  if (!c || typeof c !== 'object' || !id(c.id) || !isoDate(c.claimedAt)) return null;
  const claim = {
    id: c.id,
    name: str(c.name),
    imageUrl: httpsUrl(c.imageUrl),
    claimedAt: isoDate(c.claimedAt),
    unit: oneOf(c.unit, Object.keys(TIME_UNITS), 'day'),
  };
  if (typeof c.firstSeen === 'string' && isoDate(c.firstSeen)) claim.firstSeen = isoDate(c.firstSeen);
  return claim.name || claim.imageUrl ? claim : null;
}

export function sanitizeClaims(value) {
  return list(value, LIMITS.claims, sanitizeClaim);
}

/** An inventory scan payload (or the stored `inventory` key, which has the same fields). */
export function sanitizeInventory(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    progress: list(v.progress, LIMITS.progressBlocks, sanitizeProgressBlock),
    claims: sanitizeClaims(v.claims),
    earned: list(v.earned, LIMITS.earned, reward).filter((r) => r.name || r.imageUrl),
  };
}
