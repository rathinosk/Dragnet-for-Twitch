// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// The popup and the full page (body[data-view] is "popup" or "page"; same markup, laid out
// by dragnet.css). Campaigns sorted by end date or grouped by game, coloured by urgency,
// searchable, with each drop's progress, claim state and where to watch it, a Connect link
// for campaigns whose game account is not linked, a health banner, stall alerts with a
// Reload stream button (core/stall.js, kept by the background in session storage), the filters (the
// funnel button; the settings have their own page, ui/settings.html) and, on the full page, a
// Statistics panel (core/stats.js). Built with DOM APIs
// and textContent only (no innerHTML): every value is scraped. Strings come from _locales
// (ui/i18n.js). Re-renders when storage changes.

import {
  KEYS, SETTINGS, sanitizeSettings, sanitizeGameFilter,
} from '../core/schema.js';
import { activeCampaigns, isFatal, withoutEndedDrops, nextDeadline } from '../core/merge.js';
import { filterCampaigns, filterGameNames, gameKey } from '../core/filter.js';
import { computeStats } from '../core/stats.js';
import {
  urgency, claimProgress, isComplete, needsAttention, matchesSearch, groupByGame, withoutSubDrops,
} from '../core/view.js';
import { t, formatLanguage } from './i18n.js';
import {
  $, el, saveSettings, saveGameFilter, warningText, setUpPage,
} from './common.js';

const VIEW = document.body.dataset.view === 'page' ? 'page' : 'popup';

const statusEl = $('status');
const emptyEl = $('empty');
const healthEl = $('health');
const warningList = $('warnings');
const campaignList = $('campaigns');
const searchInput = $('search');
const syncButton = $('sync');
const connectionSelect = $('connection-filter');
const hideCompleteBox = $('hide-complete');
const hideSubDropsBox = $('hide-sub-drops');
const gameSearch = $('game-search');
const gameList = $('games');
const filtersPanel = $('filters');
const filtersButton = $('filters-button');
const stallsEl = $('stalls');

const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';
// Full sync stays disabled until a scan lands, or this long if none does.
const SYNC_LOCK_MS = 10 * 60 * 1000;

function link(href, label, className) {
  // Stored URLs are https-only already (core/schema.js); links open in a new tab.
  return href ? el('a', { href, textContent: label, target: '_blank', rel: 'noopener', className: className ?? '' }) : label;
}

function image(src, className, width, height) {
  if (!src) return el('span', { className });
  return el('img', { src, className, width, height, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
}

// The game's directory filtered on Twitch's "Drops Enabled" tag. Not ?filter=drops, which
// also matches streams that only say "drops" in the title. Twitch tags a stream in its own
// language, each name is a separate filter, and ?tl= takes only one, so there is one link
// per language (each name checked live on Twitch).
const DROPS_TAGS = [
  ['English', 'DropsEnabled'],
  ['Deutsch', 'DropsAktiviert'],
  ['Español', 'DropsActivados'],
  ['Français', 'DropsActivés'],
  ['Português', 'DropsAtivados'],
  ['Русский', 'DropsВключены'],
  ['日本語', 'Drops有効'],
];

// Every drops-enabled stream, when the game's slug is not known.
const DROPS_ALL_URL = 'https://www.twitch.tv/directory/all/tags/DropsEnabled';

function dropsTagURL(slug, tag) {
  return `https://www.twitch.tv/directory/category/${encodeURIComponent(slug)}?tl=${encodeURIComponent(tag)}`;
}

// The box art opens the English tag's list.
function artLink(c) {
  const art = image(c.imageUrl, 'art', 36, 48);
  if (!c.gameSlug) return art;
  const a = el('a', {
    href: dropsTagURL(c.gameSlug, DROPS_TAGS[0][1]), target: '_blank', rel: 'noopener', className: 'art-link', title: t('dropsEnabledChannels'),
  }, art);
  a.setAttribute('aria-label', t('dropsEnabledChannels'));
  // Clicking it inside the summary must not count as opening or closing the card.
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

let dropsMenuCount = 0;

// The purple tag in the card's footer: a menu with one link per tag language.
function dropsTag(c) {
  if (!c.gameSlug) return null;
  const anchor = `--drops-tag-${++dropsMenuCount}`;
  const menu = el('div', { className: 'drops-menu' },
    el('div', { className: 'drops-menu-title', textContent: t('dropsEnabledChannels') }),
    ...DROPS_TAGS.map(([language, tag]) => el('a', {
      href: dropsTagURL(c.gameSlug, tag), target: '_blank', rel: 'noopener',
    }, el('span', { textContent: language }), el('span', { className: 'tag-name', textContent: tag }))));
  menu.popover = 'auto';
  menu.id = anchor.slice(2);
  menu.style.positionAnchor = anchor;
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) menu.hidePopover(); });

  const button = el('button', { type: 'button', className: 'drops-tag', title: t('dropsEnabledChannels') });
  button.setAttribute('aria-label', t('dropsEnabledChannels'));
  button.popoverTargetElement = menu;
  button.style.anchorName = anchor;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // A price tag pointing left, with a punched hole.
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('d', 'M7 1h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7L1 8Zm0 7a1.75 1.75 0 1 0 3.5 0A1.75 1.75 0 1 0 7 8Z');
  svg.append(path);
  button.append(svg);
  return el('span', { className: 'drops-tag-wrap' }, button, menu);
}

