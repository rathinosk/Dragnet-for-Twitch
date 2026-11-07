// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Parser for /drops/inventory: in-progress drops (progress bars), the claimed history and
// earned rewards. Uses textContent, not innerText, so it also runs on a DOMParser document
// in the test harness. The live scan (run.js) first clicks "Load More" until the history
// is old enough. DOM notes: test/README.md.
//
// - In progress: one block per campaign, headed by a link to /drops/campaigns?dropID=…
//   whose text is a campaign or drop-block name, then "End Date:" and one row per drop:
//   reward image(s), reward name `p`, a progress bar (aria-valuenow, percent) and a text
//   such as "3% of 1 hour 30 minutes" or "20/20m (Day 2)".
// - Claimed: one item per claimed reward: image (alt "Drop image for X"), a relative time
//   ("44 minutes ago", "last month"), a count, the name, and a "Claimed" button, a
//   "Connect" button or nothing. No absolute dates.
// - Rewards: earned reward-campaign rewards (alt "Reward image for X"), name and type.

import { HOOKS, queryAll, selfCheck, buttonByText, itemRoot } from './selectors.js';
import { T } from './tokens.js';
import { text, spacedText, safeUrl, parseDuration, parseDateRange, parseRelativeTime, stableId } from './normalize.js';
import { sanitizeInventory } from '../core/schema.js';

const GAME_CARD = '[data-test-selector="DropsCampaignInProgressDescription-game-card-image"]';

/**
 * @param {Document|Element} root
 * @param {{now?: Date|number}} [options]
 * @returns {{data: {progress: object[], claims: object[], earned: object[], oldestAgeMs: number,
 *   hasLoadMore: boolean}, warnings: string[]}}
 */
export function parseInventoryPage(root, { now = Date.now() } = {}) {
  const warnings = selfCheck(root, 'inventory');
  const nowMs = new Date(now).getTime();
  const progress = parseProgress(root, nowMs, warnings);
  const { claims, oldestAgeMs, missingTime } = parseClaims(root, nowMs);
  if (missingTime) warnings.push(`inventory:claim-without-time:${missingTime}`);
  const data = sanitizeInventory({ progress, claims, earned: parseEarned(root) });
  return { data: { ...data, oldestAgeMs, hasLoadMore: !!loadMoreButton(root) }, warnings };
}

export function loadMoreButton(root) {
  return buttonByText(root, T.loadMore);
}

// In progress ----------------------------------------------------------------------------

function parseProgress(root, nowMs, warnings) {
  const links = queryAll(root, 'inventoryCampaignLink');
  const barCss = HOOKS.inventoryProgressBar.css[0];
  const blocks = links.elements.map((link) => {
    // The block is the nearest ancestor that also holds the drop rows.
    let block = link.parentElement;
    while (block && block !== root && !block.querySelector(barCss) && !claimButtons(block).length) {
      block = block.parentElement;
    }
    return { link, block };
  }).filter((b) => b.block && b.block !== root);

  const bars = queryAll(root, 'inventoryProgressBar').elements;
  const out = [];
  const seenBars = new Set();
  for (const { link, block } of blocks) {
    const header = link.tagName === 'A' ? link : null;
    const rows = [];
    const rowRoots = [];
    for (const bar of bars.filter((b) => block.contains(b))) {
      seenBars.add(bar);
      const row = itemRoot(bar, barCss, block);
      rowRoots.push(row);
      rows.push(parseRow(row, bar));
    }
    // Live, the bar stays beside "Claim Now"; a button in a row without a bar is still read.
    for (const button of claimButtons(block)) {
      if (rowRoots.some((r) => r.contains(button))) continue;
      const row = rowAround(button, block);
      if (row) rows.push({ ...parseRow(row, null), percent: 100, claimable: true });
    }
    const dates = parseDateRange(spacedText(block.firstElementChild ?? block), nowMs);
    out.push({ title: header ? text(header) : '', endDate: dates.start, rows });
  }
  const orphans = bars.filter((b) => !seenBars.has(b)).length;
  if (orphans) warnings.push(`inventory:progress-without-campaign:${orphans}`);
  return out;
}

/** "Claim Now" buttons of claimable drops (auto-claim; markup in test/README.md, DOM notes). */
export function claimNowButtons(root) {
  return claimButtons(root.querySelector?.('main') ?? root);
}

function claimButtons(el) {
  return [...el.querySelectorAll('button')].filter((b) => T.claimNow.some(
    (t) => text(b).toLowerCase() === t.toLowerCase(),
  ));
}

/**
 * The claims a "Claim Now" button makes, dated `nowMs`, one per reward of its row and keyed
 * like the claimed history's (parseClaims). Read before the click: after a claim Twitch only
 * removes the button, and the history lists the reward only once the page is reloaded.
 * @returns {object[]}
 */
