// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// UI strings. Messages live in _locales/<lang>/messages.json (Chrome's own extension i18n:
// Chrome picks the browser's UI language, falls back to default_locale "en", and the store
// listing and manifest use the same files). This adds what chrome.i18n lacks:
// - named placeholders, "{count} campaigns", filled from an object (Chrome's own
//   $placeholders$ are not used, so a message's text is all a translator edits);
// - plurals: t('key', {count}) looks up `key_one`, `key_few`, ... by Intl.PluralRules for
//   the language of the messages Chrome picked (each messages.json names it in `localeCode`,
//   since a Chrome UI language without a locale falls back to English), then `key_other`,
//   then `key`;
// - localize(root): fills elements marked data-i18n (textContent), data-i18n-title and
//   data-i18n-aria-label and data-i18n-placeholder;
// - the language setting: chrome.i18n always answers in Chrome's own pick, so a chosen
//   language's messages.json is fetched here (top-level await) and looked up first.
// createTranslator() takes the messages directly, so the test harness can check
// messages.json without chrome.*.

import { KEYS, sanitizeSettings } from '../core/schema.js';

/**
 * @param {(key: string) => string} lookup  message text for a key, '' if missing
 * @param {string} lang  BCP 47 tag for plural rules
 */
export function createTranslator(lookup, lang) {
  const plural = new Intl.PluralRules(validLanguage(lang));
  return function t(key, values = {}) {
    let message = '';
    if (Number.isFinite(values.count)) {
      message = lookup(`${key}_${plural.select(values.count)}`) || lookup(`${key}_other`);
    }
    message ||= lookup(key);
    if (!message) {
      console.warn('[Dragnet] missing message', key);
      return key;
    }
    return message.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(values, name) ? String(values[name]) : m));
  };
}

/** `lang` if Intl accepts it ("en-US@posix" from some systems does not), else "en". */
export function validLanguage(lang) {
  try {
    return Intl.getCanonicalLocales(lang || 'en')[0] ?? 'en';
  } catch {
    return 'en';
  }
}

const chromeLookup = (key) => {
  try {
    return chrome.i18n.getMessage(key);
  } catch {
    return '';
  }
};

/** The language setting: 'auto' or a _locales folder name. */
export const languageSetting = await readLanguageSetting();
const chosen = languageSetting === 'auto' ? null : await fetchMessages(languageSetting);
const lookup = chosen ? (key) => chosen[key]?.message || chromeLookup(key) : chromeLookup;

async function readLanguageSetting() {
  try {
    const { [KEYS.settings]: raw } = await chrome.storage.sync.get(KEYS.settings);
    return sanitizeSettings(raw).language;
  } catch {
    return 'auto'; // not an extension page (the test harness)
  }
}

/** A _locales folder's messages.json, or null. */
export async function fetchMessages(locale) {
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Chrome's UI language. */
export const uiLanguage = validLanguage(globalThis.chrome?.i18n?.getUILanguage?.() || navigator.language);
/** Language of the messages Chrome itself picks (what the 'auto' setting shows). */
export const autoLanguage = validLanguage(chromeLookup('localeCode') || uiLanguage);
/** Language of the messages in use: plural forms and the page's lang. */
export const messagesLanguage = validLanguage(lookup('localeCode') || uiLanguage);
/**
 * Dates and relative times sit inside messages, so they follow the messages' language; the UI
 * language only when it is the same language (keeping its region, such as en-GB dates).
 */
export const formatLanguage = primary(uiLanguage) === primary(messagesLanguage) ? uiLanguage : messagesLanguage;

function primary(lang) {
  return lang.split('-')[0].toLowerCase();
}

export const t = createTranslator(lookup, messagesLanguage);

/** A language's own name for itself ("Deutsch", "日本語"), capitalized. */
export function languageName(lang) {
  const tag = validLanguage(lang);
  let name = tag;
  try {
    name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) || tag;
  } catch {
    // Intl without DisplayNames: the tag itself
  }
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}

/** A _locales folder name as a BCP 47 tag (pt_BR -> pt-BR). */
export const localeTag = (folder) => validLanguage(folder.replace('_', '-'));

/** Fills data-i18n, data-i18n-title, data-i18n-aria-label and data-i18n-placeholder under `root`. */
export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