function bar(percent, className = '') {
  const fill = el('span');
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  const node = el('div', { className: `bar ${className}` }, fill);
  node.setAttribute('role', 'progressbar');
  node.setAttribute('aria-valuemin', '0');
  node.setAttribute('aria-valuemax', '100');
  node.setAttribute('aria-valuenow', String(Math.round(percent)));
  return node;
}

function formatMinutes(minutes) {
  if (minutes === null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return t('durationHoursMinutes', { h, m });
  return h ? t('durationHours', { h }) : t('durationMinutes', { m });
}

function requirement(drop) {
  if (drop.dropType === 'sub') {
    return drop.requiredSubs === null ? t('subsUnknown') : t('subsRequired', { count: drop.requiredSubs });
  }
  return formatMinutes(drop.requiredMinutes);
}

const dateFormat = new Intl.DateTimeFormat(formatLanguage, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const relative = new Intl.RelativeTimeFormat(formatLanguage, { numeric: 'auto' });

function timeLeft(endDate, now) {
  const minutes = (Date.parse(endDate) - now) / 60000;
  if (minutes < 60) return t('minutesLeft', { count: Math.max(0, Math.round(minutes)) });
  if (minutes < 48 * 60) return t('hoursLeft', { count: Math.round(minutes / 60) });
  return t('daysLeft', { count: Math.round(minutes / 1440) });
}

function ago(iso, now) {
  const minutes = Math.round((Date.parse(iso) - now) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 48 ? relative.format(hours, 'hour') : relative.format(Math.round(hours / 24), 'day');
}

function whereToWatch(drop) {
  const channels = el('span', { className: 'channels' },
    ...drop.channels.map((c) => link(`https://www.twitch.tv/${c.login}`, c.displayName)));
  if (drop.channelScope === 'listed') return el('span', {}, t('watchOn'), ' ', channels);
  if (drop.channelScope === 'listed_more') {
    return el('span', {}, t('watchOn'), ' ', channels, ' ', t('watchOr'), ' ', link(drop.watchURL, t('moreChannels')));
  }
  return link(drop.watchURL, t('anyChannel'));
}

function dropProgress(drop) {
  const percent = drop.progressPercent ?? 0;
  if (drop.status !== 'in_progress' && !(drop.status === 'locked' && percent > 0)) return null;
  const shown = Math.floor(percent);
  const text = drop.dropType === 'watch' && drop.requiredMinutes
    ? t('progressOfMinutes', {
      percent: shown, done: formatMinutes(drop.progressMinutes ?? 0), total: formatMinutes(drop.requiredMinutes),
    })
    : t('progressPercent', { percent: shown });
  return el('div', { className: 'drop-progress' }, bar(percent), el('span', { textContent: text }));
}

function dropState(drop) {
  if (drop.status === 'claimed') {
    const title = drop.claimedAt ? t('claimedOn', { date: dateFormat.format(new Date(drop.claimedAt)) }) : '';
    return el('span', { className: 'drop-state claimed', textContent: `✓ ${t('stateClaimed')}`, title });
  }
  if (drop.status === 'claimable') {
    return el('span', { className: 'drop-state' }, link(INVENTORY_URL, t('stateClaimNow'), 'btn small primary'));
  }
  return null;
}

// An unclaimed drop shows its own time left: one game card can hold campaigns that end
// days apart, so the card's pill (its soonest unclaimed drop) is not every drop's.
function renderDrop(drop, now) {
  const need = requirement(drop);
  const open = drop.status !== 'claimed';
  const level = open && drop.endAt ? urgency(drop.endAt, now) : 'normal';
  const left = open && drop.endAt
    ? el('span', {
      className: `pill ${level}`, textContent: timeLeft(drop.endAt, now),
      title: t('endsAt', { date: dateFormat.format(new Date(drop.endAt)) }),
    })
    : null;
  return el('li', { className: `drop ${drop.status} urgency-${level}` },
    image(drop.imageUrl, 'reward', 32, 32),
    el('div', { className: 'drop-main' },
      el('div', { className: 'drop-head' },
        el('span', { className: 'drop-name', textContent: drop.name || drop.groupName }), left),
      el('div', { className: 'drop-meta' }, need, need && open ? ' · ' : '', open ? whereToWatch(drop) : ''),
      dropProgress(drop)),
    dropState(drop));
}

// Which cards are open: the user's choice per campaign survives re-renders; otherwise the
// popup opens only campaigns with a drop in progress or ready, the full page opens all.
const openState = new Map();

function isOpen(c) {
  return openState.get(c.id) ?? (VIEW === 'page' || needsAttention(c));
}

function renderCampaign(c, { grouped, now }) {
  const deadline = nextDeadline(c, now);
  const level = urgency(deadline, now);
  const { claimed, total } = claimProgress(c);
  const claimable = c.drops.filter((d) => d.status === 'claimable').length;
  const title = grouped || c.name === c.game ? c.name : c.game;
  const subtitle = grouped || c.name === c.game ? '' : c.name;
  const ends = deadline
    ? el('span', {
      className: `pill ${level}`, textContent: timeLeft(deadline, now), title: t('endsAt', { date: dateFormat.format(new Date(deadline)) }),
    })
    : null;
  const meta = el('div', { className: 'meta-row' },
    c.connection === 'not_connected' && el('span', { className: 'pill not-connected', textContent: t('notConnected') }),
    claimable > 0 && el('span', { className: 'pill claimable', textContent: t('readyToClaim', { count: claimable }) }),
    total > 0 && el('span', { className: 'claim-progress' },
      bar((claimed / total) * 100, claimed === total ? 'ok' : ''),
      el('span', { textContent: t('claimedOf', { claimed, count: total }) })),
    total === 0 && el('span', { textContent: c.bodyParsed ? t('noDrops') : t('dropsNotRead') }));

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 16 16');
  chevron.setAttribute('class', 'chevron');
  chevron.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  chevron.append(path);

  const summary = el('summary', {},
    grouped ? null : artLink(c),
    el('div', { className: 'head' },
      el('div', { className: 'title-row' }, el('span', { className: 'title', textContent: title, title }), ends),
      subtitle && el('div', { className: 'subtitle', textContent: subtitle, title: subtitle }),
      meta),
    chevron);

  const connect = c.connection === 'not_connected'
    ? el('p', { className: 'connect-row' }, t('notConnectedHint'), c.accountLinkURL && link(c.accountLinkURL, t('connect'), 'btn small'))
    : null;
  const foot = el('div', { className: 'campaign-foot' },
    dropsTag(c),
    c.endDate && el('span', { textContent: t('endsAt', { date: dateFormat.format(new Date(c.endDate)) }) }),
    c.publisher && el('span', { textContent: c.publisher }),
    c.detailsURL && link(c.detailsURL, t('aboutCampaign')));
  const body = el('div', { className: 'campaign-body' },
    connect,
    c.drops.length ? el('ul', { className: 'drops' }, ...c.drops.map((d) => renderDrop(d, now))) : null,
    foot);

  const details = el('details', { className: `campaign urgency-${level}`, open: isOpen(c) }, summary, body);
  // Remember the user's choice (a click or Enter/Space on the summary) before it toggles.
  summary.addEventListener('click', () => openState.set(c.id, !details.open));
  return details;
}

function renderList(shown, settings, now) {
  if (settings.groupBy === 'game') {
    campaignList.className = 'grouped';
    campaignList.replaceChildren(...groupByGame(shown).map((g) => el('section', { className: 'game-group' },
      el('h2', {}, image(g.imageUrl, '', 20, 27), el('span', { textContent: g.game }),
        el('span', { className: 'count', textContent: String(g.campaigns.length) })),
      el('div', { className: 'group-list' }, ...g.campaigns.map((c) => renderCampaign(c, { grouped: true, now }))))));
  } else {
    campaignList.className = 'flat';
    campaignList.replaceChildren(...shown.map((c) => renderCampaign(c, { grouped: false, now })));
  }
}

function renderFilters(settings, gameFilter) {
  connectionSelect.value = settings.connectionFilter;
  hideCompleteBox.checked = settings.hideComplete;
  hideSubDropsBox.checked = settings.hideSubDrops;
  for (const radio of document.querySelectorAll('input[name="group-by"]')) radio.checked = radio.value === settings.groupBy;
  for (const radio of document.querySelectorAll('input[name="game-mode"]')) radio.checked = radio.value === gameFilter.mode;
}

function renderGameFilter(active, gameFilter) {
  const listed = new Set(gameFilter.games.map(gameKey));
  // Keep focus on the checkbox being toggled when the list re-renders after the save.
  const focused = document.activeElement?.dataset?.game;
  gameList.replaceChildren(...filterGameNames(active, gameFilter).map((name) => {
    const box = el('input', { type: 'checkbox', className: 'box', checked: listed.has(gameKey(name)) });
    box.dataset.game = name;
    return el('li', {}, el('label', { className: 'game' }, box, el('span', { textContent: name, title: name })));
  }));
  $('games-clear').disabled = gameFilter.games.length === 0;
  filterGameList();
  if (focused) [...gameList.querySelectorAll('input')].find((b) => b.dataset.game === focused)?.focus();
}

function filterGameList() {
  const query = gameKey(gameSearch.value);
  for (const li of gameList.children) {
    li.hidden = Boolean(query) && !gameKey(li.textContent).includes(query);
  }
}

// Stall alerts: a stream whose drop progress stopped rising. Reload stream reloads that tab
// (it does not count toward auto-reload's limit); after auto-reload gave up, the line links to
// the game's drops-enabled streams (the user picks one; Dragnet never chooses a channel).
function renderStalls(alerts) {
  const valid = (Array.isArray(alerts) ? alerts : [])
    .filter((a) => Number.isInteger(a?.tabId) && typeof a.channel === 'string' && /^[a-z0-9_]{2,25}$/.test(a.channel));
  const button = (label, type, tabId) => {
    const b = el('button', { type: 'button', className: 'btn small', textContent: label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type, tabId });
      } catch (err) {
        console.error('[Dragnet]', err);
        b.disabled = false;
      }
    });
    return b;
  };
  stallsEl.replaceChildren(...valid.map((a) => (a.gaveUp
    ? el('div', { className: 'stall gave-up' },
      el('span', { className: 'stall-text', textContent: t('stallGaveUp', { channel: a.channel, count: a.reloads }) }),
      link(/^[a-z0-9_.~%-]{1,100}$/.test(a.gameSlug ?? '') ? dropsTagURL(a.gameSlug, DROPS_TAGS[0][1]) : DROPS_ALL_URL, t('stallFindStreams'), 'btn small'),
      button(t('stallReloadButton'), 'dragnet:reload-stream', a.tabId),
      button(t('stallDismiss'), 'dragnet:dismiss-stall', a.tabId))
    : el('div', { className: 'stall' },
      el('span', { className: 'stall-text', textContent: t('stallAlert', { channel: a.channel }) }),
      button(t('stallReloadButton'), 'dragnet:reload-stream', a.tabId)))));
  stallsEl.hidden = valid.length === 0;
}

