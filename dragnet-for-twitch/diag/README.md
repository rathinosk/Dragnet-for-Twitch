# Diagnostics

Troubleshooting tools that ship with the extension, off by default. They are switched on by the user with **Diagnostics** in the Danger Zone at the bottom of the settings page (`settings.diagnostics` in `chrome.storage.sync`). The page itself is English only, not in `_locales`; the switch, its hint and the button's tooltip are localized.

While the setting is off: the button is hidden, the scraper does not load `watch.js` (no captures, no live watch), and a Twitch tab refuses probe and snapshot requests. Switching it off stops a running live watch at once. The page still opens (from a bookmark), says the setting is off, and can still list and download what was saved earlier.

## Checks and scenarios

The Diagnostics switch is the master switch. Under it, each automatic check has its own toggle at the top of the diagnostics page (sync key `diagChecks`, `{id: boolean}`, sanitized by `sanitizeDiagChecks` in `core/schema.js`; a missing check is on, so the default is everything on). The watchers read it before doing any work, and the stream watcher and the live watch follow a change at once, without a tab reload; the drops-page checks apply from the next scan.

| Check | What it switches |
| --- | --- |
| `dropsMarkup` | the drops-page watcher (`recordAnomalies`: claim-button, claim-like, full-bar, block) |
| `liveWatch` | the inventory live watch; its mode select (`diagLiveWatch`) sits under it |
| `gqlDrops` | Twitch data saved on the drops pages (also needs Twitch page data) |
| `streamClaim`, `streamDropUi`, `streamToast` | the stream watcher's three kinds (`findStreamAnomalies(root, kinds)`); with all three off it starts no observer |
| `streamStuck` | a channel page that was playing a drops stream and for 5 minutes (`STUCK_MINUTES`) is not: saves one `stream:stuck` capture per spell (`stuckTick` in `watch.js`, `stuckReason` / `stuckStep` in `core/stall.js`). "Was playing" is a marker in the tab's sessionStorage (`dragnet:streamGood` = channel), so it survives a reload; an offline channel never counts |
| `gqlStream` | Twitch data saved on channel pages, once a minute (also needs Twitch page data) |
| `stallPanel` | the stall panel on the diagnostics page (below) |

A **Scenario** dropdown sets the toggles in one go (`DIAG_PRESETS`, `presetChecks`, `presetOf`); only the toggles are stored, and any set that matches no preset shows as Custom:

- Quiet: all off (manual tools only).
- Claim prompt on stream: `streamClaim`, `streamDropUi`, `streamToast`, `gqlStream`.
- Auto-claim on the inventory: `dropsMarkup`, `liveWatch` (and the live watch mode becomes Watch page changes if it was Off).
- Stalled progress: `stallPanel`, `gqlStream`.
- Stuck after reload: `streamStuck`, `stallPanel`, `gqlStream`.
- Twitch data shapes: `gqlDrops`, `gqlStream`.
- Everything (default): all on.

Probe, Snapshot and the downloads only run when clicked, so they have no toggle.

**Stall panel** (`stallPanel`): a read-only section showing stall detection's state from session storage (`watchTabs`, `stallState`, `stalls`) and local `progressTrack`: per channel tab reporting what it plays, its channel, game, drops-enabled and playing (or "channel offline" when the channel is not streaming), how long it has counted as watching (`goodSince`) and any auto-reloads; per tracked drop of that game its value, reads, last rise, minutes without a rise and the time left to `STALL_MINUTES` (or why it does not count: account not connected, other channels only, or waiting, with the channel offline named as the reason). Refreshed on storage changes and once a minute.

## What it does

- **Diagnostics page** (`diagnostics.html`), opened from the pulse button beside the filter button in the popup and the full page. For each open Twitch drops tab:
  - **Probe:** runs the parsers on the page as it is, without clicking, and shows what they see (self-check, warnings, progress rows and whether each is claimable, claim count, earned rewards, card counts), plus what the watcher below would save.
  - **Snapshot / Snapshot expanded:** the same sanitized capture as `tools/capture-snapshot.js` (the console tool stays), downloaded as `<page>-<label>.html` and `.facts.json`. The label field names the files (for example `claimable`, `after-claim`). It waits for a running Dragnet scan to finish first.
  - **Download stored data:** everything in `chrome.storage.local` and `sync`, as JSON.
