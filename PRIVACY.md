# DRAGNET™ for Twitch - Privacy Policy

*Last updated October 2026.*

Dragnet™ for Twitch ("DRAGNET™") is a Chrome extension that tracks Twitch drop campaigns and your claim progress. This statement covers what it reads, where that goes, and what it does not do. 

## Summary

Dragnet collects nothing. It has no server, makes no network requests, and does not send, sell or share any data. Everything it reads stays in your browser.

## What Dragnet reads

Dragnet reads two Twitch pages while they are open in your browser: `https://www.twitch.tv/drops/campaigns` and `https://www.twitch.tv/drops/inventory`. From them it takes:

- the drop campaigns listed: game, campaign and publisher names, dates, drops and rewards, the channels where drops can be earned, and whether your game account is linked for each campaign;
- your progress on each drop, and the list of drops you have claimed, with their approximate age ("3 days ago").

It does not read your Twitch user name, email address, messages, followed channels, payment details, or other pages beyond the few channel-page details described below. It cannot see your Twitch password or session cookies.

With **Twitch page data (read only)** switched on (settings page, Danger Zone; off by default), Dragnet also reads the drops data that Twitch's own drops pages receive from Twitch's undocumented GraphQL endpoint, as the page receives it (read only): a small script in the page copies those responses (only the drops-related ones, on the drops pages and on channel pages; what it copies on channel pages is used only by Diagnostics) and hands them to Dragnet inside your browser. Dragnet sends no request of its own, and does not read the request headers, cookies or tokens. Dragnet uses it, in your browser, for exact times and progress, the full claim history, and drops or games the page reading misses. Switched off, the script is not loaded at all.

Its content script is loaded on every `www.twitch.tv` page so that it notices when you move to a drops page inside Twitch (Twitch changes pages without reloading). On other pages it watches the address and, for stall detection (on by default, settings page), reads on a channel page only: the channel name from the address, the stream's game, whether it carries Twitch's Drops Enabled tag, whether the channel shows as live or offline, and whether its video is playing (nothing else from the page or the video). Dragnet keeps that per tab in Chrome's session storage, which is emptied when the browser closes, and compares it with your drop progress to warn when Twitch stops counting watch time. Switched off, nothing is read or kept.

With the **timed inventory check** on (off by default), Dragnet opens `https://www.twitch.tv/drops/inventory` in a background tab on the timer you choose (or reloads an inventory tab you already have open), reads it as on a visit, and closes the tab it opened. With stall detection's auto-reload on (off by default), it reloads a stalled channel tab. Both are the browser loading a Twitch page as you would; Dragnet sends no request of its own.

## Where it is stored

- **Scraped data** (campaigns, progress, claimed drops, the time and outcome of the last reads) is kept in Chrome's local extension storage (`chrome.storage.local`), on this computer only. It is a copy of what the Twitch pages show and is rebuilt from them.
- **Your choices** (settings and the game filter) are kept in Chrome's sync storage (`chrome.storage.sync`). If you have Chrome sync turned on, Chrome copies them to your other computers through your Google account, as it does for any extension's settings. Dragnet itself sends nothing.

With Diagnostics switched on (settings page, Danger Zone; off by default), Dragnet also keeps sanitized copies of Twitch page markup it does not recognize in the same local storage, including, on channel pages, markup that may be Twitch's prompt to claim a drop (never the chat log, chat messages or the chat input, never the video, and with your login name replaced). With Twitch page data also on, it keeps copies of the drops data the pages received there too (on the drops pages, and the drops-related data Twitch's player loads on channel pages), with your login name, user id and display name replaced and token-like fields removed. Snapshots and exports from the Diagnostics page are saved as ordinary downloads on this computer, only when you ask for them.

Removing the extension deletes all of it. The Danger Zone on the settings page can also delete the local data, the synced choices, or both, at any time.

## Permissions

Each permission is the narrowest one that does the job, and each is used for the single purpose of tracking your Twitch drops.

| Permission | Why |
|---|---|
| Host access to `https://www.twitch.tv/*` | Read the drops pages you are logged in to (`/drops/campaigns` and `/drops/inventory`) to get the campaigns and your claim progress. On those pages Dragnet presses Twitch's own "Load more" and expand buttons to read the full lists, and presses "Claim Now" only if you switched on auto-claim (off by default). It also opens the inventory page in a tab and closes it (Full sync, timed inventory check), finds and reloads your own twitch.tv tabs, and, for stall detection, reads the few channel-page details above and reloads a stalled channel tab when you opted in. It needs no other site and sends nothing to Twitch's API or any other server. |
| `storage` | Keep your settings and game filter (`chrome.storage.sync`), the scraped campaigns and progress (`chrome.storage.local`), and short-lived per-tab state (`chrome.storage.session`). All of it stays in your browser. |
| `scripting` | Register and unregister one content script (`chrome.scripting.registerContentScripts`) that copies, read only, the data Twitch's own page already received. Registered only while **Twitch page data (read only)** is on (off by default) and removed when it is switched off. No remote code is loaded or run. |
| `alarms` | Wake the service worker for the timed inventory check and the periodic refresh, on the interval you choose. A service worker cannot keep a timer, so alarms are the only way to run on a schedule. |

The extension uses no `tabs` permission: finding and reloading your twitch.tv tabs works through the host access above.

## What it does not do

- No network requests of its own, to Twitch's undocumented API or anywhere else.
- No analytics, tracking, advertising or remote code.
- No access to other websites.

## Contact

Questions and reports: open an issue at <https://github.com/rathinosk/Dragnet-for-Twitch/issues>.
