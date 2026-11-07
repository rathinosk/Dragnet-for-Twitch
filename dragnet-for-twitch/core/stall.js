// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Stall detection: Twitch sometimes stops crediting watch time on a
// stream that keeps playing, until the page is reloaded. Every inventory read feeds a small
// progress history (trackProgress); the channel tabs report what they play (updateWatch);
// findStalls compares the two, and planStalls decides what to tell the user and, when
// opted in, which tab to reload. Pure: no chrome.*, so the harness can test it. Times are
// epoch milliseconds.

import { fold } from './gql.js';

/** Stalled after this long without a rise, seen by at least two reads. */
export const STALL_MINUTES = 20;
/** A not-playing spell shorter than this (a reload, buffering) does not break the watch span. */
export const WATCH_GRACE_MS = 2 * 60 * 1000;
/** No report from a tab for longer than this: its watch span starts again. */
export const WATCH_GAP_MS = 3 * 60 * 1000;
/** Auto-reload at most this often per tab. */
export const RELOAD_INTERVAL_MS = 30 * 60 * 1000;

const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);

// A drop that has not started or has ended cannot rise (stored drops can outlive their end
// until the next campaigns scan).
const running = (d, now) => !(Date.parse(d.endAt) <= now) && !(Date.parse(d.startAt) > now);

/**
 * A watch report from a channel tab's content script (a page we do not control), checked:
 * null unless the channel is a valid login.
 * @returns {{channel: string, game: string, gameSlug: string, dropsEnabled: boolean, playing: boolean, offline: boolean}|null}
 */
export function sanitizeWatchReport(value) {
  if (!value || typeof value !== 'object') return null;
  const channel = typeof value.channel === 'string' && /^[a-z0-9_]{2,25}$/.test(value.channel) ? value.channel : '';
  if (!channel) return null;
  return {
    channel,
    game: typeof value.game === 'string' ? value.game.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    gameSlug: typeof value.gameSlug === 'string' && /^[a-z0-9_.~%-]{1,100}$/.test(value.gameSlug) ? value.gameSlug : '',
    dropsEnabled: value.dropsEnabled === true,
    playing: value.playing === true,
    offline: value.offline === true,
  };
}

/**
 * Progress history, from the campaigns as stored after an inventory read: per watch drop in
 * progress, its last value, when it last rose (`since`), how many reads have seen that
 * value (`reads`) and the last read. Stored progress never lowers (core/merge.js), so only
 * "no rise" is tested. Drops no longer in progress are dropped.
 * @param {object|undefined} prev  the stored history
 * @param {object[]} campaigns
 * @param {number} now
 * @returns {Record<string, {percent: number, minutes: number, since: number, reads: number, lastRead: number}>}
 */
export function trackProgress(prev, campaigns, now) {
  const old = prev && typeof prev === 'object' ? prev : {};
  const next = {};
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    for (const d of c.drops ?? []) {
      if (d.status !== 'in_progress' || d.dropType !== 'watch' || !running(d, now)) continue;
      const percent = Number.isFinite(d.progressPercent) ? d.progressPercent : 0;
      const minutes = Number.isFinite(d.progressMinutes) ? d.progressMinutes : 0;
      const p = old[d.id];
      const known = p && time(p.since) && Number.isFinite(p.percent) && Number.isFinite(p.minutes) && Number.isFinite(p.reads);
      next[d.id] = known && percent <= p.percent && minutes <= p.minutes
        ? { percent: p.percent, minutes: p.minutes, since: p.since, reads: p.reads + 1, lastRead: now }
        : { percent, minutes, since: now, reads: 1, lastRead: now };
    }
  }
  return next;
}

/**
 * One channel tab's watch state after a report from it. `goodSince` is when it began
 * playing a drops-enabled stream without a break (null while it is not); a break shorter
 * than WATCH_GRACE_MS is ignored, and a change of channel or a silence longer than
 * WATCH_GAP_MS starts the span again.
 * @param {object|null|undefined} prev
 * @param {{channel: string, game: string, gameSlug: string, dropsEnabled: boolean, playing: boolean}|null} report
 *   null: the tab left the channel page
 * @param {number} now
 * @returns {object|null}
 */
