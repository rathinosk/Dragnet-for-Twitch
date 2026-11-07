// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// View filters for the campaign lists. Pure: no chrome.*,
// so the test harness can call it. Filters only change what the lists show; scans still
// read and store every campaign, so changing a filter needs no rescan.
// - Game filter: `hide` hides the listed games; `include` shows only them, and an empty
//   include list hides nothing (an empty list would otherwise blank the view). Matched by
//   display name, ignoring case.
// - Connection filter: `hide_not_connected` hides campaigns whose game account is not
//   connected (their drops cannot be redeemed); `only_not_connected` shows only those, as a
//   to-do list of accounts to link. A campaign whose body was never read (connection '')
//   counts as not known to be unconnected.

/** Lower-cased game key used for matching. */
export function gameKey(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @param {object[]} campaigns
 * @param {{gameFilter?: {mode: string, games: string[]}, connectionFilter?: string}} filters
 *   sanitized (core/schema.js)
 * @returns {{shown: object[], hidden: number}}
 */
export function filterCampaigns(campaigns, { gameFilter, connectionFilter = 'all' } = {}) {
  const games = new Set((gameFilter?.games ?? []).map(gameKey));
  const include = gameFilter?.mode === 'include';
  const shown = campaigns.filter((c) => {
    if (games.size && games.has(gameKey(c.game)) !== include) return false;
    if (connectionFilter === 'hide_not_connected') return c.connection !== 'not_connected';
    if (connectionFilter === 'only_not_connected') return c.connection === 'not_connected';
    return true;
  });
  return { shown, hidden: campaigns.length - shown.length };
}

/**
 * Game names for the filter list: every game among `campaigns` plus every game already in
 * the filter (so one whose campaigns ended can still be removed), one entry per game
 * ignoring case, sorted.
 */
export function filterGameNames(campaigns, gameFilter) {
  const byKey = new Map();
  for (const name of [...(gameFilter?.games ?? []), ...campaigns.map((c) => c.game)]) {
    const key = gameKey(name);
    if (key && !byKey.has(key)) byKey.set(key, String(name).trim());
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
