// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Every DOM hook Dragnet uses lives here, so a Twitch layout change is a one-file fix.
// Each hook lists CSS selectors in order of preference; the first one that matches wins.
// Prefer semantic hooks (roles, aria-*, data-a-target, data-test-selector, href patterns).
// Never select on hashed styled-components classes (Layout-sc-…, CoreText-sc-…).
// DOM notes behind these choices: test/README.md.

import { T, isToken } from './tokens.js';
import { dateRangeKeys } from './normalize.js';

/**
 * @typedef {object} Hook
 * @property {'campaigns'|'inventory'|'stream'|'any'} page  page the hook belongs to
 * @property {boolean} required  true if a working page always has at least one match
 * @property {string[]} css  selectors, most preferred first
 */

/** @type {Record<string, Hook>} */
export const HOOKS = {
  // "Inventory" / "All Campaigns" / "Social Media Badge" tabs: proves the drops UI rendered.
  dropsTab: {
    page: 'any',
    required: true,
    css: ['a[role="tab"][aria-selected]', '[role="tablist"] [role="tab"]'],
  },
  // Section titles ("Open Drop Campaigns", ...). Cards are siblings that follow them, not children.
  campaignSection: {
    page: 'campaigns',
    required: true,
    css: ['main h4', 'h4'],
  },
  // The expand button inside each campaign card header.
  campaignCardButton: {
    page: 'campaigns',
    required: true,
    css: [
      '.accordion-header[role="heading"] > button[aria-expanded]',
      '[role="heading"][aria-level="3"] > button[aria-expanded]',
    ],
  },
  // Inventory section titles ("Drops", "Rewards"): proves the inventory content rendered.
  inventorySection: {
    page: 'inventory',
    required: true,
    css: ['main h4', 'h4'],
  },
  // Drop progress bars on the inventory page (none when nothing is in progress).
  inventoryProgressBar: {
    page: 'inventory',
    required: false,
    css: ['[role="progressbar"][aria-valuenow]'],
  },
  // Heading link of an in-progress campaign block (its text is a campaign or drop-block name).
  inventoryCampaignLink: {
    page: 'inventory',
    required: false,
    css: [
      'a[href^="/drops/campaigns?dropID="]',
      'img[data-test-selector="DropsCampaignInProgressDescription-game-card-image"]',
    ],
  },
  // One element per claimed-history item: its image (alt "Drop image for X"), else the
  // disabled "Claimed" button (badge and emote items have none, so the fallback misses them).
  inventoryClaimedItem: {
    page: 'inventory',
    required: false,
    css: ['img[alt^="Drop image for "]', 'button[aria-label="Awarded Drop Connect Button"]'],
  },
  // Earned rewards in the "Rewards" section (alt "Reward image for X").
  inventoryEarnedItem: {
    page: 'inventory',
    required: false,
    css: ['img[alt^="Reward image for "]'],
  },

  // Channel (stream) pages, for stall detection and the stream diagnostics. Not
  // part of any scan's self-check. Confirmed live 2026-10-06 unless marked.
  // The Drops Enabled tag under the stream title.
  streamDropsEnabled: {
    page: 'stream',
    required: false,
    css: ['a[data-a-target="DropsEnabled"]', 'a[href="/directory/all/tags/DropsEnabled"]'],
  },
  // The stream's category link (href /directory/category/<slug>). During a Stream Together
  // (Guest Star) session Twitch puts the same data-a-target, first, on a "Streaming Together"
  // link to the guest-star dashboard (seen live 2026-10-07), so the href must be a category.
  streamGameLink: {
    page: 'stream',
    required: false,
    css: [
      'a[data-a-target="stream-game-link"][href*="/directory/category/"]',
      'section[aria-label="Stream Information"] a[href^="/directory/category/"]',
    ],
  },
  // The LIVE label beside the channel name; also on a paused live stream.
  streamLive: {
    page: 'stream',
    required: false,
    css: ['.tw-channel-status-text-indicator'],
  },
  // The "Offline" label and the past-broadcast carousel of an offline channel's home. Twitch
  // also shows a third offline layout (black player, "Most Recent Videos") with neither, so
  // stream.js falls back to "no LIVE label and not playing".
  streamOffline: {
    page: 'stream',
    required: false,
    css: ['.channel-status-info--offline', '[data-a-target="home-offline-carousel"]'],
  },
  // The on-site notification toasts, in the top nav (each toast's message is a span[title]).
  streamToast: {
    page: 'stream',
    required: false,
    css: ['[data-test-selector="onsite-notification-toast__mouse-enter-detector"]'],
  },
  // The "Drops & More" button in the chat input bar, the likeliest home of a claim prompt.
  streamDropsButton: {
    page: 'stream',
    required: false,
    css: ['button[data-a-target="drops-button"]'],
  },
  // The claim banner at the top of the chat ("Claim <drop>", game, a Claim button; seen with a
  // finished, unclaimed drop, 2026-11-07). Dragnet never clicks it; its appearance is only a
  // reason to check the inventory (readDropSignal). The English alt and aria-label are the
  // only hooks it has; the other signals cover other languages.
  streamDropBanner: {
    page: 'stream',
    required: false,
    css: ['img[alt="Drop icon"]', 'button[aria-label="Dismiss This Message"]'],
  },
  // The new-item dot Twitch draws beside that button when a drop needs attention (present
  // with a finished, unclaimed drop, 2026-11-07). HACK: it has no semantic hook, so this
  // matches the stable part of its hashed class names; readDropSignal only accepts it next to
  // the Drops & More button. Proper fix: a data-a-target or role, if Twitch adds one.
  streamDropsIndicator: {
    page: 'stream',
    required: false,
    css: ['[class*="ScNewItemIndicator"]', '[class*="indicatorPosition"]'],
  },
};

