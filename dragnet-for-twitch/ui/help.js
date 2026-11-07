// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Help page: fills the strings from _locales, the sample badges (built from the same
// messages the list uses, so they read as they do there) and the version.

import { t } from './i18n.js';
import { $, setUpPage } from './common.js';

setUpPage();
$('sample-critical').textContent = t('hoursLeft', { count: 5 });
$('sample-soon').textContent = t('daysLeft', { count: 2 });
$('sample-later').textContent = t('daysLeft', { count: 9 });
$('sample-claimable').textContent = t('readyToClaim', { count: 1 });
$('sample-claimed').textContent = t('claimedOf', { claimed: 2, count: 5 });
$('sample-bar').firstElementChild.style.width = '40%';
$('version').textContent = t('helpVersion', { version: chrome.runtime.getManifest().version });
