// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Stall detection (core/stall.js), in the content script on channel pages: what the tab is
// watching. Loaded by content.js while settings.stallDetect is on. Reads only the channel
// name (from the URL), the stream's category link, the Drops Enabled tag, the LIVE / Offline
// labels, and whether the page's video is playing; nothing else from the page or the video.

import { query, queryAll } from './selectors.js';
import { categorySlug } from './normalize.js';

// First path segments that are Twitch's own pages, not channels.
const RESERVED = new Set([
  'directory', 'drops', 'settings', 'videos', 'search', 'downloads', 'subscriptions', 'inventory', 'wallet',
  'friends', 'messages', 'p', 'turbo', 'jobs', 'prime', 'store', 'moderator', 'u', 'popout', 'embed', 'following',
  'login', 'signup', 'payments', 'bits', 'broadcast', 'dashboard', 'creatorcamp',
]);

/** The channel login of a channel page path (`/<login>` only), or ''. */
export function channelOfPath(pathname) {
  const m = /^\/([A-Za-z0-9_]{2,25})\/?$/.exec(pathname ?? '');
  const login = m ? m[1].toLowerCase() : '';
  return login && !RESERVED.has(login) ? login : '';
}

/**
 * Whether the page signals a fresh drop (settings.dropAlert): the new-item dot beside the
 * "Drops & More" button, or an on-site toast about drops. Reads only whether the dot exists
 * and a toast's text. Returns a key that changes when a new signal appears, or '' for none.
 * @param {Document} doc
 */
export function readDropSignal(doc) {
  const keys = [];
  const button = query(doc, 'streamDropsButton');
  const wrapper = button?.parentElement?.parentElement;
  if (wrapper && queryAll(wrapper, 'streamDropsIndicator').elements.length) keys.push('dot');
  const banner = query(doc, 'streamDropBanner');
  if (banner) {
    // The banner's text names the drop, so a different drop is a new signal.
    let box = banner.parentElement;
    for (let i = 0; i < 6 && box && !(box.textContent ?? '').trim(); i++) box = box.parentElement;
    keys.push(`banner:${(box?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  for (const toast of queryAll(doc, 'streamToast').elements) {
    const text = (toast.textContent ?? '').replace(/\s+/g, ' ').trim();
    // English text only: other languages rely on the dot.
    if (/\bdrops?\b|eligible/i.test(text)) keys.push(`toast:${text.slice(0, 120)}`);
  }
  return keys.join('|');
}

/**
 * What this channel page shows, or null when it is not a channel page with a stream.
 * @param {Document} doc
 * @param {string} pathname
 * `offline`: the channel is not streaming (display only; stall detection already needs `playing`).
 * @returns {{channel: string, game: string, gameSlug: string, dropsEnabled: boolean, playing: boolean, offline: boolean}|null}
 */
export function readWatchState(doc, pathname) {
  const channel = channelOfPath(pathname);
  const video = doc.querySelector('video');
  if (!channel || !video) return null;
  const game = query(doc, 'streamGameLink');
  const playing = !video.paused && !video.ended && video.readyState > 2;
  return {
    channel,
    game: (game?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    gameSlug: categorySlug(game?.getAttribute('href') ?? ''),
    dropsEnabled: queryAll(doc, 'streamDropsEnabled').elements.length > 0,
    playing,
    offline: query(doc, 'streamOffline') !== null || (!playing && query(doc, 'streamLive') === null),
  };
}
