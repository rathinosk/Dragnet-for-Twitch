// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Content-script entry (loaded by content.js on every drops-page visit, including in-app
// navigation): detect the page, wait for it to render, ask the background how to scan,
// scrape, and report the result and its health warnings to the background.
//
// Two scan modes. A visit does a passive sweep:
// on the campaigns page it opens only new and never-read cards (plus, with the incremental
// setting, a few read longest ago); on the inventory it stops loading claimed history once
// it reaches a claim already stored. Full sync (the popup button, in the background's own
// tab) opens every card and reads the history back to the history setting.

import { query, queryAll, selfCheck, cardHeader, cardBodyReady, cardBodyComplete } from './selectors.js';
import { waitFor, expand, settle } from './walker.js';
import { parseCampaignCard, cardOccurrences, sectionOf, summarize } from './campaigns-page.js';
import {
  parseInventoryPage, parseClaims, countClaims, loadMoreButton, claimNowButtons, claimsForButton,
} from './inventory-page.js';
import {
  KEYS, SETTINGS, TIME_UNITS, DIAG_CHECKS_KEY, sanitizeSettings, sanitizeDiagChecks,
} from '../core/schema.js';
import { planCampaignCards } from '../core/scan-plan.js';
import { isKnownClaim } from '../core/inventory.js';
import {
  parseDashboard, parseCampaignDetails, parseInventory, mergeProgress, mergeExactClaims, changedCards,
} from '../core/gql.js';
import { collecting, collected } from './gql.js';
import { useLocale } from './tokens.js';

// Badge texts in the language picked in the settings, sent with each scan reply by the
// background (null: Chrome's own pick, through chrome.i18n).
let chosenMessages = null;

/**
 * Extension message (_locales) with {name} placeholders filled from `values`; the key
 * itself where chrome.i18n is not available (the test harness). ui/i18n.js is the full
 * version; this one avoids exposing ui/ to the page.
 */
function msg(key, values = {}) {
  let message = typeof chosenMessages?.[key] === 'string' ? chosenMessages[key] : '';
  try {
    message ||= chrome.i18n.getMessage(key);
  } catch {
    // not an extension context
  }
  return (message || key).replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(values, name) ? String(values[name]) : m));
}

/** @returns {'campaigns'|'inventory'|null} */
export function detectPage(pathname) {
  if (/^\/drops\/campaigns\/?$/.test(pathname)) return 'campaigns';
  if (/^\/drops\/inventory\/?$/.test(pathname)) return 'inventory';
  return null;
}

let running = false;
let rerun = false;

/** True while a scan is under way (diag/capture.js waits for it). */
export const scanRunning = () => running;

// Diagnostics (diag/README.md), while the setting is on: save markup the scraper does not
// recognize yet ('record'), start the live watch of an open inventory tab if it is
// switched on ('live'), or, with Twitch data also on, save the GQL responses ('gql'). Each
// has its own check on the diagnostics page (diagChecks); the live watch reads its own, so
// it can start without a reload when switched on later.
async function diagWatch(page, step = 'record') {
  try {
    const { [KEYS.settings]: stored, [DIAG_CHECKS_KEY]: storedChecks } = await chrome.storage.sync.get([KEYS.settings, DIAG_CHECKS_KEY]);
    const settings = sanitizeSettings(stored);
    const checks = sanitizeDiagChecks(storedChecks);
    if (!settings.diagnostics || (step === 'gql' && !(settings.twitchApi && checks.gqlDrops))) return;
    if (step === 'record' && !checks.dropsMarkup) return;
    const diag = await import('../diag/watch.js');
    if (step === 'live') await diag.startLiveWatch(page);
    else if (step === 'gql') await diag.recordGql(page);
    else await diag.recordAnomalies(document, page);
  } catch (err) {
    console.warn('[Dragnet] diagnostics', err);
  }
}

// Claims the user made by clicking "Claim Now" on an open inventory page, for the next
// scan to report: Twitch removes the button but adds the reward to the claimed history
// only on a reload.
const userClaims = [];
let watchingClicks = false;

