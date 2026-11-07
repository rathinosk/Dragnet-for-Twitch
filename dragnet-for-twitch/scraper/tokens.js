// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Page text the scraper recognises, per locale. The scan picks the table from the page's
// <html lang> (useLocale); the parsers read the active table through `T`. Only English has
// been captured so far: a page in another language is reported as unsupported rather than
// parsed with the wrong words (run.js), so stored data is kept. To add a locale, capture
// its snapshots (test/README.md) and add a table here; keys it leaves out fall back to
// English. Matching is case-insensitive on whitespace-collapsed text. DOM notes behind
// these: test/README.md.

export const TOKENS = {
  en: {
    // Section labels (body `strong`s that are not drop titles).
    sectionRewards: ['Rewards'],
    sectionHowToEarn: ['How to Earn the Drop'],
    sectionConnection: ['Connection'],
    sectionProgress: ['Progress & Redemption'],
    // Reward campaigns use their own labels.
    sectionRewardHowToEarn: ['How To Earn The Reward', 'How to Earn & Receive Rewards'],
    sectionOther: ['Summary', 'Watch to open'],
    // Drop-type label under a drop title.
    typeWatch: ['Watch to Redeem'],
    typeSub: ['Subscribe to Redeem'],
    // Connection states.
    connected: ['Connected'],
    connect: ['Connect'],
    closed: ['This campaign has closed.'],
    // Section headings (`h4`) whose cards are reward campaigns.
    rewardSection: /reward/i,
    // "Watch for 1 hour 30 minutes and claim the reward(s) X"
    watchLine: /^Watch for (.+?) and claim the rewards?\b/i,
    // "Purchase 2 new recurring or gift subscriptions and claim the reward X"
    subLine: /^Purchase (\d+) new .*?subscriptions? and claim the rewards?\b/i,
    // Reward campaigns: "Watch 60 minutes of a participating channel ..."
    rewardWatchLine: /^Watch (.+?) of a participating channel\b/i,
    hours: /(\d+)\s*hours?\b/i,
    minutes: /(\d+)\s*minutes?\b/i,
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

    // Inventory page.
    loadMore: ['Load More'],
    claimNow: ['Claim Now', 'Claim'],
    // Image alt prefixes: claimed-history items and earned rewards.
    claimedImageAlt: 'Drop image for ',
    earnedImageAlt: 'Reward image for ',
    // Progress row text: "3% of 1 hour 30 minutes" (the percent is in its own span).
    progressOf: /(\d+(?:\.\d+)?)\s*%\s*of\s+(.+)$/i,
    // Claimed-history times, relative to now: "44 minutes ago", "an hour ago", "yesterday",
    // "last month", "2 months ago". Units are TIME_UNITS keys (core/schema.js).
    relativeAgo: /^(\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i,
    relativeLast: /^(?:last|previous)\s+(week|month|year)$/i,
    relativeYesterday: /^yesterday$/i,
    // Seen live 2026-11-07: an item prints "today" once "N hours ago" no longer fits and
    // before it turns "yesterday", i.e. roughly 18 to 24 hours old.
    relativeToday: /^today$/i,
    relativeNow: /^(?:just now|now|moments? ago)$/i,
  },
};

export const DEFAULT_LOCALE = 'en';

/** The active table (English until useLocale picks another). Same object for every importer. */
export const T = { ...TOKENS[DEFAULT_LOCALE] };

/**
 * The table for a BCP 47 language tag ("en", "en-GB"), by its primary subtag. An empty tag
 * (a page or fixture without `lang`) gets English. Null if the language has no table.
 */
export function tokensFor(lang) {
  const primary = String(lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return TOKENS[DEFAULT_LOCALE];
  return TOKENS[primary] ?? null;
}

/** Makes `lang`'s table the active one. False (and English stays active) if it has none. */
export function useLocale(lang) {
  const table = tokensFor(lang);
  if (table) Object.assign(T, TOKENS[DEFAULT_LOCALE], table);
  return !!table;
}

/** True if `value` matches one of the token strings (case-insensitive, collapsed spaces). */
export function isToken(value, list) {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return list.some((t) => t.toLowerCase() === v);
}
