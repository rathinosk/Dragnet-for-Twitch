// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// What the campaign lists show, apart from the filters (core/filter.js): urgency by time
// left, search, grouping by game, and per-campaign claim progress. Pure: no chrome.*, so
// the test harness can call it.

const HOUR = 3600000;

/** Urgency tiers by time left: under a day, under three days, later (or no end date). */
export const URGENCY = Object.freeze({ critical: 24 * HOUR, soon: 72 * HOUR });

export function urgency(endDate, now) {
  const left = Date.parse(endDate ?? '') - new Date(now).getTime();
  if (!Number.isFinite(left)) return 'normal';
  if (left < URGENCY.critical) return 'critical';
  return left < URGENCY.soon ? 'soon' : 'normal';
}

/** Claimed and total drops of a campaign. */
export function claimProgress(campaign) {
  const drops = campaign.drops ?? [];
  return { claimed: drops.filter((d) => d.status === 'claimed').length, total: drops.length };
}

/** Every drop claimed (a campaign with no drops read is not complete). */
export function isComplete(campaign) {
  const { claimed, total } = claimProgress(campaign);
  return total > 0 && claimed === total;
}

/**
 * The campaign without its sub drops (Hide Sub Drops), or null when every drop it has is a
 * sub drop. A campaign with no drops read yet is kept. Returns the same object when it has
 * no sub drops.
 */
export function withoutSubDrops(campaign) {
  const drops = campaign.drops ?? [];
  const kept = drops.filter((d) => d.dropType !== 'sub');
  if (kept.length === drops.length) return campaign;
  return kept.length ? { ...campaign, drops: kept } : null;
}

/** A drop is ready to claim, or being watched. */
export function needsAttention(campaign) {
  return (campaign.drops ?? []).some((d) => d.status === 'claimable' || d.status === 'in_progress');
}

function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Search: every word of `query` must appear in the campaign's game, name or publisher, or
 * in one of its drops' names, block titles, rewards or channels. Ignores case and accents.
 */
export function matchesSearch(campaign, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold([
    campaign.game, campaign.name, campaign.publisher,
    ...(campaign.drops ?? []).flatMap((d) => [
      d.name, d.groupName, ...(d.rewards ?? []).map((r) => r.name),
      ...(d.channels ?? []).flatMap((c) => [c.login, c.displayName]),
    ]),
  ].join('\n'));
  return words.every((w) => text.includes(w));
}

/**
 * Campaigns grouped by game (matched ignoring case), each group in the input order (by end
 * date), groups ordered by their first campaign, so the game with the soonest expiry leads.
 * @returns {{game: string, imageUrl: string, campaigns: object[]}[]}
 */
export function groupByGame(campaigns) {
  const groups = new Map();
  for (const c of campaigns) {
    const key = fold(c.game).trim();
    let group = groups.get(key);
    if (!group) groups.set(key, group = { game: c.game, imageUrl: c.imageUrl ?? '', campaigns: [] });
    if (!group.imageUrl && c.imageUrl) group.imageUrl = c.imageUrl;
    group.campaigns.push(c);
  }
  return [...groups.values()];
}