- **Live watch** (a setting on the page, sync key `diagLiveWatch`): after an inventory scan, keeps watching the open tab and checks again 2 s after the page changes; optionally reloads the tab every 5 or 15 minutes. A label at the bottom left of the Twitch page shows it is on. Off by default (mode Off); it also needs its `liveWatch` check.
- **Twitch data**: with **Twitch page data** also on (Danger Zone), each drops-page scan saves the drops-related GQL responses the page received (`recordGql` in `watch.js`, from `scraper/gql.js`), scrubbed (`scrubGql` in `core/gql.js`: the viewer's login, id and display name become USER, token-like keys REDACTED): the newest per page, operation and variables, up to 250 entries and about 6 MB (trimming drops the oldest repeat of an operation first), saved before the scan is reported (a Full sync closes or moves the tab after), under `diagGql` in `chrome.storage.local`. The page lists them and downloads one or all as JSON.
- **Twitch channel tabs**: the page also lists open channel tabs, with **Probe stream** (what stall detection's watch state reads, the stream hooks found, and what the stream watcher would save) and **Snapshot stream** (the player column, the chat input bar and the toast area, sanitized, without the chat log, messages or input). A hint says how to capture the on-stream claim prompt: keep Diagnostics on, watch a drops-enabled stream until a drop reaches 100%, and click nothing.
- **Stream watcher** (`watchStream` in `watch.js`): on any other twitch.tv page, `scraper/content.js` starts a MutationObserver on the whole page (toasts and the player overlay are outside `<main>`; checks at most once a second, ignoring the chat log) that saves `stream:claim-like` (a control labelled "claim" other than channel points' "Claim Bonus", or one matching a guessed hook in `STREAM_CLAIM_GUESSES`, `scraper/selectors.js`), `stream:drop-ui` (elements whose `data-test-selector` or `data-a-target` mentions drops, not "dropdown", once per distinct set) and `stream:toast` (a toast, alert or status region that mentions a drop or reward). Captures stop at a small container, never include the chat log, messages or input (`stripChat` in `capture.js`; the chat input bar is kept because it holds the Drops & More button), drop the video, scrub the login, and record the URL as `/<channel>`. With Twitch page data also on, the drops operations Twitch's player sends on the channel page (the hook copies them there too) are saved to `diagGql` with page `stream`, at most once a minute. The saved-markup list can be filtered to drops pages or channel pages.
- **Watcher** (`watch.js`): on every inventory visit (before the scan, so before auto-claim could click) and after every campaigns scan, it saves a sanitized copy of markup the scraper does not know yet: a "Claim Now" button, any other button or link labelled "claim", a progress bar at 100% with no claim button, and each in-progress campaign block once per distinct set of buttons. Each case is saved once (by key), the newest 40 kept, under `diagCaptures` in `chrome.storage.local`. The button's red count shows how many are saved.

## Where it is wired in

- `core/schema.js`: `SETTINGS.diagnostics`, `DIAG_KEY`, `DIAG_LIVE_KEY`, `DIAG_LIVE_MODES`, `DIAG_GQL_KEY`, `DIAG_CHECKS_KEY`, `DIAG_CHECKS`, `DIAG_PRESETS`, `STREAM_KINDS` and their helpers.
- `scraper/run.js`: `diagWatch` (reads the settings and checks before importing `watch.js`) and its calls (`gql` also needs `twitchApi`).
- `scraper/content.js`: the `dragnet:diag` message listener (checks the setting first; actions `probe`, `capture`, `probe-stream`, `capture-stream`), and the stream watcher on non-drops pages.
- `manifest.json`: `diag/capture.js` and `diag/watch.js` in `web_accessible_resources`.
- `ui/popup.html`, `ui/page.html`: the `diag-button` link; `ui/common.js` shows it and its count; `ui/dragnet.css`: `.diag-btn` / `.diag-count`.
- `ui/settings.html`, `ui/settings.js`: the switch, in the Danger Zone beside the delete buttons.

The delete buttons there clear `diagCaptures` and `diagGql` with the rest of local data, and `diagLiveWatch` and `diagChecks` with the rest of sync.
