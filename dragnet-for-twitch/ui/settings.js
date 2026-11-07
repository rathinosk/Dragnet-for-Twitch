// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Settings page: scanning (history length, re-reading older campaigns, auto-claim, the timed
// inventory check), stall detection (with auto-reload), the UI language, what the last scans read with their warnings, and the Danger Zone
// (Twitch data, diagnostics, deleting stored data). Saved to
// chrome.storage.sync as soon as a control changes; re-renders when storage changes (from
// a scan, or the same settings open elsewhere).

import {
  SCHEMA_VERSION, KEYS, SETTINGS, AUTO_CLAIM_AVAILABLE, UI_LOCALES, sanitizeSettings,
} from '../core/schema.js';
import { isFatal } from '../core/merge.js';
import {
  t, formatLanguage, autoLanguage, messagesLanguage, languageName, localeTag,
} from './i18n.js';
import {
  $, el, saveSettings, warningText, setUpPage,
} from './common.js';
import { flagIcon } from './flags.js';

const historySelect = $('history-days');
const incrementalBox = $('incremental');
const incrementalCount = $('incremental-count');
const autoClaimBox = $('auto-claim');
const inventoryCheckSelect = $('inventory-check');
const dropAlertBox = $('drop-alert');
const stallDetectBox = $('stall-detect');
const stallReloadBox = $('stall-reload');
const stallReloadActiveBox = $('stall-reload-active');
const stallReloadMaxSelect = $('stall-reload-max');
const languageSelect = $('language-select');
const diagnosticsBox = $('diagnostics');
const twitchApiBox = $('twitch-api');

const option = (value, label) => el('option', { value: String(value), textContent: label });

function historyLabel(days) {
  return days % 30 === 0 ? t('historyMonths', { count: days / 30 })
    : days % 7 === 0 ? t('historyWeeks', { count: days / 7 }) : t('historyDays', { count: days });
}

function inventoryCheckLabel(minutes) {
  if (!minutes) return t('inventoryCheckOff');
  return minutes % 60 === 0 ? t('inventoryCheckHours', { count: minutes / 60 }) : t('inventoryCheckMinutes', { count: minutes });
}

// A nested setting, greyed out and disabled while the one above it is off.
function enable(control, on) {
  control.disabled = !on;
  control.closest('.setting').classList.toggle('disabled', !on);
}

const relative = new Intl.RelativeTimeFormat(formatLanguage, { numeric: 'auto' });

function ago(iso, now) {
  const minutes = Math.round((Date.parse(iso) - now) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 48 ? relative.format(hours, 'hour') : relative.format(Math.round(hours / 24), 'day');
}

/** What a scan did, as short facts. */
function scanFacts(page, scan) {
  const facts = [];
  if (page === 'campaigns') {
    if (Number.isFinite(scan.cardsOpened)) facts.push(t('scanCardsOpened', { opened: scan.cardsOpened, count: scan.cardCount }));
    if (scan.interrupted) facts.push(t('scanInterrupted'));
    if (scan.gql) facts.push(t('scanGqlCampaigns', { count: scan.gql.details ?? 0, added: scan.gql.added ?? 0 }));
  } else {
    if (Number.isFinite(scan.loadMoreClicks)) facts.push(t('scanLoadMore', { count: scan.loadMoreClicks }));
    if (scan.reachedKnown) facts.push(t('scanReachedKnown'));
    if (scan.gql) facts.push(t('scanGqlInventory', { count: scan.gql.claims ?? 0 }));
  }
  return facts;
}

// One card per page: a status dot (grey not read, green clean, amber warnings, red a
// warning that stopped the read), the mode, when, what it did, and its warnings.
function renderScan(page, scan, now) {
  const card = $(`scan-${page}`);
  const warnings = [...new Set(scan?.warnings ?? [])];
  const level = !scan ? 'none' : isFatal(warnings) ? 'fatal' : warnings.length ? 'warn' : 'ok';
  card.dataset.level = level;
  const mode = card.querySelector('.scan-mode');
  mode.hidden = !scan;
  mode.textContent = !scan ? '' : scan.mode === 'full' ? t('scanFull') : t('scanVisit');
  mode.classList.toggle('accent', scan?.mode === 'full');
  const when = card.querySelector('.scan-when');
  when.textContent = scan ? ago(scan.at, now) : t('scanNotRead');
  when.title = scan ? new Date(scan.at).toLocaleString(formatLanguage) : '';
  card.querySelector('.scan-facts').replaceChildren(...(scan ? scanFacts(page, scan) : [])
    .map((f) => el('li', { textContent: f })));
  card.querySelector('.scan-warnings').replaceChildren(...(!scan ? []
    : warnings.length ? warnings.map((w) => el('li', { className: isFatal([w]) ? 'fatal' : '', textContent: warningText(w) }))
      : [el('li', { className: 'clean', textContent: t('scanNoWarnings') })]));
}

let state = null;

function render() {
  if (!state) return;
  const settings = sanitizeSettings(state[KEYS.settings]);
  historySelect.value = String(settings.historyDays);
  incrementalBox.checked = settings.incremental;
  incrementalCount.value = String(settings.incrementalCount);
  incrementalCount.disabled = !settings.incremental;
  incrementalCount.closest('.setting').classList.toggle('disabled', !settings.incremental);
  autoClaimBox.checked = settings.autoClaim;
  inventoryCheckSelect.value = String(settings.inventoryCheck);
  dropAlertBox.checked = settings.dropAlert;
  stallDetectBox.checked = settings.stallDetect;
  stallReloadBox.checked = settings.stallReload;
  stallReloadActiveBox.checked = settings.stallReloadActive;
  stallReloadMaxSelect.value = String(settings.stallReloadMax);
  enable(stallReloadBox, settings.stallDetect);
  enable(stallReloadActiveBox, settings.stallDetect && settings.stallReload);
  enable(stallReloadMaxSelect, settings.stallDetect && settings.stallReload);
  languageSelect.value = settings.language;
  diagnosticsBox.checked = settings.diagnostics;
  twitchApiBox.checked = settings.twitchApi;
  const scans = state[KEYS.scans] ?? {};
  const now = Date.now();
  renderScan('campaigns', scans.campaigns, now);
  renderScan('inventory', scans.inventory, now);
}

async function load() {
  try {
    const [local, sync] = await Promise.all([
      chrome.storage.local.get(KEYS.scans),
      chrome.storage.sync.get(KEYS.settings),
    ]);
    state = { ...local, ...sync };
    render();
  } catch (err) {
    console.error('[Dragnet]', err);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes[KEYS.scans]) || (area === 'sync' && changes[KEYS.settings])) load();
});

