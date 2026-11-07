// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Shared by the extension pages (popup, full page, settings, help): the element builder,
// the settings save queue, health warning text, the top bar's language button and the
// Diagnostics button, and a reload when the language setting changes.

import {
  KEYS, DIAG_KEY, sanitizeSettings, sanitizeGameFilter,
} from '../core/schema.js';
import {
  t, localize, messagesLanguage, languageSetting, languageName,
} from './i18n.js';
import { flagIcon } from './flags.js';

export const $ = (id) => document.getElementById(id);

/** Small element builder: el('a', {href, textContent}, ...children). */
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

// Read-modify-write of a sync key, one at a time, so two quick toggles cannot overwrite
// each other's change.
let saving = Promise.resolve();
function save(key, sanitize, patch) {
  saving = saving.then(async () => {
    const { [key]: current } = await chrome.storage.sync.get(key);
    const next = typeof patch === 'function' ? patch(sanitize(current)) : { ...sanitize(current), ...patch };
    await chrome.storage.sync.set({ [key]: sanitize(next) });
  }).catch((err) => console.error('[Dragnet]', err));
  return saving;
}

export const saveSettings = (patch) => save(KEYS.settings, sanitizeSettings, patch);
export const saveGameFilter = (patch) => save(KEYS.gameFilter, sanitizeGameFilter, patch);

// Health warnings are codes (`selector:<hook>:missing`); explain the ones that stop a scan.
export function warningText(code) {
  const locale = /^locale:(.+):unsupported$/.exec(code);
  if (locale) return t('warnLocaleUnsupported', { lang: locale[1] });
  const missing = /^selector:(.+):missing$/.exec(code);
  if (missing) return t('warnSelectorMissing', { hook: missing[1] });
  if (code === 'campaigns:no-cards') return t('warnNoCards');
  if (/^gql:(campaigns|inventory):absent$/.test(code)) return t('warnGqlAbsent');
  const gql = /^gql:(\w+):unrecognized$/.exec(code);
  if (gql) return t('warnGqlUnrecognized', { op: gql[1] });
  return code;
}

/**
 * Sets the page language and strings, the round flag of the language in use on the
 * language button (#language-button), the Diagnostics button, and reloads the page when
 * the language setting changes elsewhere.
 */
export function setUpPage() {
  document.documentElement.lang = messagesLanguage;
  localize();

  // The name in the header is the wordmark (DRAGNET™, the mark in a light weight), the rest of the title stays as written.
  const title = document.querySelector('.topbar h1');
  if (title) {
    title.replaceChildren(...title.textContent.split(/(Dragnet)/).filter(Boolean)
      .flatMap((part) => (part === 'Dragnet'
        ? [el('span', { className: 'wordmark', textContent: part }), el('span', { className: 'tm', textContent: '™' })]
        : [part])));
  }

  const languageButton = $('language-button');
  if (languageButton) {
    const label = t('languageButton', { name: languageName(messagesLanguage) });
    languageButton.replaceChildren(flagIcon(messagesLanguage));
    languageButton.title = label;
    languageButton.setAttribute('aria-label', label);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[KEYS.settings]) return;
    if (sanitizeSettings(changes[KEYS.settings].newValue).language !== languageSetting) location.reload();
  });

  // The Diagnostics button, while the setting is on, with the number of saved captures.
  const diagButton = $('diag-button');
  if (diagButton) {
    const showDiagCount = (list) => {
      const n = Array.isArray(list) ? list.length : 0;
      $('diag-count').hidden = n === 0;
      $('diag-count').textContent = String(n);
    };
    const showDiagButton = (settings) => { diagButton.hidden = !sanitizeSettings(settings).diagnostics; };
    chrome.storage.sync.get(KEYS.settings).then((stored) => showDiagButton(stored[KEYS.settings]));
    chrome.storage.local.get(DIAG_KEY).then((stored) => showDiagCount(stored[DIAG_KEY]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[DIAG_KEY]) showDiagCount(changes[DIAG_KEY].newValue);
      if (area === 'sync' && changes[KEYS.settings]) showDiagButton(changes[KEYS.settings].newValue);
    });
  }
}
