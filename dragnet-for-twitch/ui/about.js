// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// About page: the version from the manifest and the changelog (ui/changelog.js), newest
// first. Everything is set with textContent.

import { t, formatLanguage } from './i18n.js';
import { $, el, setUpPage } from './common.js';
import { CHANGELOG } from './changelog.js';

setUpPage();
$('version').textContent = t('helpVersion', { version: chrome.runtime.getManifest().version });

const dateFormat = new Intl.DateTimeFormat(formatLanguage, { dateStyle: 'long' });

function releaseDate(iso) {
  // Entries are plain YYYY-MM-DD; parse as local noon so the day does not shift with the zone.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? dateFormat.format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : '';
}

$('changelog-empty').hidden = CHANGELOG.length > 0;
$('changelog-list').replaceChildren(...CHANGELOG.map((release) => {
  const date = releaseDate(release.date);
  return el('li', { className: 'release' },
    el('h3', {},
      el('span', { textContent: `${release.version} - ${release.title}` }),
      date && el('span', { className: 'release-date', textContent: date })),
    release.notes.length
      ? el('ul', {}, ...release.notes.map((note) => el('li', { textContent: note })))
      : null);
}));