function watchClaimClicks() {
  if (watchingClicks) return;
  watchingClicks = true;
  document.addEventListener('click', async (event) => {
    // Untrusted clicks are auto-claim's own (claimDrops records those).
    if (!event.isTrusted || detectPage(location.pathname) !== 'inventory') return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || !claimNowButtons(document).includes(button)) return;
    const claims = claimsForButton(button, Date.now());
    const gone = () => button.disabled || !claimNowButtons(document).includes(button);
    if (!claims.length || !(await waitFor(gone, { timeout: 10000, attributes: true }))) return;
    userClaims.push(...claims);
    run().catch((err) => console.error('[Dragnet]', err));
  }, true);
}

// Auto-claim on an inventory page left open: after a scan with auto-claim on,
// watch the page and scan again (which clicks) when a "Claim Now" appears, in case Twitch
// updates the page in place. A button seen once is not chased again, so one that will not
// go away cannot loop.
let autoClaimOn = false;
let claimObserver = null;
const buttonsSeen = new WeakSet();

function watchForClaimButtons() {
  if (claimObserver) return;
  let pending = 0;
  claimObserver = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      if (!chrome.runtime?.id) {
        claimObserver.disconnect();
        return;
      }
      if (!autoClaimOn || running || detectPage(location.pathname) !== 'inventory') return;
      const fresh = claimNowButtons(document).filter((b) => !buttonsSeen.has(b) && !b.disabled);
      if (!fresh.length) return;
      fresh.forEach((b) => buttonsSeen.add(b));
      run().catch((err) => console.error('[Dragnet]', err));
    }, 1000);
  });
  claimObserver.observe(document.body, { subtree: true, childList: true });
}

export async function run() {
  if (detectPage(location.pathname) === 'inventory') watchClaimClicks();
  if (running) {
    rerun = true; // the current scan aborts when the page changes; run again after it
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await scanCurrentPage();
    } while (rerun);
  } finally {
    running = false;
  }
}

