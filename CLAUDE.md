# Lock & Scroll

Single-file vanilla-JavaScript PWA for automotive locksmiths. The entire app —
HTML, CSS, and JS — lives in `index.html` (~26k lines). No build step, no npm,
no framework. `service-worker.js` provides cache-first offline support.

## Version bumps — REQUIRED on every change

Any change to `index.html` or `service-worker.js` MUST bump both version
numbers in the same commit:

1. **Display version** — three identical `v###` strings in `index.html`
   (bump all three by 1, keep them in sync):
   - header badge: grep `Lock & Scroll <small`
   - Settings → App Updates: grep `Current: v`
   - Settings → About footer: grep `Lock & Scroll v1`
2. **Service worker cache** — `CACHE_NAME = 'lockscroll-v###'` at the top of
   `service-worker.js` (bump by 1). Without this, installed PWAs keep serving
   the old cached app and never see the change.

## Conventions

- Global `let` state + global functions with inline `onclick="fn(...)"`;
  UI renders via innerHTML template strings. Panels/modals toggle the `on`
  CSS class; `goHome()` must close any new panel/modal you add.
- Persistence: IndexedDB key-value rows via `saveToIndexedDB(key, value)` /
  `loadFromIndexedDB(key)`. Every new data store must be wired in ALL of:
  a `saveX()` fn, `loadLocalData()`, both Firebase sync payloads in
  `uploadToCloud()`, the merge in `downloadFromCloud()`, and
  `exportData()`/`importData()`. Mirror how `jobHistory` is threaded through.
- `stockData` (key stock by PN) is per-user and deliberately excluded from
  shared sync; most other stores are shared.
- Escape user text with `escapeJobText()` before injecting into innerHTML, and
  escape quotes (`.replace(/'/g, "\\'")`) inside inline onclick args.

## Verifying changes

Syntax check: extract the big inline `<script>` block and run `node --check`.
End-to-end: serve the folder (`python3 -m http.server`) and drive the app with
Playwright using `executablePath: '/opt/pw-browsers/chromium'`; app globals
(`DB`, `getUniqueVehicles`, panel functions) are directly callable via
`page.evaluate`. Ignore console errors from the Firebase CDN when offline —
they also occur on main.