export function updateWatch(prev, report, now) {
  if (!report) return null;
  const good = report.playing === true && report.dropsEnabled === true;
  const same = prev && prev.channel === report.channel && now - prev.seen <= WATCH_GAP_MS;
  let goodSince = same ? time(prev.goodSince) : null;
  let badAt = same ? time(prev.badAt) : null;
  if (good) {
    if (badAt !== null && now - badAt >= WATCH_GRACE_MS) goodSince = null;
    badAt = null;
    goodSince ??= now;
  } else {
    badAt ??= now;
    if (now - badAt >= WATCH_GRACE_MS) goodSince = null;
  }
  return {
    channel: report.channel,
    game: report.game,
    gameSlug: report.gameSlug,
    dropsEnabled: report.dropsEnabled === true,
    playing: report.playing === true,
    offline: report.offline === true,
    goodSince,
    badAt,
    seen: now,
  };
}

/**
 * Each watch tab that plays a drops-enabled stream of a game with drops in progress, and
 * whether it is stalled: every such drop (a drop limited to named channels counts only on
 * those) has gone `minutes` without a rise while the tab played, seen by at least two reads.
 * Twitch may credit one drop at a time, so any of them rising means the stream counts. The
 * tab's game must be known (a drop of another game would never rise there), and campaigns
 * whose game account is not connected are left out.
 * @param {object} track  trackProgress output
 * @param {Record<string, object>} watchTabs  updateWatch output per tab id
 * @param {object[]} campaigns
 * @param {number} now
 * @param {{minutes?: number}} [options]
 * @returns {{tabId: number, channel: string, game: string, gameSlug: string, since: number,
 *   lastRead: number, drops: string[], stalled: boolean}[]}
 */
export function findStalls(track, watchTabs, campaigns, now, { minutes = STALL_MINUTES } = {}) {
  const span = minutes * 60 * 1000;
  const out = [];
  for (const [id, w] of Object.entries(watchTabs ?? {})) {
    const tabId = Number(id);
    if (!w || !Number.isInteger(tabId) || time(w.goodSince) === null || now - w.seen > WATCH_GAP_MS || !w.game) continue;
    const game = fold(w.game);
    const eligible = [];
    let gameSlug = w.gameSlug || '';
    for (const c of Array.isArray(campaigns) ? campaigns : []) {
      if (fold(c.game) !== game || c.connection === 'not_connected') continue;
      for (const d of c.drops ?? []) {
        const t = track?.[d.id];
        if (!t || !time(t.since) || !running(d, now)) continue;
        if (d.channelScope === 'listed' && !(d.channels ?? []).some((ch) => ch.login === w.channel)) continue;
        eligible.push({ id: d.id, t });
        gameSlug ||= c.gameSlug || '';
      }
    }
    if (!eligible.length) continue;
    // No rise between `since` and the last read, so none since the tab began playing either.
    const stalled = eligible.every(({ t }) => t.reads >= 2 && t.lastRead - Math.max(t.since, w.goodSince) >= span);
    out.push({
      tabId,
      channel: w.channel,
      game: w.game,
      gameSlug,
      since: Math.max(...eligible.map(({ t }) => t.since)),
      lastRead: Math.max(...eligible.map(({ t }) => t.lastRead)),
      drops: eligible.map(({ id: dropId }) => dropId),
      stalled,
    });
  }
  return out;
}