async function scanCurrentPage() {
  const page = detectPage(location.pathname);
  if (!page) return;

  // React renders after document_idle (or after an in-app navigation); wait for a hook
  // that proves the page content exists. On timeout the self-check reports what is missing.
  // The tab bar renders before the content, so wait for content hooks, not the tabs.
  const ready = page === 'campaigns' ? 'campaignCardButton' : 'inventorySection';
  await waitFor(() => query(document, ready));
  if (page === 'inventory') await inventoryLoaded(document);
  if (detectPage(location.pathname) !== page) return;

  // The parsers read page text, so they need the page's language. Without a token table
  // for it, report that instead of parsing: the warning is fatal, so stored data is kept.
  const lang = document.documentElement.lang;
  if (!useLocale(lang)) {
    const tag = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/.test(lang) ? lang : 'unknown';
    const empty = page === 'campaigns' ? { campaigns: [] } : { inventory: {} };
    await chrome.runtime.sendMessage({ type: 'dragnet:scan', page, ...empty, warnings: [`locale:${tag}:unsupported`] });
    return;
  }

  // Before the scan, so a "Claim Now" is saved before auto-claim could click it.
  if (page === 'inventory') await diagWatch(page);

  const reply = await chrome.runtime.sendMessage({ type: 'dragnet:should-scan', page }) ?? {};
  if (!reply.scan) return;
  chosenMessages = reply.messages && typeof reply.messages === 'object' ? reply.messages : null;

  if (page === 'inventory') {
    // Twitch data (settings.twitchApi): exact progress, and the claim history with exact
    // times, which can make "Load More" unnecessary.
    const gql = collecting() ? parseInventory(collected()) : null;
    const madeClaims = userClaims.splice(0);
    autoClaimOn = reply.autoClaim === true;
    // Buttons on the page now are this scan's to click.
    claimNowButtons(document).forEach((b) => buttonsSeen.add(b));
    const result = await scanInventory(document, {
      madeClaims,
      historyDays: reply.historyDays,
      knownClaims: reply.mode === 'full' ? null : reply.knownClaims,
      autoClaim: reply.autoClaim === true,
      coveredAgeMs: gql?.data?.oldestAgeMs ?? 0,
    });
    if (!result) return;
    let gqlSummary = null;
    if (gql) {
      result.warnings.push(...gql.warnings);
      if (gql.data) {
        result.data.progress = mergeProgress(result.data.progress, gql.data.progress);
        result.data.claims = mergeExactClaims(result.data.claims, gql.data.claims);
        gqlSummary = { inventory: true, claims: gql.data.claims.length };
      } else if (!gql.warnings.length) {
        result.warnings.push('gql:inventory:absent');
      }
    }
    // Before the report: a Full sync closes the tab once the inventory scan is stored.
    await diagWatch(page, 'gql');
    await chrome.runtime.sendMessage({
      type: 'dragnet:scan', page, inventory: result.data, warnings: result.warnings, ...(gqlSummary ? { gql: gqlSummary } : {}),
    });
    await diagWatch(page, 'live');
    if (autoClaimOn) watchForClaimButtons();
    return;
  }

  // Twitch data (settings.twitchApi): the dashboard shows which cards gained drops since
  // they were read, and each card opened brings its details.
  const useGql = collecting();
  let changed = new Set();
  let dashboard = null;
  const result = await scanCampaigns(document, {
    select: (cards) => {
      dashboard = useGql ? parseDashboard(collected()).data : null;
      if (dashboard && reply.mode !== 'full') changed = changedCards(cards, reply.known ?? [], dashboard);
      return planCampaignCards(cards, reply.known ?? [], { mode: reply.mode, revisit: reply.revisit, changed });
    },
  });
  let gql = null;
  if (useGql) {
    const items = collected();
    const details = parseCampaignDetails(items);
    const latest = parseDashboard(items);
    result.warnings.push(...details.warnings, ...latest.warnings);
    if (!items.length) result.warnings.push('gql:campaigns:absent');
    gql = { details: details.data, dashboard: latest.data ?? dashboard, changed: changed.size };
  }
  // An interrupted scan (the user left the page) is still reported: every header was read
  // at the start, and cards not opened keep their stored drops (core/merge.js).
  const { campaigns, ...stats } = result.data;
  // Before the report: a Full sync moves the tab on once the campaigns scan is stored.
  await diagWatch(page, 'gql');
  await chrome.runtime.sendMessage({
    type: 'dragnet:scan',
    page,
    campaigns,
    stats: { ...stats, revisit: reply.revisit ?? 0 },
    warnings: result.warnings,
    ...(gql ? { gql } : {}),
  });
  await diagWatch(page);
}

const onCampaignsPage = () => detectPage(location.pathname) === 'campaigns';
const onInventoryPage = () => detectPage(location.pathname) === 'inventory';

/**
 * After the inventory headings appear, the lists fill in from separate requests: wait for
 * any list content (an empty inventory has none, hence the short timeout), then for the
 * page to stop changing.
 */
async function inventoryLoaded(root) {
  const hooks = ['inventoryClaimedItem', 'inventoryProgressBar', 'inventoryEarnedItem'];
  await waitFor(() => hooks.some((h) => query(root, h)) || loadMoreButton(root), { timeout: 5000 });
  await settle(root.querySelector('main') ?? root.body ?? root, { quiet: 500, timeout: 4000 });
}

// Safety stop for the "Load More" loop (each click adds about 20 items).
const MAX_LOAD_MORE = 40;

