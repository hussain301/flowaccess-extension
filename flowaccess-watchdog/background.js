// ============================================================
// FlowAccess Watchdog — background service worker
//
// Chrome gives an extension NO hook for its own uninstall: once it is
// removed, zero of its code can run, so it can never wipe its own
// cookies afterwards. This tiny companion extension is the fix: it
// watches the main FlowAccess extension and, when that extension is
// uninstalled OR disabled (verified via a ~6s debounced re-check, so a
// legit reload/update does not nuke a healthy session), wipes the
// shared Google/Flow session cookies and closes every Flow tab.
//
// Watching is by extension ID only (never by name). Pairing is
// automatic: each side publishes its chrome.runtime.id as an httpOnly
// registry cookie on http://localhost:5500/ and reads the other's.
// The ID is persisted in storage so a cleared cookie jar does not
// break the pairing.
// ============================================================

const REGISTRY_URL = 'http://localhost:5500/';
const PEER_COOKIE_NAME = 'fa_main_id';     // written by main, read by us
const OWN_COOKIE_NAME = 'fa_watchdog_id'; // written by us, read by main
const EXT_ID_RE = /^[a-p]{32}$/;
const WIPE_DOMAIN_SUFFIXES = ['google.com', 'flow.google.com', 'gstatic.com'];

let peerMainId = null;

// ---------- ID pairing ----------
async function publishOwnId() {
    try {
        // NOTE: chrome.cookies.set() resolves to null (it does NOT throw)
        // when the write is refused — so the result must be checked.
        const res = await chrome.cookies.set({
            url: REGISTRY_URL,
            name: OWN_COOKIE_NAME,
            value: chrome.runtime.id,
            httpOnly: true,
            expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600
        });
        if (!res) {
            console.warn('[Watchdog] registry publish FAILED — cookies.set returned null (write refused).');
        } else {
            console.log('[Watchdog] Published own ID to registry cookie.');
        }
    } catch (e) {
        console.warn('[Watchdog] registry publish FAILED with exception:', e && e.message ? e.message : e);
    }
}

async function syncPeerId() {
    try {
        const c = await chrome.cookies.get({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
        if (c && c.value && EXT_ID_RE.test(c.value)) {
            peerMainId = c.value;
            try { await chrome.storage.local.set({ faPeerMainId: c.value }); } catch (e) {
                console.warn('[Watchdog] Could not persist peer ID:', e && e.message ? e.message : e);
            }
            return peerMainId;
        }
    } catch (e) {
        console.warn('[Watchdog] registry cookie read FAILED:', e && e.message ? e.message : e);
    }
    try {
        const s = await chrome.storage.local.get(['faPeerMainId']);
        if (s.faPeerMainId) peerMainId = s.faPeerMainId;
    } catch (e) {}
    return peerMainId;
}

// ---------- scoped cookie wipe (mirrors the main extension) ----------
function isWipeableCookie(cookie) {
    const d = (cookie.domain || '').toLowerCase().replace(/^\./, '');
    return WIPE_DOMAIN_SUFFIXES.some(suffix => d === suffix || d.endsWith('.' + suffix));
}

function removeOneCookie(cookie) {
    return new Promise((resolve) => {
        try {
            const protocol = cookie.secure ? 'https:' : 'http:';
            const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
            const url = `${protocol}//${domain}${cookie.path || '/'}`;
            chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }, () => resolve());
        } catch (e) { resolve(); }
    });
}

async function wipeFlowCookies() {
    console.warn('[Watchdog] Wiping Flow/Google cookies (scoped)...');
    try {
        const all = await chrome.cookies.getAll({});
        const targets = (all || []).filter(isWipeableCookie);
        await Promise.all(targets.map(removeOneCookie));
        console.log(`[Watchdog] Removed ${targets.length} Flow/Google cookies.`);
    } catch (e) {
        console.warn('[Watchdog] Scoped wipe error:', e);
    }
}

async function closeFlowTabs() {
    try {
        const tabs = await chrome.tabs.query({ url: '*://flow.google.com/*' });
        for (const t of tabs) {
            try { await chrome.tabs.remove(t.id); } catch (e) {}
        }
        console.log(`[Watchdog] Closed ${(tabs || []).length} Flow tab(s).`);
    } catch (e) {}
}

// ---------- the actual protection ----------
async function handleMainGone(how) {
    console.warn(`[Watchdog] Main extension ${how} — wiping shared session now.`);
    await wipeFlowCookies();
    await closeFlowTabs();
}

