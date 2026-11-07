// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// The About page's changelog, newest first. English only, like release notes: adding a release
// is one entry at the top. `date` is ISO (YYYY-MM-DD) or '' until the release is dated; `notes`
// are plain text lines (the page renders them with textContent).

export const CHANGELOG = Object.freeze([
  { version: '1.0.0', date: '', title: 'Initial Release', notes: [] },
]);
