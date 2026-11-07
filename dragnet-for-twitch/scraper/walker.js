// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// DOM timing helpers for the live page: wait for a condition, wait for a subtree to stop
// changing, and open an accordion section. No layout or scroll-until-stable helper yet:
// the campaigns page renders all cards at load (test/README.md).

/**
 * Resolves with the first truthy value of `check()`, re-run on every DOM mutation, or with
 * null after `timeout` ms. Attribute changes count only with `attributes: true`.
 * @template T
 * @param {() => T} check
 * @param {{root?: Node, timeout?: number, attributes?: boolean}} [options]
 * @returns {Promise<T|null>}
 */
export function waitFor(check, { root = document.documentElement, timeout = 15000, attributes = false } = {}) {
  return new Promise((resolve) => {
    const first = check();
    if (first) return resolve(first);
    const observer = new MutationObserver(() => {
      const value = check();
      if (value) finish(value);
    });
    const timer = setTimeout(() => finish(null), timeout);
    function finish(value) {
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    }
    observer.observe(root, { childList: true, subtree: true, attributes });
  });
}

/**
 * Resolves true once `root` has had no mutations for `quiet` ms, or false after `timeout`.
 * @param {Node} root
 * @param {{quiet?: number, timeout?: number}} [options]
 * @returns {Promise<boolean>}
 */
export function settle(root, { quiet = 150, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let quietTimer = setTimeout(() => finish(true), quiet);
    const timer = setTimeout(() => finish(false), timeout);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quiet);
    });
    function finish(value) {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(timer);
      resolve(value);
    }
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

/**
 * Opens an accordion button (unless it is already open), waits for `isReady()` and for the
 * page to settle. Expansion is async on Twitch: the body mounts 0.3 to 2 s after the click.
 * @param {HTMLElement} button  element with aria-expanded
 * @param {() => boolean} isReady
 * @param {{container?: Node, timeout?: number, quiet?: number}} [options]  container: subtree
 *   to settle; quiet: ms without mutations that count as settled
 * @returns {Promise<boolean>} false if the content never appeared
 */
export async function expand(button, isReady, { container = document.body, timeout = 5000, quiet = 150 } = {}) {
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
  if (!(await waitFor(isReady, { timeout }))) return false;
  await settle(container, { quiet });
  return true;
}