/**
 * Guessed hooks of an on-stream claim control (HaiNick/twitch-autoclaim; never seen by
 * Dragnet). The stream diagnostics save anything matching them (diag/watch.js).
 */
export const STREAM_CLAIM_GUESSES = Object.freeze([
  '[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]',
  'button[data-a-target="drops-claim-button"]',
  '[aria-label*="claim drop" i]',
]);

/**
 * First button whose text is one of `tokens` (for buttons with no semantic hook, such as
 * "Load More"), or null.
 */
export function buttonByText(root, tokens) {
  return [...root.querySelectorAll('button')].find((b) => isToken(b.textContent, tokens)) ?? null;
}

/**
 * The outermost ancestor of `el` (below `stop`) that contains no other element matched by
 * `selector` and no heading: the item wrapper of one entry in a list of similar entries
 * (the heading check stops a list of one at its section).
 */
export function itemRoot(el, selector, stop = null) {
  let root = el;
  for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
    if (p.querySelectorAll(selector).length > 1 || p.querySelector('h1, h2, h3, h4, h5, h6')) break;
    root = p;
  }
  return root;
}

// Structural hooks for a campaign card, relative to its expand button. The card root has two
// children: the header (role=heading, holds the button) and the body (empty while collapsed).

/** The card header that holds an expand button. */
export function cardHeader(button) {
  return button.closest('[role="heading"]') ?? button.parentElement;
}

/** The card body (next sibling of the header), or null. */
export function cardBody(button) {
  return cardHeader(button)?.nextElementSibling ?? null;
}

/** True if the card body has rendered content (section labels). */
export function cardBodyReady(button) {
  return !!cardBody(button)?.querySelector('strong');
}

/**
 * True once the card body has rendered past its drop blocks: the campaign-level Connection
 * or Progress & Redemption section comes after the last block. A long body (Rust has 17
 * blocks) mounts in stages, so the first label alone does not mean the body is complete.
 * A card holding several campaigns has those sections once per campaign, so the first
 * campaign alone would pass: the header shows the first campaign's start and the last one's
 * end (seen live on every card, 2026-10-06), so the blocks' dates must reach both. They are
 * compared as printed, without zones: the header gives one zone for both ends, wrong for
 * its start when the card crosses a daylight saving change (Overwatch, EDT to EST). A body
 * with no dated block (a reward campaign's summary) goes by the sections only.
 */
export function cardBodyComplete(button) {
  const body = cardBody(button);
  const labels = [...(body?.querySelectorAll('strong') ?? [])].filter((s) => !s.closest('li'));
  if (!labels.some((s) => isToken(s.textContent, T.sectionProgress) || isToken(s.textContent, T.sectionConnection))) return false;
  const header = dateRangeKeys(button.textContent);
  const ranges = [...body.querySelectorAll('p')].map((p) => dateRangeKeys(p.textContent)).filter(Boolean);
  if (!header || !ranges.length) return true;
  return ranges.some((r) => r.start === header.start) && ranges.some((r) => r.end === header.end);
}

/**
 * All elements matching a hook, using the first selector that matches anything.
 * @param {ParentNode} root
 * @param {string} name  key of HOOKS
 * @returns {{elements: Element[], fallback: number}}  fallback is the index of the selector
 *   used (0 = preferred), or -1 when nothing matched
 */
export function queryAll(root, name) {
  const hook = HOOKS[name];
  if (!hook) throw new Error(`Unknown hook: ${name}`);
  for (let i = 0; i < hook.css.length; i++) {
    const elements = [...root.querySelectorAll(hook.css[i])];
    if (elements.length) return { elements, fallback: i };
  }
  return { elements: [], fallback: -1 };
}

/** First element matching a hook, or null. */
export function query(root, name) {
  return queryAll(root, name).elements[0] ?? null;
}

/**
 * Checks the hooks for a page. A required hook with no match means the layout changed and
 * stored data must be kept; a hook matched only by a fallback still works but needs a look.
 * @param {ParentNode} root
 * @param {'campaigns'|'inventory'} page
 * @returns {string[]} warnings, empty when healthy
 */
export function selfCheck(root, page) {
  const warnings = [];
  for (const [name, hook] of Object.entries(HOOKS)) {
    if (hook.page !== page && hook.page !== 'any') continue;
    const { fallback } = queryAll(root, name);
    if (fallback === -1 && hook.required) warnings.push(`selector:${name}:missing`);
    else if (fallback > 0) warnings.push(`selector:${name}:fallback${fallback}`);
  }
  return warnings;
}
