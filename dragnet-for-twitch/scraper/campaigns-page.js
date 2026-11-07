// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Parser for /drops/campaigns -> Campaign[]. Reads one card at a
// time: the header always, the body when it is rendered (the live scan opens each card in
// turn; see run.js). Uses textContent, not innerText, so it also runs on a DOMParser
// document in the test harness. DOM notes: test/README.md.
//
// A card body is a sequence of sections, each introduced by a `strong` label outside any
// list item. Drop blocks start with a title `strong` (any label that is not a known
// section name) followed by a type label ("Watch to Redeem"), a date line, a Rewards
// section (tiles) and a How to Earn section (channel line, then one line per drop:
// "Watch for 2 hours and claim the reward X"). Campaign-level Connection and Progress &
// Redemption sections follow. The body is walked in document order rather than by
// nesting, because the live page nests a `div` inside a `p`, which an HTML parser
// re-nests differently.

import { queryAll, selfCheck, cardBody } from './selectors.js';
import { T, isToken } from './tokens.js';
import {
  text, safeUrl, channelLogin, categorySlug, parseDuration, parseDateRange, stableId,
} from './normalize.js';
import { sanitizeCampaign } from '../core/schema.js';

/**
 * Parses every card on the page whose body is rendered; header-only cards come back with
 * `bodyParsed: false` (the merge keeps their stored drops).
 * @param {Document|Element} root
 * @param {{now?: Date|number}} [options]
 * @returns {{data: {campaigns: object[]}, warnings: string[]}}
 */
export function parseCampaignsPage(root, { now = Date.now() } = {}) {
  const sections = queryAll(root, 'campaignSection').elements;
  const buttons = queryAll(root, 'campaignCardButton').elements;
  const occurrences = cardOccurrences(buttons);
  const results = buttons.map((button, i) => parseCampaignCard(button, {
    now, section: sectionOf(button, sections), occurrence: occurrences[i],
  }));
  return summarize(root, results);
}

/**
 * Per card, how many earlier cards share its game and name (0 for the first). Twitch now
 * shows one card per game, so repeats are rare, but they must not merge into one campaign.
 * @param {Element[]} buttons  card expand buttons in page order
 * @returns {number[]}
 */