// Statistics panel (full page only; the popup has no #stats). Numbers come from
// core/stats.js; this builds the rows and the bar chart with DOM APIs.
const statsPanel = $('stats');
const STATS_OPEN = 'dragnet.statsOpen';
const dayFormat = new Intl.DateTimeFormat(formatLanguage, { month: 'short', day: 'numeric' });

function statRow(label, value) {
  return el('div', { className: 'stat' }, el('dt', { textContent: label }), el('dd', { textContent: String(value) }));
}

// "3 of 5" when the game filter hides some, else just the number.
function shownOfAll(counts, key) {
  return counts.shown[key] === counts.all[key] ? counts.all[key] : t('statsOfAll', { shown: counts.shown[key], all: counts.all[key] });
}

function claimChart(perDay) {
  const SVG = 'http://www.w3.org/2000/svg';
  const barWidth = 10;
  const height = 48;
  const max = Math.max(1, ...perDay.map((d) => d.count));
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${perDay.length * barWidth} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chart-bars');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('statsChartLabel', { days: perDay.length }));
  perDay.forEach((day, i) => {
    const h = day.count ? Math.max(3, (day.count / max) * (height - 2)) : 1;
    const bar = document.createElementNS(SVG, 'rect');
    bar.setAttribute('x', String(i * barWidth + 1));
    bar.setAttribute('width', String(barWidth - 2));
    bar.setAttribute('y', String(height - h));
    bar.setAttribute('height', String(h));
    bar.setAttribute('class', day.count ? 'chart-bar' : 'chart-bar empty');
    const title = document.createElementNS(SVG, 'title');
    title.textContent = t('statsChartDay', { date: dayFormat.format(new Date(day.date)), count: day.count });
    bar.append(title);
    svg.append(bar);
  });
  return el('div', {},
    svg,
    el('div', { className: 'chart-axis' },
      el('span', { textContent: dayFormat.format(new Date(perDay[0].date)) }),
      el('span', { textContent: t('statsChartMax', { max }) }),
      el('span', { textContent: dayFormat.format(new Date(perDay.at(-1).date)) })));
}

