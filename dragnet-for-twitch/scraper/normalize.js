// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Text, URL, date and id helpers for the parsers. Pure: no chrome.*, no live-page access,
// so the test harness can call them directly. Scraped values are untrusted: everything
// returned here is a plain string or number, and URLs are https only.

import { T } from './tokens.js';
import { TIME_UNITS } from '../core/schema.js';

const TWITCH = 'https://www.twitch.tv/';

/** Whitespace-collapsed textContent (not innerText: parsed documents have no layout). */
export function text(el) {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Like text(), but with a space between text nodes: Twitch renders adjacent elements with no
 * whitespace between them, so textContent runs "2:58 AM EDT" into the next element's
 * "You're earning…" and the zone no longer reads as a word.
 */
export function spacedText(el) {
  if (!el) return '';
  const doc = el.ownerDocument ?? el;
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const parts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Absolute https URL, or '' for anything else (javascript:, data:, http:, garbage). */
export function safeUrl(href, base = TWITCH) {
  if (typeof href !== 'string' || !href.trim()) return '';
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Channel login from a relative channel link ("/someone"), or ''. */
export function channelLogin(href) {
  const m = /^\/([A-Za-z0-9_]{1,25})\/?$/.exec(href ?? '');
  return m ? m[1].toLowerCase() : '';
}

/** Category slug from "/directory/category/<slug>[?…]", or ''. */
export function categorySlug(href) {
  const m = /^(?:https:\/\/www\.twitch\.tv)?\/directory\/category\/([A-Za-z0-9_.~%-]+)/.exec(href ?? '');
  return m ? m[1].toLowerCase() : '';
}

/** "1 hour 30 minutes" -> 90; "2 hours" -> 120; null if no duration is found. */
export function parseDuration(value) {
  const s = String(value ?? '');
  const h = T.hours.exec(s);
  const m = T.minutes.exec(s);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

// Offsets in minutes east of UTC for the abbreviations Twitch prints. Ambiguous ones (IST)
// are left out and fall back to the browser's local zone.
const ZONES = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600, JST: 540, KST: 540, AWST: 480, ACST: 570, ACDT: 630,
  AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};

function zoneOffset(zone) {
  if (!zone) return null;
  if (zone in ZONES) return ZONES[zone];
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

// The date pattern for the active token table, rebuilt when the locale changes.
let dateRe = { weekdays: null, months: null, re: null };
function datePattern() {
  if (dateRe.weekdays !== T.weekdays || dateRe.months !== T.months) {
    const re = new RegExp(
      `(${T.weekdays.join('|')}),\\s*(${T.months.join('|')})\\s+(\\d{1,2}),\\s*(\\d{1,2}):(\\d{2})\\s*(AM|PM)`
      + '(?:\\s+((?:GMT|UTC)[+-]\\d{1,2}(?::?\\d{2})?|[A-Z]{2,5})\\b)?',
      'g',
    );
    dateRe = { weekdays: T.weekdays, months: T.months, re };
  }
  return dateRe.re;
}

/** All year-less dates in a string, as parts. */
function findDates(value) {
  return [...String(value ?? '').matchAll(datePattern())].map((m) => {
    const hour12 = Number(m[4]) % 12;
    const lower = (list, s) => list.findIndex((t) => t.toLowerCase() === s.toLowerCase());
    return {
      weekday: lower(T.weekdays, m[1]),
      month: lower(T.months, m[2]),
      day: Number(m[3]),
      hour: hour12 + (m[6].toUpperCase() === 'PM' ? 12 : 0),
      minute: Number(m[5]),
      zone: m[7]?.toUpperCase() ?? '',
    };
  });
}

/**
 * The start and end of a printed date range as wall-clock keys (month, day, time; no zone),
 * or null. For comparing two printings of the same range: a range printed with one zone
 * after it ("... 4:00 AM - ... 2:59 AM EST") does not say the start's zone, which differs
 * when the range crosses a daylight saving change.
 * @returns {{start: string, end: string}|null}
 */
export function dateRangeKeys(value) {
  const [a, b] = findDates(value);
  if (!a || !b) return null;
  const key = (p) => `${p.month}-${p.day}-${p.hour}-${p.minute}`;
  return { start: key(a), end: key(b) };
}

function instant(p, year, offset) {
  if (offset === null) return new Date(year, p.month, p.day, p.hour, p.minute).getTime();
  return Date.UTC(year, p.month, p.day, p.hour, p.minute) - offset * 60000;
}

function weekdayFits(p, year) {
  return new Date(Date.UTC(year, p.month, p.day)).getUTCDay() === p.weekday;
}

// The years among `years` whose calendar puts the date on its printed weekday; all of them
// if none does (a typo or locale mismatch should not lose the date).
function yearsFor(p, years) {
  const fit = years.filter((y) => weekdayFits(p, y));
  return fit.length ? fit : years;
}

/**
 * Parses "Sat, Sep 5, 12:30 PM - Sat, Oct 3, 12:29 PM EDT" into ISO strings. The page prints
 * no year: candidates around `now` are filtered by the printed weekday, then the range
 * nearest to `now` (ideally containing it) wins. A date without a zone borrows the other
 * date's zone; with none at all, the browser's local zone is used.
 * @param {string} value
 * @param {Date|number} now
 * @returns {{start: string, end: string}} '' for a missing side
 */
export function parseDateRange(value, now) {
  const [a, b] = findDates(value);
  if (!a) return { start: '', end: '' };
  const nowMs = new Date(now).getTime();
  const y = new Date(nowMs).getUTCFullYear();
  if (!b) {
    const off = zoneOffset(a.zone);
    const best = nearest(yearsFor(a, [y - 1, y, y + 1]).map((yr) => instant(a, yr, off)), nowMs);
    return { start: new Date(best).toISOString(), end: '' };
  }
  const offA = zoneOffset(a.zone || b.zone);
  const offB = zoneOffset(b.zone || a.zone);
  let best = null;
  for (const ya of yearsFor(a, [y - 1, y, y + 1])) {
    for (const yb of yearsFor(b, [ya, ya + 1])) {
      const s = instant(a, ya, offA);
      const e = instant(b, yb, offB);
      if (e < s) continue;
      const score = nowMs < s ? s - nowMs : nowMs > e ? nowMs - e : 0;
      if (!best || score < best.score) best = { s, e, score };
    }
  }
  if (!best) return { start: '', end: '' };
  return { start: new Date(best.s).toISOString(), end: new Date(best.e).toISOString() };
}

function nearest(values, target) {
  return values.reduce((x, v) => (Math.abs(v - target) < Math.abs(x - target) ? v : x));
}

/**
 * Parses a claimed-history time such as "44 minutes ago", "an hour ago", "yesterday",
 * "last month" or "2 months ago".
 * @returns {{ageMs: number, unit: string}|null}  nominal age and its unit (the precision),
 *   or null if the text is not a relative time
 */
export function parseRelativeTime(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (T.relativeNow.test(s)) return { ageMs: 0, unit: 'second' };
  if (T.relativeYesterday.test(s)) return { ageMs: TIME_UNITS.day, unit: 'day' };
  // Nominal 20 hours so it sorts after "17 hours ago" and before "yesterday"; the day unit
  // records that the time is imprecise.
  if (T.relativeToday.test(s)) return { ageMs: 20 * 3600000, unit: 'day' };
  const last = T.relativeLast.exec(s);
  if (last) {
    const unit = last[1].toLowerCase();
    return { ageMs: TIME_UNITS[unit], unit };
  }
  const ago = T.relativeAgo.exec(s);
  if (!ago) return null;
  const unit = ago[2].toLowerCase();
  const n = /^\d+$/.test(ago[1]) ? Number(ago[1]) : 1;
  return { ageMs: n * TIME_UNITS[unit], unit };
}

/**
 * Stable 64-bit id (16 hex chars) from string parts: an FNV-1a pass plus a second pass
 * with a different offset and multiplier. Not cryptographic; only needs to be identical
 * across scans.
 */
export function stableId(...parts) {
  const input = parts.map((p) => String(p ?? '')).join('\u001f');
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