export function cardOccurrences(buttons) {
  const seen = new Map();
  return buttons.map((button) => {
    const key = `${button.querySelector('img')?.getAttribute('alt')?.trim() ?? ''}\u001f${text(button.querySelector('p'))}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

/**
 * Page result from per-card results: hook self-check, plus per-card warnings counted into
 * page warnings such as "campaigns:card-without-drops:3". A live scan passes the self-check
 * it ran at the start, since the user may have left the page by the end.
 */
export function summarize(root, results, checkWarnings = selfCheck(root, 'campaigns')) {
  const warnings = [...checkWarnings];
  if (!results.length) warnings.push('campaigns:no-cards');
  const counts = new Map();
  for (const w of results.flatMap((r) => r.warnings)) counts.set(w, (counts.get(w) ?? 0) + 1);
  warnings.push(...[...counts].map(([w, n]) => `${w}:${n}`));
  return { data: { campaigns: results.map((r) => r.campaign) }, warnings };
}

/** Section heading text for a card: the last section heading before it in the document. */
export function sectionOf(el, sections) {
  let found = '';
  for (const heading of sections) {
    if (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = text(heading);
    else break;
  }
  return found;
}

/**
 * One card. Twitch shows one card per game holding all of that game's campaigns: the header
 * names the game and shows the first campaign's start and the last campaign's end,
 * and each drop block carries its own dates. So the id leaves the dates out (they move when
 * one campaign in the card ends), and a read body widens the card's dates to its drops'.
 * @param {Element} button  the card's expand button
 * @param {{now: Date|number, section: string, occurrence?: number}} options
 *   occurrence: earlier cards with the same game and name (cardOccurrences)
 * @returns {{campaign: object, warnings: string[]}}
 */
export function parseCampaignCard(button, { now, section, occurrence = 0 }) {
  const warnings = [];
  const [nameEl, publisherEl] = button.querySelectorAll('p');
  const img = button.querySelector('img');
  const { start, end } = parseDateRange(text(button), now);
  const game = img?.getAttribute('alt')?.trim() ?? '';
  const name = text(nameEl);
  const id = occurrence ? stableId(game, name, occurrence) : stableId(game, name);
  if (!start || !end) warnings.push('campaigns:card-dates');

  const campaign = {
    id,
    game,
    gameSlug: '',
    name,
    publisher: text(publisherEl),
    imageUrl: safeUrl(img?.getAttribute('src')),
    startDate: start,
    endDate: end,
    detailsURL: '',
    accountLinkURL: '',
    connection: '',
    isRewardCampaign: T.rewardSection.test(section),
    closed: false,
    bodyParsed: false,
    drops: [],
  };

  const body = cardBody(button);
  if (body?.querySelector('strong')) {
    const parsed = parseBody(body, campaign, now);
    Object.assign(campaign, parsed.fields, { bodyParsed: true, bodyReadAt: new Date(now).toISOString() });
    const starts = campaign.drops.map((d) => d.startAt).filter(Boolean);
    const ends = campaign.drops.map((d) => d.endAt).filter(Boolean);
    campaign.startDate = [campaign.startDate, ...starts].filter(Boolean).sort()[0] ?? '';
    campaign.endDate = [campaign.endDate, ...ends].filter(Boolean).sort().pop() ?? '';
    warnings.push(...parsed.warnings);
    if (!campaign.drops.length) warnings.push('campaigns:card-without-drops');
  }
  return { campaign: sanitizeCampaign(campaign), warnings };
}

function sectionKind(label) {
  if (isToken(label, T.sectionRewards)) return 'rewards';
  if (isToken(label, T.sectionHowToEarn)) return 'howToEarn';
  if (isToken(label, T.sectionRewardHowToEarn)) return 'rewardHowToEarn';
  if (isToken(label, T.sectionConnection)) return 'connection';
  if (isToken(label, T.sectionProgress)) return 'progress';
  if (isToken(label, T.sectionOther)) return 'other';
  return 'title';
}

function parseBody(body, campaign, now) {
  const fields = { gameSlug: '', detailsURL: '', accountLinkURL: '', connection: 'not_required', closed: false };
  const blocks = []; // drop blocks (drop campaigns) or Rewards groups (reward campaigns)
  let section = '';
  let title = '';
  let block = null;
  let pendingImage = '';

  const newBlock = () => ({
    title, dropType: '', start: '', end: '', tiles: [], lines: [],
    channels: [], channelsMore: false, categoryURL: '', minutes: null,
  });

  for (const el of body.querySelectorAll('*')) {
    const tag = el.tagName;
    const leaf = el.childElementCount === 0;
    if (tag === 'A') {
      const slug = categorySlug(el.getAttribute('href'));
      if (slug && !fields.gameSlug) fields.gameSlug = slug;
    }
    if (leaf && isToken(text(el), T.closed)) fields.closed = true;

    if (tag === 'STRONG' && !el.closest('li')) {
      const label = text(el);
      section = sectionKind(label);
      if (section === 'title') {
        title = label;
        if (!campaign.isRewardCampaign) blocks.push(block = newBlock());
      } else if (section === 'rewards' && campaign.isRewardCampaign) {
        blocks.push(block = newBlock());
      }
      pendingImage = '';
      continue;
    }

    switch (section) {
      case 'title':
        if (!block) break;
        if (leaf && isToken(text(el), T.typeSub)) block.dropType = 'sub';
        else if (leaf && isToken(text(el), T.typeWatch)) block.dropType = 'watch';
        if (tag === 'P' && !block.start) {
          const range = parseDateRange(text(el), now);
          block.start = range.start;
          block.end = range.end;
        }
        break;
      case 'rewards':
        if (!block) break;
        if (tag === 'IMG') pendingImage ||= safeUrl(el.getAttribute('src'));
        else if (tag === 'P' && text(el)) {
          block.tiles.push({ name: text(el), imageUrl: pendingImage, type: '' });
          pendingImage = '';
        } else if (tag === 'SPAN' && block.tiles.length && !block.tiles.at(-1).type) {
          block.tiles.at(-1).type = text(el);
        }
        break;
      case 'howToEarn':
        if (block && tag === 'LI') readEarnLine(block, el);
        break;
      case 'rewardHowToEarn':
        if (block && tag === 'LI') {
          const m = T.rewardWatchLine.exec(text(el));
          if (m && block.minutes === null) block.minutes = parseDuration(m[1]);
          const category = [...el.querySelectorAll('a[href]')].find((a) => categorySlug(a.getAttribute('href')));
          if (category && !block.categoryURL) block.categoryURL = safeUrl(category.getAttribute('href'));
        }
        break;
      case 'connection':
        if (tag === 'SPAN' && isToken(text(el), T.connected)) fields.connection = 'connected';
        else if (tag === 'A' && isToken(text(el), T.connect)) {
          fields.connection = 'not_connected';
          fields.accountLinkURL = safeUrl(el.getAttribute('href'));
        }
        break;
      case 'progress':
      case 'other':
        // The "About This Drop" button: an https link outside the bullet list.
        if (tag === 'A' && !fields.detailsURL && !el.closest('li')) {
          const url = safeUrl(el.getAttribute('href'));
          if (url && !/^https:\/\/www\.twitch\.tv\/drops\//.test(url)) fields.detailsURL = url;
        }
        break;
    }
  }

  const fallbackURL = fields.gameSlug
    ? `https://www.twitch.tv/directory/category/${encodeURIComponent(fields.gameSlug)}?filter=drops`
    : '';
  const warnings = [];
  const drops = [];
  for (const b of blocks) {
    const built = campaign.isRewardCampaign ? rewardDrops(b) : blockDrops(b);
    if (built.unparsed) warnings.push('campaigns:unparsed-earn-lines');
    for (const d of built.drops) {
      const scope = b.channels.length ? (b.channelsMore ? 'listed_more' : 'listed') : 'any';
      const required = d.dropType === 'sub' ? d.requiredSubs : d.requiredMinutes;
      const rewardKey = d.rewards.map((r) => `${r.name}|${r.imageUrl}`).join('\n');
      let id = stableId(campaign.id, d.dropType, required, rewardKey);
      while (drops.some((x) => x.id === id)) id = stableId(id, 'dup');
      drops.push({
        id,
        name: d.rewards.map((r) => r.name).join(' + ') || b.title,
        groupName: b.title,
        imageUrl: d.rewards.find((r) => r.imageUrl)?.imageUrl ?? '',
        rewards: d.rewards,
        dropType: d.dropType,
        requiredMinutes: d.requiredMinutes,
        requiredSubs: d.requiredSubs,
        progressMinutes: 0,
        status: 'locked',
        startAt: b.start,
        endAt: b.end,
        channelScope: scope,
        channels: b.channels,
        watchURL: scope === 'listed' ? '' : (b.categoryURL || fallbackURL),
      });
    }
  }
  return { fields: { ...fields, drops }, warnings };
}

// One "How to Earn the Drop" list item: either the channel line or a drop line.
function readEarnLine(block, li) {
  const links = [...li.querySelectorAll('a[href]')].map((a) => ({ a, href: a.getAttribute('href') }));
  const channels = links.filter((l) => channelLogin(l.href));
  const category = links.find((l) => categorySlug(l.href));
  if (channels.length) {
    for (const { a, href } of channels) {
      const login = channelLogin(href);
      if (!block.channels.some((c) => c.login === login)) block.channels.push({ login, displayName: text(a) });
    }
    if (category) block.channelsMore = true;
  }
  if (category && !block.categoryURL) block.categoryURL = safeUrl(category.href);

  const line = text(li);
  const rewardNames = [...li.querySelectorAll('span')].map(text).filter(Boolean);
  const watch = T.watchLine.exec(line);
  const sub = T.subLine.exec(line);
  if (watch) block.lines.push({ dropType: 'watch', minutes: parseDuration(watch[1]), subs: null, rewardNames });
  else if (sub) block.lines.push({ dropType: 'sub', minutes: null, subs: Number(sub[1]), rewardNames });
}

// Drops of one drop block: one per drop line. Tiles are listed in drop order. Named
// rewards are matched to tiles by name, in order (several lines can name the same reward,
// e.g. five "Streamer Stickers" tiers). Some lines leave the names out ("claim the
// rewards" and nothing after): those get the unused tiles. Tile order mostly follows the
// lines but not always, so a single run of unnamed lines takes every unused tile; with
// several runs, each takes the unused tiles between its named neighbours (split evenly
// when a run has more than one line).
function blockDrops(b) {
  const { tiles, lines } = b;
  const unnamed = lines.map((l) => !l.rewardNames.length);
  const oneRun = unnamed.filter((u, i) => u && !unnamed[i - 1]).length <= 1;
  const used = tiles.map(() => false);
  let cursor = 0;
  const picked = lines.map((l) => l.rewardNames.map((name) => {
    let i = tiles.findIndex((t, j) => j >= cursor && !used[j] && t.name === name);
    if (i === -1) i = tiles.findIndex((t, j) => !used[j] && t.name === name);
    if (i === -1) return -1;
    used[i] = true;
    cursor = i + 1;
    return i;
  }));
  for (let i = 0; i < lines.length;) {
    if (lines[i].rewardNames.length) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !lines[j].rewardNames.length) j++;
    const lo = Math.max(-1, ...picked.slice(0, i).flat());
    const after = picked.slice(j).flat().filter((x) => x >= 0);
    const hi = after.length ? Math.min(...after) : tiles.length;
    const free = tiles.map((_, k) => k).filter((k) => !used[k] && (oneRun || (k > lo && k < hi)));
    const per = Math.ceil(free.length / (j - i));
    for (let k = i; k < j; k++) {
      picked[k] = free.splice(0, per);
      for (const x of picked[k]) used[x] = true;
    }
    i = j;
  }
  const drops = lines.map((l, k) => ({
    dropType: l.dropType,
    requiredMinutes: l.minutes,
    requiredSubs: l.subs,
    rewards: picked[k].map((i, n) => (i >= 0 ? tiles[i] : { name: l.rewardNames[n], imageUrl: '', type: '' })),
  }));
  if (drops.length || !tiles.length) return { drops, unparsed: false };
  // Lines not understood (new wording or locale): keep the rewards, without requirements.
  return {
    drops: b.tiles.map((t) => ({
      dropType: b.dropType || 'watch', requiredMinutes: null, requiredSubs: null, rewards: [t],
    })),
    unparsed: true,
  };
}

// Reward campaigns: one drop per Rewards section, its minutes from the following
// "How To Earn The Reward" line when it has one.
function rewardDrops(b) {
  if (!b.tiles.length) return { drops: [], unparsed: false };
  return {
    drops: [{ dropType: 'watch', requiredMinutes: b.minutes, requiredSubs: null, rewards: b.tiles }],
    unparsed: false,
  };
}