/**
 * What to do about stalls. State per tab: the stall it is about (`since`, the latest rise of
 * its drops), auto-reloads made, the last one, whether auto-reload gave up, and whether the
 * give-up banner was dismissed. A rise (a newer `since`), another channel or a closed tab
 * clears it; a tab that stopped playing for a moment (a reload) keeps it. Auto-reload (opt-in)
 * waits RELOAD_INTERVAL_MS between reloads and needs a read `minutes` after the last one
 * showing no rise; after `stallReloadMax` reloads with no rise it gives up. The active tab of
 * the focused window (`protectedTab`) is reloaded only with stallReloadActive.
 * @param {ReturnType<typeof findStalls>} found
 * @param {Record<string, object>|undefined} prevState
 * @param {Record<string, object>} watchTabs
 * @param {{stallReload: boolean, stallReloadActive: boolean, stallReloadMax: number}} settings
 * @param {number} now
 * @param {{protectedTab?: number|null, minutes?: number}} [options]
 * @returns {{state: Record<string, object>, reload: number[], alerts: {tabId: number,
 *   channel: string, game: string, gameSlug: string, reloads: number, gaveUp: boolean}[]}}
 */
export function planStalls(found, prevState, watchTabs, settings, now, { protectedTab = null, minutes = STALL_MINUTES } = {}) {
  const span = minutes * 60 * 1000;
  const byTab = new Map(found.map((f) => [String(f.tabId), f]));
  const state = {};
  for (const [id, s] of Object.entries(prevState ?? {})) {
    const w = watchTabs?.[id];
    const f = byTab.get(id);
    if (!w || w.channel !== s.channel || (f && f.since > s.since)) continue;
    state[id] = { ...s };
  }
  const reload = [];
  const alerts = [];
  for (const [id, f] of byTab) {
    if (!f.stalled) continue;
    const s = state[id] ??= {
      channel: f.channel, since: f.since, reloads: 0, lastReload: 0, gaveUp: false, dismissed: false,
    };
    const evidence = s.lastReload === 0 || f.lastRead - s.lastReload >= span;
    if (settings.stallReload && !s.gaveUp && s.reloads >= settings.stallReloadMax && evidence) s.gaveUp = true;
    if (settings.stallReload && !s.gaveUp && s.reloads < settings.stallReloadMax && evidence
      && now - s.lastReload >= RELOAD_INTERVAL_MS && (f.tabId !== protectedTab || settings.stallReloadActive)) {
      s.reloads++;
      s.lastReload = now;
      reload.push(f.tabId);
    }
  }
  for (const [id, s] of Object.entries(state)) {
    const f = byTab.get(id);
    const stalled = f?.stalled === true;
    if (!stalled && !(s.gaveUp && !s.dismissed)) continue;
    if (s.gaveUp && s.dismissed) continue;
    const w = watchTabs[id];
    alerts.push({
      tabId: Number(id), channel: s.channel, game: f?.game ?? w?.game ?? '', gameSlug: f?.gameSlug ?? w?.gameSlug ?? '', reloads: s.reloads, gaveUp: s.gaveUp,
    });
  }
  return { state, reload, alerts };
}

// A tab that was watching a drops stream and then is not (diagnostics, check streamStuck):
// after a reload Twitch sometimes shows the page without resuming the stream or its drops.
export const STUCK_MINUTES = 5;

/**
 * Why a channel page is not watching a drops stream ('' when it is, or when the channel is
 * simply offline). `state` is what scraper/stream.js reads, null when the page has no player.
 */
export function stuckReason(state) {
  if (!state) return 'no player';
  if (state.offline) return '';
  if (!state.playing) return 'not playing';
  if (!state.dropsEnabled) return 'drops tag missing';
  if (!state.game) return 'game unknown';
  return '';
}

/**
 * One tick of the stuck check. `track` is {since, fired} or null; `wasGood` says this tab
 * showed a good state earlier on this channel (so ordinary non-drops streams never count).
 * Fires once per spell, after `minutes` of a bad state.
 * @returns {{track: {since: number, fired: boolean}|null, fire: boolean}}
 */
export function stuckStep(track, reason, now, wasGood, minutes = STUCK_MINUTES) {
  if (!reason) return { track: null, fire: false };
  const t = { since: track?.since ?? now, fired: track?.fired ?? false };
  const fire = wasGood && !t.fired && now - t.since >= minutes * 60000;
  if (fire) t.fired = true;
  return { track: t, fire };
}
