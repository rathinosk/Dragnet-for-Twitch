// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Collector for Twitch page data, in the content script's isolated world: started by
// content.js while settings.twitchApi is on. Buffers the GQL responses scraper/gql-hook.js
// posts from the page's main world, the newest per operation and variables, size-capped,
// and cleared when the tab leaves the drops pages. Any script on the page can post a
// message, so each one is checked (core/gql.js) and only ever read as data.

import { gqlItem } from '../core/gql.js';

// Room for a details response per campaign card (about 100 on a Full sync) and the rest.
const MAX_ITEMS = 300;
const buffer = new Map();
let listening = false;

function onMessage(event) {
  if (event.source !== window || event.origin !== location.origin) return;
  const item = gqlItem(event.data);
  if (!item) return;
  const key = item.operationName + JSON.stringify(item.variables).slice(0, 500);
  buffer.delete(key);
  buffer.set(key, item);
  if (buffer.size > MAX_ITEMS) buffer.delete(buffer.keys().next().value);
}

/** Starts listening, and asks the hook for what it kept before this script loaded. */
export function startCollector() {
  if (!listening) {
    listening = true;
    window.addEventListener('message', onMessage);
  }
  window.postMessage({ source: 'dragnet-gql-replay' }, location.origin);
}

/** Stops listening and forgets what was buffered (the setting was switched off). */
export function stopCollector() {
  if (listening) window.removeEventListener('message', onMessage);
  listening = false;
  buffer.clear();
}

/** Forgets what was buffered (the tab left the drops pages). */
export function clearCollected() {
  buffer.clear();
}

/** True while the collector runs (the setting is on in this tab). */
export const collecting = () => listening;

/** @returns {{operationName: string, variables: object|null, data: object, at: number}[]} oldest first */
export function collected() {
  return [...buffer.values()];
}