// ---------- wiring ----------
async function init() {
    await publishOwnId();
    await syncPeerId();
    console.log('[Watchdog] FlowAccess Watchdog initialized, peer:', peerMainId || '(not paired yet)');
}

if (chrome.management) {
    // ---------- debounced wipe (CRITICAL) ----------
    // A legitimate main-extension reload/update fires onDisabled /
    // onUninstalled transiently — wiping immediately would nuke a healthy
    // session ("Flow opened then closed"). So we never wipe on the event
    // itself: we record it, wait ~6 seconds, then re-check with
    // chrome.management.get(). Only if the peer is STILL gone (disabled,
    // or get throws = truly uninstalled) do we wipe + close tabs.
    const RECHECK_ALARM = 'fa-main-recheck';
    const RECHECK_DELAY_MIN = 0.1; // ~6 seconds

    async function recheckMainNow(peerId, kind) {
        let gone = false;
        let disabled = false;
        try {
            const info = await chrome.management.get(peerId);
            disabled = !!(info && info.enabled === false);
        } catch (e) {
            gone = true; // get() throws => truly uninstalled
        }
        if (gone || disabled) {
            console.warn(`[Watchdog] Confirmed: main extension ${kind} and still gone — wiping now.`);
            await handleMainGone(kind);
        } else {
            console.log('[Watchdog] Main extension is back — no wipe (was a reload/update).');
        }
        try { await chrome.storage.local.remove('faPendingMainCheck'); } catch (e) {}
    }

    async function scheduleMainRecheck(peerId, kind) {
        try {
            await chrome.storage.local.set({ faPendingMainCheck: { peerId, kind, at: Date.now() } });
            await chrome.alarms.create(RECHECK_ALARM, { delayInMinutes: RECHECK_DELAY_MIN });
            console.log(`[Watchdog] Main extension ${kind} — re-checking in ~6s before wiping.`);
        } catch (e) {
            // Alarms unavailable: fall back to an immediate synchronous check.
            console.warn('[Watchdog] Could not schedule re-check, checking now:', e && e.message ? e.message : e);
            await recheckMainNow(peerId, kind);
        }
    }

    if (chrome.alarms && chrome.alarms.onAlarm) {
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (!alarm || alarm.name !== RECHECK_ALARM) return;
            chrome.storage.local.get(['faPendingMainCheck']).then(s => {
                const p = s.faPendingMainCheck;
                if (p && p.peerId) {
                    recheckMainNow(p.peerId, p.kind || 'gone');
                } else {
                    console.log('[Watchdog] Re-check alarm fired with no pending event — ignoring.');
                }
            }).catch((e) => console.warn('[Watchdog] Re-check read failed:', e && e.message ? e.message : e));
        });
    }

    // onUninstalled only passes the id (the extension is already gone),
    // so compare against the stored peer ID — never by name.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            const check = (storedId) => {
                if (id === peerMainId || id === storedId) scheduleMainRecheck(id, 'uninstalled');
            };
            try {
                chrome.storage.local.get(['faPeerMainId']).then(s => check(s.faPeerMainId)).catch(() => check(null));
            } catch (e) { check(null); }
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            const check = (storedId) => {
                if (info.id === peerMainId || info.id === storedId) scheduleMainRecheck(info.id, 'disabled');
            };
            try {
                chrome.storage.local.get(['faPeerMainId']).then(s => check(s.faPeerMainId)).catch(() => check(null));
            } catch (e) { check(null); }
        });
    }
    // Re-pair if the main extension is reinstalled (possibly a new ID),
    // and re-publish our own ID so the main side can pair no matter
    // which extension was installed first.
    if (chrome.management.onInstalled) {
        chrome.management.onInstalled.addListener(() => {
            publishOwnId().then(() => syncPeerId()).catch(() => {});
        });
    }
    if (chrome.management.onEnabled) {
        chrome.management.onEnabled.addListener(() => {
            publishOwnId().then(() => syncPeerId()).catch(() => {});
        });
    }
}

// Re-publish our ID on lifecycle events: a fresh install or browser
// restart must re-publish even if the one-shot top-level init() publish
// was lost when the service worker was terminated mid-await.
if (chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
        publishOwnId().catch((e) => console.warn('[Watchdog] onInstalled re-publish failed:', e && e.message ? e.message : e));
    });
}
if (chrome.runtime && chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
        publishOwnId().then(() => syncPeerId()).catch((e) => console.warn('[Watchdog] onStartup re-publish failed:', e && e.message ? e.message : e));
    });
}

init().catch(() => {});