function renderStats({
  all, shown, claims, historyDays,
}, now) {
  if (!statsPanel || statsPanel.hidden) return;
  const stats = computeStats({
    all, shown, claims, historyDays,
  }, now);
  const counts = { all: stats.all, shown: stats.shown };
  $('stats-campaigns').replaceChildren(
    statRow(t('statsCampaigns'), shownOfAll(counts, 'campaigns')),
    statRow(t('statsGames'), shownOfAll(counts, 'games')),
    statRow(t('statsCampaignsInProgress'), shownOfAll(counts, 'campaignsInProgress')),
    statRow(t('statsDropsInProgress'), shownOfAll(counts, 'dropsInProgress')),
    statRow(t('statsDropsClaimable'), shownOfAll(counts, 'dropsClaimable')),
    statRow(t('statsEnding24h'), t('statsOfAll', { shown: stats.shown.ending24h, all: stats.shown.campaigns })),
    statRow(t('statsEnding7d'), t('statsOfAll', { shown: stats.shown.ending7d, all: stats.shown.campaigns })));

  const c = stats.claims;
  $('stats-claims').replaceChildren(
    statRow(t('statsClaimsTotal'), c.total),
    statRow(t('statsClaims7'), c.last7),
    statRow(t('statsClaims30'), c.last30));
  $('stats-chart').replaceChildren(c.total
    ? claimChart(c.perDay)
    : el('p', { className: 'hint', textContent: t('statsNoClaims') }));
}

