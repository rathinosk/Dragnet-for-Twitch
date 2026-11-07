// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Twitch page data: the GQL responses Twitch's own drops pages receive, copied by
// scraper/gql-hook.js while settings.twitchApi is on. Pure: no chrome.*, so the harness can
// test it. A message can come from any script on the page, so everything is untrusted:
// parsers coerce every field, keep https URLs only, and bound every list.
//
// Shapes (test/README.md, GQL notes):
// - ViewerDropsDashboard (campaigns page, once): every campaign with its drop ids, no names.
// - DropCampaignDetails (campaigns page, once per card opened): one campaign in full.
// - Inventory (inventory page; again per Load More): progress of campaigns in progress, and
//   earnedDropRewards, the claim history with exact times.
// Precedence (core/gql.js applyGqlDetails): the DOM decides which game cards exist; Twitch
// data adds precision (exact times, ids) and the drops of a card's game the DOM missed.

import { stableId } from '../scraper/normalize.js';
import { statusRank } from './schema.js';

// Keep in sync with OPERATION in scraper/gql-hook.js.
export const GQL_OPERATION = /drop|inventory|campaign|reward|claim/i;

const OPERATION_NAME = /^[A-Za-z0-9_]{1,80}$/;

/**
 * A message posted by the hook, checked: `{operationName, variables, data, at}` or null.
 * @param {unknown} value the message's `data`
 */
export function gqlItem(value) {
  if (!value || typeof value !== 'object' || value.source !== 'dragnet-gql') return null;
  const { operationName, variables, data, at } = value;
  if (typeof operationName !== 'string' || !OPERATION_NAME.test(operationName) || !GQL_OPERATION.test(operationName)) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return {
    operationName,
    variables: variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : null,
    data,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

// Scrubbing (diagnostics captures) ---------------------------------------------------------

// Keys whose values are never kept in a capture, whatever they hold.
const SECRET_KEY = /token|secret|password|email|cookie|integrity/i;
// Paging cursors are base64 JSON that can hold the viewer's id ("user_id").
const BASE64 = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/**
 * The viewer's own identifiers in a response: `currentUser`, and the `user` at the root of
 * `data` (the drops operations query the viewer that way). Their id, login and display name.
 */
export function viewerIdentities(data) {
  const found = new Set();
  for (const user of [data?.currentUser, data?.user]) {
    if (!user || typeof user !== 'object') continue;
    for (const k of ['id', 'login', 'displayName']) {
      if (typeof user[k] === 'string' && user[k].length >= 2) found.add(user[k]);
    }
  }
  return found;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function decodeBase64(s) {
  try {
    return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return '';
  }
}

/**
 * A copy of `value` safe to save in a diagnostics capture: secret-looking keys become
 * 'REDACTED', every occurrence of the viewer's identifiers (`identities`, any case) becomes
 * 'USER', and a base64 string that decodes to text holding one of them becomes 'REDACTED'.
 * Depth- and size-bounded.
 * @param {unknown} value
 * @param {Iterable<string>} identities
 */
export function scrubGql(value, identities = []) {
  const ids = [...new Set(identities)].filter((s) => typeof s === 'string' && s.length >= 2)
    .sort((a, b) => b.length - a.length);
  const re = ids.length ? new RegExp(ids.map(escapeRe).join('|'), 'gi') : null;
  const has = (s) => { re.lastIndex = 0; return re.test(s); };
  const scrubString = (s) => {
    if (!re) return s;
    if (BASE64.test(s) && has(decodeBase64(s))) return 'REDACTED';
    return s.replace(re, 'USER');
  };
  const walk = (v, depth) => {
    if (depth > 40) return null;
    if (typeof v === 'string') return scrubString(v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (Array.isArray(v)) return v.slice(0, 2000).map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        out[scrubString(k)] = SECRET_KEY.test(k) && x !== null && typeof x !== 'boolean' ? 'REDACTED' : walk(x, depth + 1);
      }
      return out;
    }
    return null;
  };
  return walk(value, 0);
}

// Coercion ---------------------------------------------------------------------------------

const LIMITS = {
  campaigns: 500, drops: 100, rewards: 30, channels: 30, dropIds: 300, text: 300,
  claims: 1000, progressCampaigns: 50,
};

const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const nat = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 1e6) : null);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const twitchId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:#-]{1,120}$/.test(v) ? v : '');