/**
 * Clicks "Load More" under the claimed history until its oldest item is at least
 * `historyDays` old (Twitch prints "25 days ago", then "last month", "2 months ago"; those
 * count as 30 and 60 days), the button is gone, or no new items arrive; then parses the page.
 * A passive sweep (`knownClaims` given) also stops at the first claim already stored.
 * Twitch may keep the button disabled for a moment after a page of items arrives, and a
 * click then does nothing: wait for it to be enabled, and click once more before giving up.
 * With `autoClaim`, first clicks every "Claim Now" button, so the read sees the result.
 * `coveredAgeMs`: how far back Twitch data's claim history already reaches; no clicks are
 * needed for what it covers. `madeClaims`: claims the user made on this page since the last
 * scan; they and auto-claim's are added to the claims read, since the history on the page
 * does not list them until a reload.
 * @param {Document|Element} [root]
 * @param {{historyDays?: number, knownClaims?: object[]|null, autoClaim?: boolean,
 *   coveredAgeMs?: number, madeClaims?: object[], stillHere?: () => boolean,
 *   loadTimeout?: number}} [options]
 * @returns {Promise<{data: object, warnings: string[]}|null>} null if the user left the page;
 *   data also has `loadMoreClicks`, `reachedKnown` and `claimClicks`
 */
export async function scanInventory(root = document, {
  historyDays = SETTINGS.historyDays.default, knownClaims = null, autoClaim = false,
  coveredAgeMs = 0, madeClaims = [], stillHere = onInventoryPage, loadTimeout = 10000,
} = {}) {
  const limitMs = historyDays * TIME_UNITS.day;
  const known = new Map((Array.isArray(knownClaims) ? knownClaims : []).map((c) => [c.id, c]));
  const warnings = [];
  const badge = progressBadge();
  const enabledButton = () => {
    const b = loadMoreButton(root);
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
  };
  let clicks = 0;
  let reachedKnown = false;
  let claimClicks = 0;
  const made = [...madeClaims];
  try {
    if (autoClaim) {
      badge.show(msg('badgeClaiming'));
      claimClicks = await claimDrops(root, { stillHere, timeout: loadTimeout, warnings, made });
    }
    for (;;) {
      if (!stillHere()) return null;
      const { claims, count, oldestAgeMs } = parseClaims(root, Date.now());
      if (Math.max(oldestAgeMs, coveredAgeMs) >= limitMs || !loadMoreButton(root)) break;
      if (claims.some((c) => isKnownClaim(known, c))) {
        reachedKnown = true;
        break;
      }
      if (clicks >= MAX_LOAD_MORE) {
        warnings.push('inventory:load-more-limit');
        break;
      }
      badge.show(msg('badgeReadingClaims', { count }));
      let grew = false;
      for (let attempt = 0; attempt < 2 && !grew; attempt++) {
        const button = await waitFor(enabledButton, { timeout: loadTimeout, attributes: true });
        if (!button) break;
        button.click();
        clicks++;
        grew = !!(await waitFor(() => countClaims(root) > count || !loadMoreButton(root), { timeout: loadTimeout }));
      }
      if (!grew) {
        warnings.push('inventory:load-more-timeout');
        break;
      }
      await settle(root.querySelector?.('main') ?? root, { quiet: 300, timeout: 3000 });
    }
    if (!stillHere()) return null;
    const result = parseInventoryPage(root, { now: Date.now() });
    const read = new Set(result.data.claims.map((c) => c.id));
    result.data.claims.unshift(...made.filter((c) => !read.has(c.id) && read.add(c.id)));
    result.warnings.push(...warnings);
    Object.assign(result.data, { loadMoreClicks: clicks, reachedKnown, claimClicks });
    return result;
  } finally {
    badge.remove();
  }
}

/**
 * Auto-claim: clicks each "Claim Now" button in turn and waits for it to go (or be
 * disabled). Only reached when the setting is on (and AUTO_CLAIM_AVAILABLE in core/schema.js).
 * Live markup (2026-10-03): the button sits beside the reward image and its row keeps the
 * bar at 100%; its only label is the text "Claim Now". After the click the button goes,
 * but the claimed history lists the reward only after a reload, so each claim made is
 * pushed to `made`.
 * @returns {Promise<number>} buttons clicked
 */
async function claimDrops(root, { stillHere, timeout, warnings, made }) {
  let clicks = 0;
  for (const button of claimNowButtons(root)) {
    if (!stillHere()) break;
    if (!button.isConnected || button.disabled) continue;
    const claims = claimsForButton(button, Date.now());
    button.click();
    clicks++;
    const done = await waitFor(() => button.disabled || !claimNowButtons(root).includes(button), { timeout, attributes: true });
    if (done) made.push(...claims);
    else warnings.push('inventory:claim-timeout');
  }
  if (clicks) await settle(root.querySelector?.('main') ?? root, { quiet: 500, timeout: 4000 });
  return clicks;
}

