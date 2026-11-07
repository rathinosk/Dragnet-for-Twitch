// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Merges a campaigns-page scan into stored campaigns. Pure and idempotent: applying the
// same scan twice gives the same result. Rules:
// - a healthy scan replaces the campaign list: campaigns it does not list disappear;
// - a card holds all of a game's campaigns, so ended drops are dropped one by one, a
//   card's end date is its latest drop end (the header shows the last campaign's end, which
//   need not be the latest), and the card goes when that has passed;
// - a drop's status never moves backwards, and a claimed drop stays even if Twitch stops
//   listing it (while its campaign is still listed);
// - a card whose body was not read (a passive sweep opens only some cards) keeps the stored
//   drops, connection, bodyReadAt and Twitch ids;
// - an unhealthy scan (a required hook missing, no cards) changes nothing.
// Inventory progress and claims are applied on top by inventory.js.

import { statusRank } from './schema.js';

/**
 * True if the warnings mean the page did not parse at all (a required hook missing, no
 * cards, or a page language the scraper has no words for), so stored data must be kept.
 */
export function isFatal(warnings) {
  return warnings.some((w) => w.endsWith(':missing') || w.endsWith(':unsupported') || w === 'campaigns:no-cards');
}

/** Campaigns that have not ended at `now` (a missing end date counts as not ended). */
export function activeCampaigns(campaigns, now) {
  const nowMs = new Date(now).getTime();
  return campaigns.filter((c) => !c.endDate || Date.parse(c.endDate) >= nowMs);
}

/**
 * The campaign without its ended drops (a drop with no end date is kept), its end date
 * widened to the latest drop end. Returns the same object when nothing changes.
 */
export function withoutEndedDrops(campaign, now) {
  const nowMs = new Date(now).getTime();
  const drops = campaign.drops ?? [];
  const live = drops.filter((d) => !d.endAt || Date.parse(d.endAt) >= nowMs);
  const endDate = [campaign.endDate, ...live.map((d) => d.endAt)].filter(Boolean).sort().pop() ?? '';
  if (live.length === drops.length && endDate === (campaign.endDate ?? '')) return campaign;
  return { ...campaign, drops: live, endDate };
}

/**
 * When the next unclaimed drop ends (the campaign end if no drop has a date): what the
 * urgency and the "ending soon" order go by, since one card can hold campaigns that end
 * days apart.
 */
export function nextDeadline(campaign, now) {
  const nowMs = new Date(now).getTime();
  const ends = (campaign.drops ?? [])
    .filter((d) => d.status !== 'claimed' && d.endAt && Date.parse(d.endAt) >= nowMs)
    .map((d) => d.endAt);
  return ends.sort()[0] ?? campaign.endDate ?? '';
}

/**
 * @param {object[]} stored  sanitized stored campaigns
 * @param {{campaigns: object[], warnings: string[]}} scan  sanitized scan
 * @param {Date|number} now
 * @returns {{campaigns: object[], accepted: boolean}}
 */
export function applyCampaignScan(stored, scan, now) {
  if (isFatal(scan.warnings) || !scan.campaigns.length) {
    return { campaigns: stored, accepted: false };
  }
  return { campaigns: mergeCampaigns(stored, scan.campaigns, now), accepted: true };
}

export function mergeCampaigns(stored, scanned, now) {
  const nowIso = new Date(now).toISOString();
  const old = new Map(stored.map((c) => [c.id, c]));
  const seen = new Set();
  const merged = [];
  for (const campaign of scanned) {
    if (seen.has(campaign.id)) continue;
    seen.add(campaign.id);
    merged.push(withoutEndedDrops(mergeCampaign(old.get(campaign.id), campaign, nowIso), now));
  }
  return activeCampaigns(merged, now).sort(byEndDate);
}

function mergeCampaign(old, scan, nowIso) {
  const firstSeen = old?.firstSeen || nowIso;
  if (!scan.bodyParsed && old) {
    return {
      ...scan,
      gameSlug: scan.gameSlug || old.gameSlug,
      detailsURL: old.detailsURL,
      accountLinkURL: old.accountLinkURL,
      connection: old.connection,
      isRewardCampaign: scan.isRewardCampaign || old.isRewardCampaign,
      bodyParsed: old.bodyParsed,
      drops: old.drops,
      ...(old.bodyReadAt ? { bodyReadAt: old.bodyReadAt } : {}),
      ...(old.twitchIds ? { twitchIds: old.twitchIds } : {}),
      ...(old.twitchDropIds ? { twitchDropIds: old.twitchDropIds } : {}),
      firstSeen,
    };
  }
  const oldDrops = new Map((old?.drops ?? []).map((d) => [d.id, d]));
  const drops = scan.drops.map((d) => mergeDrop(oldDrops.get(d.id), d, nowIso));
  const listed = new Set(drops.map((d) => d.id));
  const keptClaimed = (old?.drops ?? []).filter((d) => d.status === 'claimed' && !listed.has(d.id));
  return { ...scan, drops: [...drops, ...keptClaimed], firstSeen };
}

function mergeDrop(old, drop, nowIso) {
  if (!old) return { ...drop, firstSeen: nowIso };
  return {
    ...drop,
    status: statusRank(old.status) > statusRank(drop.status) ? old.status : drop.status,
    progressMinutes: Math.max(old.progressMinutes ?? 0, drop.progressMinutes ?? 0),
    progressPercent: Math.max(old.progressPercent ?? 0, drop.progressPercent ?? 0),
    ...(old.claimedAt || drop.claimedAt ? { claimedAt: old.claimedAt || drop.claimedAt } : {}),
    ...(old.twitchId && !drop.twitchId ? { twitchId: old.twitchId } : {}),
    firstSeen: old.firstSeen || nowIso,
  };
}

/** Campaign order: end date, then game and name. */
export function byEndDate(a, b) {
  return (a.endDate || '9999').localeCompare(b.endDate || '9999')
    || a.game.localeCompare(b.game) || a.name.localeCompare(b.name);
}
