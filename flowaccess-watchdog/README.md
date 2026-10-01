# FlowAccess Watchdog

Companion extension for the main FlowAccess extension. Chrome gives an
extension no hook for its own uninstall — once removed, zero of its code
can run, so it can never wipe its own cookies afterwards. This watchdog
closes that hole.

## What it does

- Watches the main extension **by its extension ID** (never by name).
- The moment the main extension is **uninstalled or disabled**, it:
  1. Wipes the shared session cookies (scoped: `google.com`, `flow.google.com`, `gstatic.com` only — nothing else is touched).
  2. Closes every `flow.google.com` tab.
- Mutual protection: the main extension watches the watchdog back by ID —
  removing **either** extension wipes the session immediately, so no
  removal order bypasses the wipe.

## Pairing (automatic, ID-based)

No names, no manual ID entry. Each extension publishes its own
`chrome.runtime.id` as an httpOnly registry cookie on
`http://localhost:5500/` (`fa_watchdog_id` / `fa_main_id`) and reads the
other's. The ID is persisted in extension storage, so clearing cookies
does not break the pairing.

- Install this folder via `chrome://extensions` → **Load unpacked** (before
  or together with the main `extension/` folder).
- The main extension pairs within seconds and exempts the watchdog from
  its block-other-extensions enforcement. If the watchdog was briefly
  disabled before pairing, the main extension re-enables it automatically.
- Click the watchdog's toolbar icon to verify pairing status.

## Notes

- Once a watchdog ID is known, the main extension treats it as **expected**:
  cookie injection is refused while it is missing, and the dashboard shows
  "🛡️ Watchdog Required" until it is reinstalled.
- To intentionally go back to single-extension mode, use the
  "Use without watchdog" link on the dashboard (it forgets the peer ID).
  Re-installing the watchdog re-pairs it automatically.
- Disabling the watchdog on purpose still wipes the session first (by
  design) — the main extension then re-enables it to keep protection
  consistent.