/**
 * Reads every card header (all are in the DOM at load), then opens the cards `select`
 * picks, in its order (the page is a single-open accordion and bodies mount lazily), reads
 * each, and closes it again if it was closed before. Cards not opened are reported
 * header-only (`bodyParsed: false`, unless their body was already rendered).
 * @param {Document|Element} [root]
 * @param {{stillHere?: () => boolean, select?: (cards: object[]) => number[]}} [options]
 *   stillHere: checked before each card, false stops the scan; select: header-parsed
 *   campaigns in page order -> indexes to open (default: every card not yet read)
 * @returns {Promise<{data: {campaigns: object[], cardsOpened: number, cardsPlanned: number,
 *   interrupted: boolean}, warnings: string[]}>}
 */
export async function scanCampaigns(root = document, { stillHere = onCampaignsPage, select = null } = {}) {
  const buttons = queryAll(root, 'campaignCardButton').elements;
  const sections = queryAll(root, 'campaignSection').elements;
  // Checked now: by the end the user may have left the page.
  const checkWarnings = selfCheck(root, 'campaigns');
  const now = Date.now();
  const occurrences = cardOccurrences(buttons);
  const parse = (i) => parseCampaignCard(buttons[i], {
    now, section: sectionOf(buttons[i], sections), occurrence: occurrences[i],
  });
  const results = buttons.map((_, i) => parse(i));
  const order = select
    ? select(results.map((r) => r.campaign))
    : results.map((_, i) => i).filter((i) => !results[i].campaign.bodyParsed);
  const badge = progressBadge();
  let opened = 0;
  let interrupted = false;
  try {
    for (const [n, i] of order.entries()) {
      const button = buttons[i];
      if (!stillHere() || !button?.isConnected) {
        interrupted = true;
        break;
      }
      badge.show(msg('badgeReadingCampaigns', { n: n + 1, total: order.length }));
      const wasOpen = button.getAttribute('aria-expanded') === 'true';
      // Wait for the whole body, not its first label: blocks mount in stages (see
      // cardBodyComplete), and reading early keeps only the first block or few.
      const isReady = () => cardBodyComplete(button);
      const container = cardHeader(button).parentElement;
      let ok = await expand(button, isReady, { container, quiet: 300 });
      if (!ok && !cardBodyReady(button)) {
        // Unproven whether Twitch needs the card on screen to mount its body; retry once so.
        button.scrollIntoView({ block: 'center' });
        ok = await expand(button, isReady, { container, quiet: 300 });
      }
      const result = parse(i);
      if (!ok && cardBodyReady(button)) {
        // Partial body: keep what was read, but leave the card unread so the next sweep
        // opens it again (the merge keeps stored drops for an unread card).
        result.warnings.push('campaigns:card-body-incomplete');
        result.campaign.bodyParsed = false;
      } else if (!ok) {
        result.warnings.push('campaigns:card-body-timeout');
      }
      results[i] = result;
      opened++;
      if (!wasOpen && button.getAttribute('aria-expanded') === 'true') button.click();
    }
  } finally {
    badge.remove();
  }
  const summary = summarize(root, results, checkWarnings);
  Object.assign(summary.data, { cardsOpened: opened, cardsPlanned: order.length, interrupted });
  return summary;
}

// A small fixed label so the user knows why the cards are opening and closing.
function progressBadge() {
  let el = null;
  return {
    show(message) {
      if (!el) {
        el = document.createElement('div');
        Object.assign(el.style, {
          position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
          padding: '6px 10px', borderRadius: '6px', font: '13px/1.4 system-ui, sans-serif',
          background: '#5b21b6', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.4)',
          pointerEvents: 'none',
        });
        el.setAttribute('role', 'status');
        document.body.append(el);
      }
      el.textContent = message;
    },
    remove() {
      el?.remove();
    },
  };
}
