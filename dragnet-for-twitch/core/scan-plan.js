// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Which campaign cards a scan opens. Pure: no
// chrome.*, so the test harness can call it. Opening a card is the slow part of a scan
// (about a second each, and the user sees the cards open and close), and a card's body
// rarely changes once read, so a passive sweep opens only what it must:
// - new cards (not stored), first, so an interrupted sweep still reads them;
// - stored cards whose body was never read (it timed out, or the sweep was interrupted);
// - cards Twitch data shows have changed (`changed`: a drop the card lacks, core/gql.js
//   changedCards);
// - with the incremental setting, `revisit` more: the cards read longest ago, a
//   not-connected card counting as twice as stale (its connection is the likeliest change).
// A full sync opens every card. Cards whose body is already rendered (the reward cards)
// are read without opening, and ended cards (Twitch lists closed campaigns for a while;
// the merge drops them) are not opened, in either mode. A card's header shows the last
// campaign's end, not always the latest, so a card whose stored drops run later is not ended.

import { activeCampaigns } from './merge.js';

/**
 * @param {{id: string, bodyParsed: boolean, endDate: string}[]} cards  header parses, in page order
 * @param {object[]} stored  stored campaigns ({id, bodyParsed, bodyReadAt, connection})
 * @param {{mode: 'full'|'passive', revisit?: number, changed?: Set<string>, now?: Date|number}} options
 * @returns {number[]} indexes into `cards`, in the order to open them
 */
export function planCampaignCards(cards, stored, {
  mode, revisit = 0, changed = new Set(), now = Date.now(),
}) {
  const known = new Map(stored.map((c) => [c.id, c]));
  const live = new Set(activeCampaigns(cards, now));
  const storedLive = new Set(activeCampaigns(stored, now).map((c) => c.id));
  const unread = cards.map((_, i) => i)
    .filter((i) => !cards[i].bodyParsed && (live.has(cards[i]) || storedLive.has(cards[i].id)));
  if (mode === 'full') return unread;
  const fresh = unread.filter((i) => !known.has(cards[i].id));
  const neverRead = unread.filter((i) => known.has(cards[i].id) && !known.get(cards[i].id).bodyParsed);
  const updated = unread.filter((i) => known.get(cards[i].id)?.bodyParsed && changed.has(cards[i].id));
  const nowMs = new Date(now).getTime();
  const staleness = (c) => {
    const at = Date.parse(c.bodyReadAt ?? '');
    const age = Number.isFinite(at) ? Math.max(0, nowMs - at) : Infinity;
    return c.connection === 'not_connected' ? age * 2 : age;
  };
  const oldest = unread
    .filter((i) => known.get(cards[i].id)?.bodyParsed && !changed.has(cards[i].id))
    .map((i) => ({ i, stale: staleness(known.get(cards[i].id)) }))
    .sort((a, b) => (b.stale > a.stale) - (b.stale < a.stale) || a.i - b.i)
    .slice(0, Math.max(0, revisit))
    .map((x) => x.i);
  return [...fresh, ...neverRead, ...updated, ...oldest];
}