setUpPage();
historySelect.replaceChildren(...SETTINGS.historyDays.options.map((days) => option(days, historyLabel(days))));
incrementalCount.replaceChildren(...SETTINGS.incrementalCount.options.map((n) => option(n, String(n))));
inventoryCheckSelect.replaceChildren(...SETTINGS.inventoryCheck.options.map((m) => option(m, inventoryCheckLabel(m))));
stallReloadMaxSelect.replaceChildren(...SETTINGS.stallReloadMax.options.map((n) => option(n, t('stallReloadMaxOption', { count: n }))));
autoClaimBox.disabled = !AUTO_CLAIM_AVAILABLE;
$('auto-claim-note').hidden = AUTO_CLAIM_AVAILABLE;
// Each language by its own name; Automatic names the one Chrome picks.
languageSelect.replaceChildren(
  option('auto', t('languageAuto', { name: languageName(autoLanguage) })),
  ...UI_LOCALES.map((folder) => option(folder, languageName(localeTag(folder)))),
);
$('language-flag').replaceChildren(flagIcon(messagesLanguage));

historySelect.addEventListener('change', () => saveSettings({ historyDays: Number(historySelect.value) }));
incrementalBox.addEventListener('change', () => saveSettings({ incremental: incrementalBox.checked }));
incrementalCount.addEventListener('change', () => saveSettings({ incrementalCount: Number(incrementalCount.value) }));
autoClaimBox.addEventListener('change', () => saveSettings({ autoClaim: autoClaimBox.checked }));
inventoryCheckSelect.addEventListener('change', () => saveSettings({ inventoryCheck: Number(inventoryCheckSelect.value) }));
dropAlertBox.addEventListener('change', () => saveSettings({ dropAlert: dropAlertBox.checked }));
stallDetectBox.addEventListener('change', () => saveSettings({ stallDetect: stallDetectBox.checked }));
stallReloadBox.addEventListener('change', () => saveSettings({ stallReload: stallReloadBox.checked }));
stallReloadActiveBox.addEventListener('change', () => saveSettings({ stallReloadActive: stallReloadActiveBox.checked }));
stallReloadMaxSelect.addEventListener('change', () => saveSettings({ stallReloadMax: Number(stallReloadMaxSelect.value) }));
// The page reloads in the new language once the setting is saved (common.js).
languageSelect.addEventListener('change', () => saveSettings({ language: languageSelect.value }));
diagnosticsBox.addEventListener('change', () => saveSettings({ diagnostics: diagnosticsBox.checked }));
twitchApiBox.addEventListener('change', () => saveSettings({ twitchApi: twitchApiBox.checked }));

// Danger Zone: delete stored data, after a confirmation. Local data rebuilds from the Twitch
// pages; sync holds the settings and the game filter, which go back to their defaults (and
// the page reloads if that changes the language, common.js).
async function wipeLocal() {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ [KEYS.schemaVersion]: SCHEMA_VERSION });
}
const wipeSync = () => chrome.storage.sync.clear();
const wipes = [
  ['wipe-local', t('wipeLocalConfirm'), wipeLocal],
  ['wipe-sync', t('wipeSyncConfirm'), wipeSync],
  ['wipe-all', t('wipeAllConfirm'), () => Promise.all([wipeLocal(), wipeSync()])],
];
for (const [id, question, wipe] of wipes) {
  $(id).addEventListener('click', async () => {
    if (!confirm(question)) return;
    $('wipe-status').textContent = '';
    try {
      await wipe();
      $('wipe-status').textContent = t('wipeDone');
    } catch (err) {
      console.error('[Dragnet]', err);
      $('wipe-status').textContent = t('wipeFailed');
    }
  });
}

// "12 minutes ago" moves on while the page stays open.
setInterval(render, 60000);
load();