// The bar-chart button shows the panel; off by default, remembered per browser.
const statsButton = $('stats-button');
function showStats(open, redraw = true) {
  statsPanel.hidden = !open;
  statsButton.setAttribute('aria-expanded', String(open));
  if (redraw) render();
}
if (statsPanel) {
  statsButton.addEventListener('click', () => {
    const open = statsPanel.hidden;
    showStats(open);
    try {
      localStorage.setItem(STATS_OPEN, String(open));
    } catch {
      // storage blocked: the panel is off again next time
    }
  });
  let on = false;
  try {
    on = localStorage.getItem(STATS_OPEN) === 'true';
  } catch {
    // storage blocked
  }
  showStats(on, false); // the first render comes with load()
}

let state = null;

function render() {
  if (!state) return;
  const now = Date.now();
  const settings = sanitizeSettings(state[KEYS.settings]);
  const gameFilter = sanitizeGameFilter(state[KEYS.gameFilter]);
  const scans = state[KEYS.scans] ?? {};
  // Drops can end between scans; order by the next unclaimed drop to end, not the card's
  // last end (a card holds all of a game's campaigns).
  const live = activeCampaigns((state[KEYS.campaigns] ?? []).map((c) => withoutEndedDrops(c, now)), now);
  // Hide Sub Drops comes first, so the order, progress and Hide finished go by what is shown.
  const active = (settings.hideSubDrops ? live.map(withoutSubDrops).filter(Boolean) : live)
    .map((c) => ({ c, deadline: nextDeadline(c, now) || '9999' }))
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .map(({ c }) => c);
  const filtered = filterCampaigns(active, { gameFilter, connectionFilter: settings.connectionFilter }).shown
    .filter((c) => !settings.hideComplete || !isComplete(c));
  const query = searchInput.value;
  const shown = filtered.filter((c) => matchesSearch(c, query));

  renderFilters(settings, gameFilter);
  renderGameFilter(live, gameFilter);
  renderList(shown, settings, now);
  renderStats({
    all: live, shown: filterCampaigns(live, { gameFilter }).shown, claims: state[KEYS.claims] ?? [], historyDays: settings.historyDays,
  }, now);

  const hidden = live.length - filtered.length;
  const parts = [];
  if (scans.campaigns) {
    parts.push(query.trim() ? t('searchCount', { count: shown.length, total: filtered.length })
      : hidden ? t('campaignCountHidden', { count: filtered.length, hidden }) : t('campaignCount', { count: filtered.length }));
    const last = [scans.campaigns.at, scans.inventory?.at].filter(Boolean).sort().pop();
    parts.push(t('statusSynced', { ago: ago(last, now) }));
  }
  statusEl.textContent = parts.join(' · ');
  statusEl.hidden = !parts.length;

  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent = !scans.campaigns ? t('statusNoScan')
    : query.trim() ? t('emptySearch') : live.length ? t('emptyFiltered') : t('emptyNone');

  // The banner shows what stopped a scan; the rest is detail for the Last scans section.
  const warnings = [...(scans.campaigns?.warnings ?? []), ...(scans.inventory?.warnings ?? [])];
  const fatal = [...new Set(warnings.filter((w) => isFatal([w])))];
  warningList.replaceChildren(...fatal.map((w) => el('li', { textContent: warningText(w) })));
  healthEl.hidden = fatal.length === 0;
  renderStalls(state.stalls);
}

