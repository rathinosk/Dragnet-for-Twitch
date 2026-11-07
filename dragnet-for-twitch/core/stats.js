// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// The numbers on the full page's Statistics panel. Pure: no chrome.*, so the test harness can
// call it. The caller prepares two campaign lists (ui/app.js): `all` (not ended) and `shown`
// (those the game filter lets through, finished campaigns included; not the connection and
// Hide filters, which are about what to act on), so the panel can show "shown of all" without
// this file knowing the filter.
// - A stored campaign is a card: Twitch shows one card per game holding all its campaigns. So
//   "campaigns" counts the Twitch campaign ids a card lists (twitchIds, only with Twitch data
//   on) and falls back to one per card, while games are distinct game names. Progress and
//   deadlines are per card (a drop does not say which campaign it belongs to), so the other
//   counts are cards.
// - "Ending within" counts campaigns that still have something to do (not complete) by the
//   time their next unclaimed drop ends (merge.js nextDeadline), cumulative: the 7 day count
//   includes the 24 hour one.
// - Claims come from the claim history, which is pruned at `historyDays` and capped at 1000
//   (inventory.js), so "claimed" only reaches back that far. A claim's time is an estimate
//   ("3 days ago" on Twitch's page), good to its `unit`.

import { TIME_UNITS } from './schema.js';
import { nextDeadline } from './merge.js';
import { gameKey } from './filter.js';
import { isComplete } from './view.js';

/** Longest bar chart (days); a shorter history window shortens it. */
export const CHART_DAYS = 30;

/**
 * Counts for one list of campaigns.
 * @param {object[]} campaigns
 * @param {Date|number} now
 */
export function countCampaigns(campaigns, now) {
  const nowMs = new Date(now).getTime();
  const count = {
    campaigns: campaigns.reduce((n, c) => n + (c.twitchIds?.length || 1), 0),
    games: new Set(campaigns.map((c) => gameKey(c.game))).size,
    campaignsInProgress: 0,
    dropsInProgress: 0,
    dropsClaimable: 0,
    ending24h: 0,
    ending7d: 0,
  };
  for (const c of campaigns) {
    const drops = c.drops ?? [];
    const inProgress = drops.filter((d) => d.status === 'in_progress').length;
    if (inProgress) count.campaignsInProgress++;
    count.dropsInProgress += inProgress;
    count.dropsClaimable += drops.filter((d) => d.status === 'claimable').length;
    if (isComplete(c)) continue;
    const left = Date.parse(nextDeadline(c, nowMs)) - nowMs;
    if (!Number.isFinite(left) || left < 0) continue;
    if (left <= TIME_UNITS.day) count.ending24h++;
    if (left <= 7 * TIME_UNITS.day) count.ending7d++;
  }
  return count;
}

/**
 * Claims in the history: the whole history, the last 7 and 30 days, and per calendar day
 * (local time) for the chart, oldest first, ending today.
 * @param {object[]} claims  sanitized claim history
 * @param {Date|number} now
 * @param {number} historyDays  settings.historyDays; the chart covers at most this many days
 */
export function countClaims(claims, now, historyDays) {
  const nowMs = new Date(now).getTime();
  const times = claims.map((c) => Date.parse(c.claimedAt)).filter(Number.isFinite);
  const since = (days) => times.filter((t) => t >= nowMs - days * TIME_UNITS.day && t <= nowMs).length;

  const today = new Date(nowMs);
  const days = Math.max(1, Math.min(CHART_DAYS, historyDays));
  const perDay = [];
  for (let i = days - 1; i >= 0; i--) {
    // Calendar arithmetic, not 24 h steps, so a clock change does not shift a day's edges.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i + 1);
    perDay.push({
      date: start.toISOString(),
      count: times.filter((t) => t >= start.getTime() && t < end.getTime()).length,
    });
  }
  return {
    total: times.length, last7: since(7), last30: since(30), historyDays, perDay,
  };
}

/**
 * @param {{all: object[], shown: object[], claims: object[], historyDays: number}} input
 * @param {Date|number} now
 */
export function computeStats({
  all, shown, claims, historyDays,
}, now) {
  return {
    all: countCampaigns(all, now),
    shown: countCampaigns(shown, now),
    claims: countClaims(claims, now, historyDays),
  };
}
