// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Applies inventory-page data to stored campaigns, and merges claimed history. Pure and
// idempotent, like merge.js. Rules:
// - drops are matched to inventory rows and claims by reward image URL (the same URL on
//   both pages); reward names are only a fallback, because short names ("Banner") repeat
//   across games;
// - an in-progress row raises a drop to in_progress (claimable with a "Claim Now" button)
//   and raises its progress; nothing ever lowers status or progress (merge.js keeps the
//   higher of stored and scanned, and keeps claimed drops Twitch stops listing);
// - a claim marks a drop claimed only if it could have happened after the campaign started,
//   so a reward image reused by a later campaign is not claimed in advance;
// - the history is keyed by reward: a later sighting of the same claim, now printed with a
//   coarser age ("last month" instead of "25 days ago"), keeps the finer estimate;
// - the history is pruned: claims older than the history setting go, and at most 1000 are kept.

import { TIME_UNITS, SETTINGS, statusRank } from './schema.js';

const LIMIT_CLAIMS = 1000;

/**
 * @param {object[]} stored  sanitized stored claims
 * @param {object[]} scanned  sanitized claims from a scan
 * @param {Date|number} now
 * @param {number} [historyDays]  settings.historyDays
 * @returns {object[]} newest first, pruned (pruneClaims)
 */
export function mergeClaims(stored, scanned, now, historyDays = SETTINGS.historyDays.default) {
  const nowIso = new Date(now).toISOString();
  const byId = new Map(stored.map((c) => [c.id, c]));
  for (const claim of scanned) {
    const old = byId.get(claim.id);
    if (!old) {
      byId.set(claim.id, { ...claim, firstSeen: nowIso });
      continue;
    }
    // Claimed again since (a reward that recurs), or the same claim measured more finely.
    if (isLaterClaim(old, claim) || unitMs(claim) < unitMs(old)) {
      byId.set(claim.id, { ...claim, firstSeen: old.firstSeen || nowIso });
    }
  }
  return pruneClaims([...byId.values()], now, historyDays);
}

/**
 * Sorts the history newest first, drops claims older than `historyDays` (the inventory read
 * goes no further back, and a drop keeps its claimed status without them) and keeps the
 * newest LIMIT_CLAIMS.
 * @param {object[]} claims  sanitized claims
 * @param {Date|number} now
 * @param {number} [historyDays]  settings.historyDays
 */
export function pruneClaims(claims, now, historyDays = SETTINGS.historyDays.default) {
  const oldest = new Date(now).getTime() - historyDays * TIME_UNITS.day;
  return claims
    .filter((c) => Date.parse(c.claimedAt) >= oldest)
    .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt) || a.id.localeCompare(b.id))
    .slice(0, LIMIT_CLAIMS);
}

const unitMs = (claim) => TIME_UNITS[claim.unit] ?? TIME_UNITS.day;

/**
 * True if `claim` is a later claim of the reward `old` records (a reward that recurs), not
 * the same claim seen again: their estimated times differ by more than either's precision.
 */
export function isLaterClaim(old, claim) {
  return Date.parse(claim.claimedAt) - Date.parse(old.claimedAt) > Math.max(unitMs(old), unitMs(claim));
}

/**
 * True if a scanned claim is already in the stored history (same reward, consistent time).
 * A passive inventory sweep stops loading older history once it reaches one: everything
 * older was read before.
 * @param {Map<string, object>} storedById  stored claims by id
 * @param {object} claim  a scanned claim
 */
export function isKnownClaim(storedById, claim) {
  const old = storedById.get(claim.id);
  return !!old && !isLaterClaim(old, claim);
}

const lower = (s) => String(s ?? '').toLowerCase();

function dropImages(drop) {
  return new Set([drop.imageUrl, ...drop.rewards.map((r) => r.imageUrl)].filter(Boolean));
}

function dropNames(drop) {
  return new Set(drop.rewards.map((r) => lower(r.name)).filter(Boolean));
}

function raise(drop, status) {
  return statusRank(status) > statusRank(drop.status) ? status : drop.status;
}