async function load() {
  try {
    const [local, sync, session] = await Promise.all([
      chrome.storage.local.get([KEYS.campaigns, KEYS.scans, KEYS.claims]),
      chrome.storage.sync.get([KEYS.settings, KEYS.gameFilter]),
      chrome.storage.session.get('stalls'),
    ]);
    state = { ...local, ...sync, ...session };
    render();
  } catch (err) {
    statusEl.textContent = t('storageError');
    console.error('[Dragnet]', err);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.scans]) syncButton.disabled = false;
  if ((area === 'local' && (changes[KEYS.campaigns] || changes[KEYS.scans] || (statsPanel && changes[KEYS.claims])))
    || (area === 'sync' && (changes[KEYS.settings] || changes[KEYS.gameFilter]))
    || (area === 'session' && changes.stalls)) load();
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  setTimeout(() => { syncButton.disabled = false; }, SYNC_LOCK_MS);
  try {
    await chrome.runtime.sendMessage({ type: 'dragnet:refresh' });
  } catch (err) {
    console.error('[Dragnet]', err);
    syncButton.disabled = false;
  }
});

searchInput.addEventListener('input', render);
gameSearch.addEventListener('input', filterGameList);

// The funnel shows the filters: in the popup in place of the list, on the full page as the
// side column (shown unless hidden last time; a per-browser convenience).
const FILTERS_SHOWN = 'dragnet.filtersShown';
function showFilters(open) {
  filtersPanel.hidden = !open;
  if (VIEW === 'popup') $('main').hidden = open;
  else document.body.classList.toggle('no-filters', !open);
  filtersButton.setAttribute('aria-expanded', String(open));
}
filtersButton.addEventListener('click', () => {
  const open = filtersPanel.hidden;
  showFilters(open);
  if (VIEW === 'page') {
    try {
      localStorage.setItem(FILTERS_SHOWN, String(open));
    } catch {
      // storage blocked: the column just shows again next time
    }
  }
});
if (VIEW === 'page') {
  let shown = true;
  try {
    shown = localStorage.getItem(FILTERS_SHOWN) !== 'false';
  } catch {
    // storage blocked
  }
  showFilters(shown);
}

