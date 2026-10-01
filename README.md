# FlowAccess Extensions

Browser extensions for the [FlowAccess](https://github.com/hussain301/flowAccess) web app.
Both are required — the dashboard shows full protection only when both are installed and enabled.

| Extension | Folder | Version |
|---|---|---|
| FlowAccess Tool (main) | `flowaccess-tool/` | 1.3 |
| FlowAccess Watchdog (companion) | `flowaccess-watchdog/` | 1.1.0 |

## Download (recommended)

Get the ready-to-install ZIPs from the Releases page — no build step needed:

- **FlowAccess Tool:** https://github.com/hussain301/flowaccess-extension/releases/download/tool-v1.3/flowaccess-tool-v1.3.zip
- **FlowAccess Watchdog:** https://github.com/hussain301/flowaccess-extension/releases/download/watchdog-v1.1.0/flowaccess-watchdog-v1.1.0.zip

## Install (Chrome / Edge / Brave)

1. Download the ZIP above and unzip it (you get a folder with `manifest.json` inside).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. Repeat for the second extension.
6. Reload the FlowAccess dashboard — the protection badge should turn green.

## What they do

- **FlowAccess Tool** — the main extension: injects the shared Google Flow session cookies, enforces per-user daily limits, auto-pauses when you navigate away, and blocks cookie-stealer extensions.
- **FlowAccess Watchdog** — companion: Chrome gives an extension no hook for its own uninstall, so the watchdog watches the main extension by ID. The moment either extension is removed or disabled, it wipes the shared session cookies and closes Flow tabs. See `flowaccess-watchdog/README.md` for details.

## Source

Development happens in the main repo: https://github.com/hussain301/flowAccess
(`extension/` → `flowaccess-tool/`, `watchdog/` → `flowaccess-watchdog/`).
This repo is the distribution copy with installable releases.