/**
 * @param {object[]} campaigns  sanitized stored campaigns
 * @param {{progress: object[], earned: object[]}} inventory  sanitized inventory data
 * @param {object[]} claims  sanitized claim history
 * @returns {{campaigns: object[], unmatchedRows: number}}
 */
export function applyInventory(campaigns, inventory, claims) {
  // Copy every drop once; updates below change the copies only.
  const result = campaigns.map((c) => ({ ...c, drops: c.drops.map((d) => ({ ...d })) }));
  const entries = result.flatMap((campaign) => campaign.drops.map((drop) => ({
    campaign, drop, images: dropImages(drop), names: dropNames(drop),
  })));
  let unmatchedRows = 0;

  const used = new Set();
  for (const block of inventory?.progress ?? []) {
    const title = lower(block.title);
    for (const row of block.rows) {
      const entry = bestRowMatch(entries, block, title, row, used);
      if (!entry) {
        unmatchedRows++;
        continue;
      }
      used.add(entry);
      const { drop } = entry;
      const required = drop.requiredMinutes ?? row.requiredMinutes;
      drop.progressPercent = Math.max(drop.progressPercent ?? 0, row.percent);
      if (required !== null) {
        drop.progressMinutes = Math.max(drop.progressMinutes ?? 0, Math.round((row.percent / 100) * required));
      }
      drop.status = raise(drop, row.claimable ? 'claimable' : 'in_progress');
    }
  }

  for (const claim of claims ?? []) {
    const latest = Date.parse(claim.claimedAt) + (TIME_UNITS[claim.unit] ?? TIME_UNITS.day) / 2;
    for (const entry of entries) {
      const hit = claim.imageUrl ? entry.images.has(claim.imageUrl) : entry.names.has(lower(claim.name));
      if (!hit) continue;
      const start = Date.parse(entry.campaign.startDate);
      if (Number.isFinite(start) && latest < start) continue;
      markClaimed(entry.drop, claim.claimedAt);
    }
  }

  // Earned rewards (inventory "Rewards" section) belong to reward campaigns; no date given.
  for (const reward of inventory?.earned ?? []) {
    if (!reward.imageUrl) continue;
    for (const entry of entries) {
      if (entry.campaign.isRewardCampaign && entry.images.has(reward.imageUrl)) markClaimed(entry.drop, '');
    }
  }
  return { campaigns: result, unmatchedRows };
}

function markClaimed(drop, claimedAt) {
  drop.status = 'claimed';
  drop.progressPercent = 100;
  if (drop.requiredMinutes !== null) drop.progressMinutes = Math.max(drop.progressMinutes ?? 0, drop.requiredMinutes);
  if (claimedAt && !drop.claimedAt) drop.claimedAt = claimedAt;
}

// The drop an in-progress row belongs to. Its Twitch id first (rows from Twitch data); then
// image matches (all of the row's images must be the drop's), and among those the drop whose
// requirement, block name and end date agree with the row, preferring one no other row has
// taken. Without image matches, reward names are tried, but only in campaigns the block
// heading names.
function bestRowMatch(entries, block, title, row, used) {
  // A row from Twitch data carries the drop's Twitch id (core/gql.js).
  const byId = row.twitchId ? entries.find((e) => e.drop.twitchId === row.twitchId) : null;
  if (byId) return byId;
  const rowImages = row.rewards.map((r) => r.imageUrl).filter(Boolean);
  const rowNames = row.rewards.map((r) => lower(r.name)).filter(Boolean);
  const related = (e) => !!title && (lower(e.campaign.name) === title || lower(e.drop.groupName) === title);
  let candidates = rowImages.length ? entries.filter((e) => rowImages.every((u) => e.images.has(u))) : [];
  if (!candidates.length && rowNames.length) {
    candidates = entries.filter((e) => related(e) && rowNames.every((n) => e.names.has(n)));
  }
  let best = null;
  let bestScore = -1;
  for (const e of candidates) {
    const score = (row.requiredMinutes !== null && e.drop.requiredMinutes === row.requiredMinutes ? 8 : 0)
      + (related(e) ? 4 : 0)
      + (block.endDate && (e.drop.endAt === block.endDate || e.campaign.endDate === block.endDate) ? 2 : 0)
      + (used.has(e) ? 0 : 1);
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}