if (VIEW === 'popup') {
  $('open-page').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/page.html') });
    window.close();
  });
}

const option = (value, label) => el('option', { value: String(value), textContent: label });

setUpPage();
syncButton.setAttribute('aria-label', t('fullSyncTitle'));
const CONNECTION_LABELS = {
  all: 'connectionFilterAll', hide_not_connected: 'connectionFilterHide', only_not_connected: 'connectionFilterOnly',
};
connectionSelect.replaceChildren(...SETTINGS.connectionFilter.options.map((v) => option(v, t(CONNECTION_LABELS[v]))));

// Translations too long for the popup's bar: the Full sync button keeps only its icon (its
// tooltip and accessible name still say what it does).
const topbar = document.querySelector('.topbar');
if (topbar.scrollWidth > topbar.clientWidth) topbar.classList.add('compact');

connectionSelect.addEventListener('change', () => saveSettings({ connectionFilter: connectionSelect.value }));
hideCompleteBox.addEventListener('change', () => saveSettings({ hideComplete: hideCompleteBox.checked }));
hideSubDropsBox.addEventListener('change', () => saveSettings({ hideSubDrops: hideSubDropsBox.checked }));
for (const radio of document.querySelectorAll('input[name="group-by"]')) {
  radio.addEventListener('change', () => saveSettings({ groupBy: radio.value }));
}
for (const radio of document.querySelectorAll('input[name="game-mode"]')) {
  radio.addEventListener('change', () => saveGameFilter({ mode: radio.value }));
}
$('games-clear').addEventListener('click', () => saveGameFilter({ games: [] }));
gameList.addEventListener('change', (event) => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || !box.dataset.game) return;
  const name = box.dataset.game;
  saveGameFilter((current) => ({
    ...current,
    games: box.checked
      ? [...current.games, name]
      : current.games.filter((g) => gameKey(g) !== gameKey(name)),
  }));
});

// Time left and "synced ago" move on while the view stays open.
setInterval(render, 60000);
load();