export function claimsForButton(button, nowMs) {
  const barCss = HOOKS.inventoryProgressBar.css[0];
  const stop = button.ownerDocument?.querySelector('main') ?? null;
  let row = null;
  let bar = null;
  // The row is the nearest ancestor holding one bar; one holding more is the whole block.
  for (let p = button.parentElement; p && p !== stop; p = p.parentElement) {
    const bars = p.querySelectorAll(barCss);
    if (bars.length === 1) [row, bar] = [p, bars[0]];
    if (bars.length) break;
    if (p.querySelector('h1, h2, h3, h4, h5, h6')) break;
  }
  row ??= rowAround(button, stop);
  if (!row) return [];
  const claimedAt = new Date(nowMs).toISOString();
  return parseRow(row, bar).rewards
    .filter((r) => r.name || r.imageUrl)
    .map((r) => ({ id: stableId('claim', r.name, r.imageUrl), name: r.name, imageUrl: r.imageUrl, claimedAt, unit: 'minute' }));
}

// Nearest ancestor of a claim button that holds a reward image (not the game box art).
function rowAround(el, stop) {
  for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
    if ([...p.querySelectorAll('img')].some((img) => !img.matches(GAME_CARD))) return p;
  }
  return null;
}

function before(a, b) {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// One drop row: rewards are the images and `p` names before the bar; the progress text is
// the `p` after it.
function parseRow(row, bar) {
  const isBefore = (el) => !bar || before(el, bar);
  const images = [...row.querySelectorAll('img')].filter((img) => !img.matches(GAME_CARD) && isBefore(img));
  const names = [...row.querySelectorAll('p')].filter(isBefore).map(text).filter(Boolean);
  const rewards = Array.from({ length: Math.max(images.length, names.length) }, (_, i) => ({
    name: names[i] ?? '',
    imageUrl: safeUrl(images[i]?.getAttribute('src')),
  }));
  const after = bar ? [...row.querySelectorAll('p')].filter((p) => before(bar, p)).map(text).join(' ') : '';
  const of = T.progressOf.exec(after);
  const valueNow = Number.parseFloat(bar?.getAttribute('aria-valuenow') ?? '');
  return {
    rewards,
    percent: Number.isFinite(valueNow) ? valueNow : of ? Number(of[1]) : 0,
    requiredMinutes: of ? parseDuration(of[2]) : null,
    claimable: claimButtons(row).length > 0,
  };
}

// Claimed history -------------------------------------------------------------------------

/** Number of claimed-history items on the page (cheap: no parsing). */
export function countClaims(root) {
  return queryAll(root, 'inventoryClaimedItem').elements.length;
}

/**
 * Claimed-history items, newest first, with ages estimated from their relative times.
 * Also used by the live scan to decide whether to load more.
 * @returns {{claims: object[], oldestAgeMs: number, missingTime: number, count: number}}
 */
export function parseClaims(root, nowMs) {
  const { elements, fallback } = queryAll(root, 'inventoryClaimedItem');
  const css = fallback >= 0 ? HOOKS.inventoryClaimedItem.css[fallback] : '';
  const claims = [];
  const ids = new Set();
  let oldestAgeMs = 0;
  let missingTime = 0;
  for (const el of elements) {
    const item = itemRoot(el, css);
    const img = el.tagName === 'IMG' ? el : item.querySelector('img');
    const texts = [...item.querySelectorAll('p')].map(text).filter(Boolean);
    const time = texts.map(parseRelativeTime).find(Boolean);
    if (!time) {
      missingTime++;
      continue;
    }
    const alt = img?.getAttribute('alt') ?? '';
    const name = alt.startsWith(T.claimedImageAlt)
      ? alt.slice(T.claimedImageAlt.length).trim()
      : texts.filter((t) => !parseRelativeTime(t)).at(-1) ?? '';
    const imageUrl = safeUrl(img?.getAttribute('src'));
    oldestAgeMs = Math.max(oldestAgeMs, time.ageMs);
    const id = stableId('claim', name, imageUrl);
    if (ids.has(id)) continue; // the same reward claimed again: keep the newest
    ids.add(id);
    claims.push({ id, name, imageUrl, claimedAt: new Date(nowMs - time.ageMs).toISOString(), unit: time.unit });
  }
  return { claims, oldestAgeMs, missingTime, count: elements.length };
}

// Earned rewards --------------------------------------------------------------------------

function parseEarned(root) {
  const { elements } = queryAll(root, 'inventoryEarnedItem');
  const css = HOOKS.inventoryEarnedItem.css[0];
  return elements.map((img) => {
    const item = itemRoot(img, css);
    const alt = img.getAttribute('alt') ?? '';
    return {
      name: alt.startsWith(T.earnedImageAlt) ? alt.slice(T.earnedImageAlt.length).trim() : text(item.querySelector('p')),
      imageUrl: safeUrl(img.getAttribute('src')),
      type: text(item.querySelector('span')),
    };
  });
}