function https(v) {
  if (typeof v !== 'string' || v.length > 2048) return '';
  try {
    const url = new URL(v);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function iso(v) {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

export function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

const REWARD_TYPES = { DIRECT_ENTITLEMENT: 'In-Game Item', BADGE: 'Badge', EMOTE: 'Emote' };

function benefits(drop) {
  return arr(drop?.benefitEdges, LIMITS.rewards).map((e) => e?.benefit).filter(Boolean)
    .map((b) => ({ name: str(b.name), imageUrl: https(b.imageAssetURL), type: REWARD_TYPES[b.distributionType] ?? '' }))
    .filter((r) => r.name || r.imageUrl);
}

// Parsers ----------------------------------------------------------------------------------

const ofOp = (items, name) => (Array.isArray(items) ? items : []).filter((i) => i?.operationName === name);

function detailsDrop(t) {
  const requiredMinutes = nat(t?.requiredMinutesWatched);
  const requiredSubs = nat(t?.requiredSubs);
  const sub = !requiredMinutes && requiredSubs > 0;
  const id = twitchId(t?.id);
  return id ? {
    twitchId: id,
    name: str(t.name),
    startAt: iso(t.startAt),
    endAt: iso(t.endAt),
    dropType: sub ? 'sub' : 'watch',
    requiredMinutes: sub ? null : requiredMinutes,
    requiredSubs: sub ? requiredSubs : null,
    rewards: benefits(t),
  } : null;
}

/**
 * DropCampaignDetails responses -> one entry per campaign.
 * @returns {{data: object[], warnings: string[]}}
 */
export function parseCampaignDetails(items) {
  const data = [];
  let bad = 0;
  for (const item of ofOp(items, 'DropCampaignDetails')) {
    const c = item.data?.user?.dropCampaign;
    const id = twitchId(c?.id);
    const game = str(c?.game?.displayName ?? c?.game?.name);
    if (!id || !game || !Array.isArray(c.timeBasedDrops)) {
      bad++;
      continue;
    }
    const allow = c.allow?.isEnabled === true ? arr(c.allow.channels, 10000) : [];
    data.push({
      twitchId: id,
      game,
      gameSlug: str(c.game?.slug, 100),
      name: str(c.name),
      status: str(c.status, 20),
      startAt: iso(c.startAt),
      endAt: iso(c.endAt),
      connected: typeof c.self?.isAccountConnected === 'boolean' ? c.self.isAccountConnected : null,
      channelCount: allow.length,
      channels: allow.slice(0, LIMITS.channels).map((ch) => {
        const login = typeof ch?.name === 'string' && /^[a-z0-9_]{1,25}$/.test(ch.name) ? ch.name : '';
        return login ? { login, displayName: str(ch.displayName, 60) || login } : null;
      }).filter(Boolean),
      drops: arr(c.timeBasedDrops, LIMITS.drops).map(detailsDrop).filter(Boolean),
    });
  }
  return { data: data.slice(0, LIMITS.campaigns), warnings: bad ? ['gql:DropCampaignDetails:unrecognized'] : [] };
}

/**
 * ViewerDropsDashboard -> active campaigns with their drops' ids and requirements (the
 * newest response). No drop names or rewards: those come only with a card's details.
 * @returns {{data: object[]|null, warnings: string[]}}
 */
export function parseDashboard(items) {
  const item = ofOp(items, 'ViewerDropsDashboard').at(-1);
  if (!item) return { data: null, warnings: [] };
  const list = item.data?.currentUser?.dropCampaigns;
  if (!Array.isArray(list)) return { data: null, warnings: ['gql:ViewerDropsDashboard:unrecognized'] };
  const data = list.slice(0, LIMITS.campaigns)
    .filter((c) => c?.status === 'ACTIVE' && twitchId(c.id))
    .map((c) => dashboardCampaign(c, c.game?.boxArtURL, c.owner?.name))
    .filter(Boolean);
  return { data, warnings: [] };
}

function dashboardCampaign(c, boxArt, publisher) {
  const id = twitchId(c?.twitchId ?? c?.id);
  const game = str(c?.game?.displayName ?? c?.game);
  if (!id || !game) return null;
  return {
    twitchId: id,
    game,
    name: str(c.name),
    publisher: str(publisher),
    imageUrl: https(boxArt),
    startAt: iso(c.startAt),
    endAt: iso(c.endAt),
    connected: typeof (c.self?.isAccountConnected ?? c.connected) === 'boolean' ? (c.self?.isAccountConnected ?? c.connected) : null,
    accountLinkURL: https(c.accountLinkURL),
    detailsURL: https(c.detailsURL),
    drops: arr(c.timeBasedDrops ?? c.drops, LIMITS.drops).map((t) => {
      const did = twitchId(t?.id ?? t?.twitchId);
      const minutes = nat(t?.requiredMinutesWatched ?? t?.requiredMinutes);
      const subs = nat(t?.requiredSubs);
      const sub = !minutes && subs > 0;
      return did ? { twitchId: did, requiredMinutes: sub ? null : minutes, requiredSubs: sub ? subs : null } : null;
    }).filter(Boolean),
  };
}

/** The `gql.dashboard` of a campaigns scan message, re-checked. */
export function sanitizeGqlDashboard(value) {
  return arr(value, LIMITS.campaigns).map((c) => (c && typeof c === 'object'
    ? dashboardCampaign(c, c.imageUrl, c.publisher) : null)).filter(Boolean);
}

/**
 * Inventory responses -> progress blocks in the inventory scan's shape (core/schema.js,
 * sanitizeInventory) and claims with exact times (unit 'exact'), ids as the DOM parser
 * builds them (reward name and image), newest per id. `oldestAgeMs`: how far back the claim
 * history reaches, so the scan can skip "Load More".
 * @returns {{data: {progress: object[], claims: object[], oldestAgeMs: number}|null, warnings: string[]}}
 */
export function parseInventory(items, now = Date.now()) {
  const list = ofOp(items, 'Inventory');
  if (!list.length) return { data: null, warnings: [] };
  const inventories = list.map((i) => i.data?.currentUser?.inventory).filter((v) => v && typeof v === 'object');
  const first = inventories.find((inv) => Array.isArray(inv.dropCampaignsInProgress));
  if (!first) return { data: null, warnings: ['gql:Inventory:unrecognized'] };

  const progress = arr(first.dropCampaignsInProgress, LIMITS.progressCampaigns).map((c) => {
    const rows = arr(c?.timeBasedDrops, LIMITS.drops).map((t) => {
      const rewards = benefits(t);
      if (!rewards.length) return null;
      const self = t.self ?? {};
      const minutes = nat(t.requiredMinutesWatched);
      const subs = nat(t.requiredSubs);
      const ratio = minutes ? (nat(self.currentMinutesWatched) ?? 0) / minutes
        : subs ? (nat(self.currentSubs) ?? 0) / subs : 0;
      const claimed = self.isClaimed === true;
      return {
        twitchId: twitchId(t.id),
        rewards,
        percent: claimed ? 100 : Math.round(Math.min(1, ratio) * 10000) / 100,
        requiredMinutes: minutes || null,
        // Earned and not claimed: Twitch has made the drop instance.
        claimable: !claimed && typeof self.dropInstanceID === 'string' && self.dropInstanceID !== '',
      };
    }).filter(Boolean);
    return rows.length ? { title: str(c.name), endDate: iso(c.endAt), rows } : null;
  }).filter(Boolean);

  // The claim history: earnedDropRewards (all of it, in one response) and the claimed list
  // (gameEventDropsConnection, one page per Load More).
  const found = [];
  for (const inv of inventories) {
    for (const e of arr(inv.earnedDropRewards?.edges, 2000)) {
      const n = e?.node;
      if (n?.status !== 'CLAIMED') continue;
      found.push({ name: str(n.item?.name), imageUrl: https(n.item?.thumbnailURL), claimedAt: iso(n.earnedAt) });
    }
    for (const e of arr(inv.gameEventDropsConnection?.edges, 2000)) {
      const n = e?.node;
      found.push({ name: str(n?.name), imageUrl: https(n?.imageURL), claimedAt: iso(n?.lastAwardedAt) });
    }
  }
  const byId = new Map();
  for (const c of found) {
    if (!c.claimedAt || !(c.name || c.imageUrl)) continue;
    const id = stableId('claim', c.name, c.imageUrl);
    const old = byId.get(id);
    if (!old || c.claimedAt > old.claimedAt) byId.set(id, { id, ...c, unit: 'exact' });
  }
  const claims = [...byId.values()].sort((a, b) => b.claimedAt.localeCompare(a.claimedAt)).slice(0, LIMITS.claims);
  const oldest = found.map((c) => Date.parse(c.claimedAt)).filter(Number.isFinite);
  const nowMs = new Date(now).getTime();
  return {
    data: { progress, claims, oldestAgeMs: oldest.length ? Math.max(0, nowMs - Math.min(...oldest)) : 0 },
    warnings: [],
  };
}

/**
 * Inventory progress blocks: Twitch data's, plus the DOM's for campaigns it does not cover
 * (reward campaigns come from another operation).
 */
export function mergeProgress(domBlocks, gqlBlocks) {
  const images = new Set(gqlBlocks.flatMap((b) => b.rows.flatMap((r) => r.rewards.map((x) => x.imageUrl))).filter(Boolean));
  const titles = new Set(gqlBlocks.map((b) => fold(b.title)));
  const kept = domBlocks.filter((b) => !titles.has(fold(b.title))
    && !b.rows.some((r) => r.rewards.some((x) => x.imageUrl && images.has(x.imageUrl))));
  return [...gqlBlocks, ...kept];
}

/**
 * Claims: the DOM's, each replaced by Twitch data's exact claim of the same id, plus the
 * exact claims the DOM did not reach. Newest first.
 */
export function mergeExactClaims(domClaims, exactClaims) {
  const exact = new Map(exactClaims.map((c) => [c.id, c]));
  const out = domClaims.map((c) => exact.get(c.id) ?? c);
  const seen = new Set(out.map((c) => c.id));
  for (const c of exactClaims) if (!seen.has(c.id)) out.push(c);
  return out.sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
}

// Sanitizing (background) -------------------------------------------------------------------

/** The `gql.details` of a campaigns scan message, re-checked (the content script is on a page we do not control). */
export function sanitizeGqlDetails(value) {
  return arr(value, LIMITS.campaigns).map((c) => {
    const id = twitchId(c?.twitchId);
    const game = str(c?.game);
    if (!id || !game) return null;
    return {
      twitchId: id,
      game,
      gameSlug: str(c.gameSlug, 100),
      name: str(c.name),
      status: str(c.status, 20),
      startAt: iso(c.startAt),
      endAt: iso(c.endAt),
      connected: typeof c.connected === 'boolean' ? c.connected : null,
      channelCount: nat(c.channelCount) ?? 0,
      channels: arr(c.channels, LIMITS.channels).map((ch) => {
        const login = typeof ch?.login === 'string' && /^[a-z0-9_]{1,25}$/.test(ch.login) ? ch.login : '';
        return login ? { login, displayName: str(ch.displayName, 60) || login } : null;
      }).filter(Boolean),
      drops: arr(c.drops, LIMITS.drops).map((d) => {
        const did = twitchId(d?.twitchId);
        return did ? {
          twitchId: did,
          name: str(d.name),
          startAt: iso(d.startAt),
          endAt: iso(d.endAt),
          dropType: d.dropType === 'sub' ? 'sub' : 'watch',
          requiredMinutes: nat(d.requiredMinutes),
          requiredSubs: nat(d.requiredSubs),
          rewards: arr(d.rewards, LIMITS.rewards).map((r) => ({ name: str(r?.name), imageUrl: https(r?.imageUrl), type: str(r?.type, 60) }))
            .filter((r) => r.name || r.imageUrl),
        } : null;
      }).filter(Boolean),
    };
  }).filter(Boolean);
}

// Applying to stored campaigns ---------------------------------------------------------------

const imagesOf = (drop) => new Set([drop.imageUrl, ...(drop.rewards ?? []).map((r) => r.imageUrl)].filter(Boolean));

/**
 * Applies DropCampaignDetails to campaigns (after the campaigns scan is merged). For each
 * active Twitch campaign, the card of its game (by name, ignoring case and accents) gets:
 * - on each drop that matches by reward image (and requirement, block name and end date,
 *   since one reward image can serve several drops): the Twitch id, exact start and end, and
 *   the requirement if the DOM had none;
 * - each drop the DOM did not show, added as a new drop;
 * - the Twitch campaign and drop ids (`twitchIds`, `twitchDropIds`: what the dashboard is
 *   compared with), and the connection if the DOM had not read it.
 * A campaign whose game has no card is skipped: the DOM decides which cards exist.
 * Pure; returns new objects for the campaigns it changes.
 * @returns {{campaigns: object[], matched: number, added: number}}
 */
export function applyGqlDetails(campaigns, details, now = Date.now()) {
  const nowMs = new Date(now).getTime();
  const result = campaigns.slice();
  const cardOf = new Map();
  result.forEach((c, i) => {
    const key = fold(c.game);
    if (!c.isRewardCampaign && !cardOf.has(key)) cardOf.set(key, i);
  });
  let matched = 0;
  let added = 0;
  // Twitch ids still current. A recurring campaign renewed by Twitch gets new drop ids, but
  // its page drop keeps its id (a hash of names and images) and with it the old Twitch id;
  // that drop must stay matchable, or the renewed drop is added beside it as a duplicate.
  const current = new Set(details.filter((g) => !g.status || g.status === 'ACTIVE').flatMap((g) => g.drops.map((t) => t.twitchId)));
  for (const g of details) {
    if (g.status && g.status !== 'ACTIVE') continue;
    const i = cardOf.get(fold(g.game));
    if (i === undefined) continue;
    const card = { ...result[i], drops: result[i].drops.map((d) => ({ ...d })) };
    const taken = new Set(card.drops.map((d) => d.twitchId).filter((id) => id && current.has(id)));
    for (const t of g.drops) {
      if (t.endAt && Date.parse(t.endAt) < nowMs) continue;
      const existing = card.drops.find((d) => d.twitchId === t.twitchId);
      const drop = existing ?? bestDrop(card.drops, g, t, taken);
      if (drop) {
        drop.twitchId = t.twitchId;
        if (t.startAt) drop.startAt = t.startAt;
        if (t.endAt) drop.endAt = t.endAt;
        if (drop.requiredMinutes === null && t.requiredMinutes) drop.requiredMinutes = t.requiredMinutes;
        if (drop.requiredSubs === null && t.requiredSubs) drop.requiredSubs = t.requiredSubs;
        taken.add(t.twitchId);
        matched++;
        continue;
      }
      card.drops.push(newDrop(card, g, t, nowMs));
      taken.add(t.twitchId);
      added++;
    }
    card.twitchIds = [...new Set([...(card.twitchIds ?? []), g.twitchId])].slice(-50);
    card.twitchDropIds = [...new Set([...(card.twitchDropIds ?? []), ...g.drops.map((t) => t.twitchId)])].slice(-LIMITS.dropIds);
    if (!card.connection && g.connected !== null) card.connection = g.connected ? 'connected' : 'not_connected';
    const ends = card.drops.map((d) => d.endAt).filter(Boolean).sort();
    if (ends.length) card.endDate = ends.at(-1);
    result[i] = card;
  }
  return { campaigns: result, matched, added };
}

// The unmatched DOM drop a Twitch drop is: all its reward images must be the drop's; among
// those, the one whose requirement, block name and end date agree.
function bestDrop(drops, campaign, t, taken) {
  const want = t.rewards.map((r) => r.imageUrl).filter(Boolean);
  if (!want.length) return null;
  let best = null;
  let bestScore = -1;
  for (const d of drops) {
    if (d.twitchId && taken.has(d.twitchId)) continue;
    const images = imagesOf(d);
    if (!want.every((u) => images.has(u))) continue;
    const required = t.dropType === 'sub' ? d.requiredSubs === t.requiredSubs : d.requiredMinutes === t.requiredMinutes;
    const score = (required ? 8 : 0) + (fold(d.groupName) === fold(campaign.name) ? 4 : 0)
      + (d.endAt && t.endAt && Math.abs(Date.parse(d.endAt) - Date.parse(t.endAt)) < 864e5 ? 2 : 0);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function newDrop(card, campaign, t, nowMs) {
  const scope = campaign.channelCount ? (campaign.channelCount > campaign.channels.length ? 'listed_more' : 'listed') : 'any';
  const slug = campaign.gameSlug || card.gameSlug;
  return {
    id: stableId('gql', t.twitchId),
    twitchId: t.twitchId,
    name: t.rewards.map((r) => r.name).filter(Boolean).join(' + ') || t.name,
    groupName: campaign.name,
    imageUrl: t.rewards.find((r) => r.imageUrl)?.imageUrl ?? '',
    rewards: t.rewards,
    dropType: t.dropType,
    requiredMinutes: t.requiredMinutes,
    requiredSubs: t.requiredSubs,
    progressMinutes: 0,
    progressPercent: 0,
    status: 'locked',
    startAt: t.startAt,
    endAt: t.endAt,
    channelScope: scope,
    channels: campaign.channels,
    watchURL: scope === 'listed' || !slug ? '' : `https://www.twitch.tv/directory/category/${encodeURIComponent(slug)}?filter=drops`,
    firstSeen: new Date(nowMs).toISOString(),
  };
}

/**
 * Adds a card for each game the dashboard lists with active campaigns but the campaigns
 * page did not show (DOM first: a game with a card is left to the card). Such a card holds
 * what the dashboard gives: the campaigns' names, dates, account link and each drop's
 * requirement, with no reward names or images (those come only with a card's details), so
 * its drops are named after their campaign, and inventory progress reaches them by Twitch
 * drop id. Rebuilt from every campaigns scan that brings the dashboard, like the cards
 * the DOM shows; what was stored for the same card (`previous`) keeps its first-seen dates,
 * and its drops' status and progress (which never go back). Pure.
 * @returns {{campaigns: object[], added: number}}
 */
export function applyGqlDashboard(campaigns, dashboard, now = Date.now(), previous = []) {
  const before = new Map(previous.map((c) => [c.id, c]));
  const nowMs = new Date(now).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const games = new Set(campaigns.map((c) => fold(c.game)));
  const byGame = new Map();
  for (const c of dashboard) {
    if (c.endAt && Date.parse(c.endAt) < nowMs) continue;
    if (!c.drops.length || games.has(fold(c.game))) continue;
    const key = fold(c.game);
    byGame.set(key, [...(byGame.get(key) ?? []), c]);
  }
  const added = [...byGame.values()].map((list) => {
    const game = list[0].game;
    const drops = list.flatMap((c) => c.drops.map((t) => ({
      id: stableId('gql', t.twitchId),
      twitchId: t.twitchId,
      name: '',
      groupName: c.name,
      imageUrl: '',
      rewards: [],
      dropType: t.requiredSubs ? 'sub' : 'watch',
      requiredMinutes: t.requiredMinutes,
      requiredSubs: t.requiredSubs,
      progressMinutes: 0,
      progressPercent: 0,
      status: 'locked',
      startAt: c.startAt,
      endAt: c.endAt,
      channelScope: 'any',
      channels: [],
      watchURL: '',
      firstSeen: nowIso,
    })));
    const connected = list.map((c) => c.connected).filter((v) => v !== null);
    return {
      id: stableId(game, game),
      game,
      gameSlug: '',
      name: game,
      publisher: list[0].publisher,
      imageUrl: list.find((c) => c.imageUrl)?.imageUrl ?? '',
      startDate: list.map((c) => c.startAt).filter(Boolean).sort()[0] ?? '',
      endDate: list.map((c) => c.endAt).filter(Boolean).sort().at(-1) ?? '',
      detailsURL: list.find((c) => c.detailsURL)?.detailsURL ?? '',
      accountLinkURL: list.find((c) => c.accountLinkURL)?.accountLinkURL ?? '',
      connection: !connected.length ? '' : connected.every(Boolean) ? 'connected' : 'not_connected',
      isRewardCampaign: false,
      closed: false,
      bodyParsed: false,
      fromTwitchData: true,
      drops,
      twitchIds: list.map((c) => c.twitchId).slice(0, 50),
      twitchDropIds: drops.map((d) => d.twitchId).slice(0, LIMITS.dropIds),
      firstSeen: nowIso,
    };
  }).map((card) => keepStored(card, before.get(card.id)));
  return { campaigns: [...campaigns, ...added], added: added.length };
}

function keepStored(card, old) {
  if (!old) return card;
  const oldDrops = new Map((old.drops ?? []).map((d) => [d.id, d]));
  return {
    ...card,
    firstSeen: old.firstSeen || card.firstSeen,
    drops: card.drops.map((d) => {
      const o = oldDrops.get(d.id);
      if (!o) return d;
      return {
        ...d,
        firstSeen: o.firstSeen || d.firstSeen,
        status: statusRank(o.status) > statusRank(d.status) ? o.status : d.status,
        progressMinutes: Math.max(o.progressMinutes ?? 0, d.progressMinutes),
        progressPercent: Math.max(o.progressPercent ?? 0, d.progressPercent),
        ...(o.claimedAt ? { claimedAt: o.claimedAt } : {}),
      };
    }),
  };
}

/**
 * Cards a passive sweep should open again because the dashboard shows a drop they do not
 * have (a campaign added to the game, or a drop added to a campaign). Only cards read with
 * Twitch data before (`twitchDropIds`) are compared, so turning the setting on does not
 * reopen every card; a Full sync fills them in.
 * @param {{id: string, game: string}[]} cards  header parses
 * @param {{id: string, twitchDropIds?: string[]}[]} known  stored campaigns
 * @param {{game: string, drops: {twitchId: string}[]}[]} dashboard
 * @returns {Set<string>} card ids
 */
export function changedCards(cards, known, dashboard) {
  const stored = new Map(known.map((c) => [c.id, c]));
  const byGame = new Map();
  for (const c of dashboard ?? []) {
    const key = fold(c.game);
    byGame.set(key, [...(byGame.get(key) ?? []), ...c.drops.map((d) => d.twitchId)]);
  }
  const changed = new Set();
  for (const card of cards) {
    const ids = stored.get(card.id)?.twitchDropIds;
    if (!ids?.length) continue;
    const have = new Set(ids);
    if ((byGame.get(fold(card.game)) ?? []).some((id) => !have.has(id))) changed.add(card.id);
  }
  return changed;
}
