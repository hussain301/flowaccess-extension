// ============================================================
// FlowAccess Extension — Background Service Worker
// Handles: Cookie injection, tab management, session control
// ============================================================

// Peer-ID registry: both extensions publish their own chrome.runtime.id
// as an httpOnly cookie on http://localhost:5500/ and read the other's.
// Watching is done purely by extension ID — never by name.
const REGISTRY_URL = 'http://localhost:5500/';
const PEER_COOKIE_NAME = 'fa_watchdog_id'; // written by the watchdog, read by us
const OWN_COOKIE_NAME = 'fa_main_id';      // written by us, read by the watchdog
const EXT_ID_RE = /^[a-p]{32}$/;

// ========================
// 1. COOKIE INJECTION (single implementation)
// ========================

/**
 * Normalize one cookie object into chrome.cookies.set details.
 * Returns null when the cookie entry is invalid.
 */
function toCookieDetails(c) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return null;
    if (c.name.length === 0 || c.name.length > 256) return null;

    let cookieDomain = typeof c.domain === 'string' && c.domain ? c.domain : '.google.com';
    if (c.hostOnly) {
        // Host-only cookie: no leading dot, exact host match
        if (cookieDomain.startsWith('.')) cookieDomain = cookieDomain.slice(1);
    } else if (!cookieDomain.startsWith('.')) {
        cookieDomain = '.' + cookieDomain;
    }

    const host = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const url = `https://${host}${typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'}`;

    const details = {
        url,
        name: c.name,
        value: c.value,
        domain: cookieDomain,
        path: typeof c.path === 'string' && c.path ? c.path : '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: (() => {
            const s = String(c.sameSite || '').toLowerCase();
            if (s === 'none') return 'no_restriction'; // chrome.cookies.set rejects 'none'
            return (['no_restriction', 'lax', 'strict'].includes(s)) ? s : 'lax';
        })()
    };

    if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
        details.expirationDate = c.expirationDate;
    }

    // CHIPS (partitioned) cookies: preserve the partition key when the
    // stored cookie has one — otherwise Google receives a different
    // cookie than the session was captured with.
    if (c.partitionKey && typeof c.partitionKey.topLevelSite === 'string' && c.partitionKey.topLevelSite) {
        details.partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    }

    return details;
}

// Drop duplicate (name, domain, path) entries from the incoming set —
// keep the LAST occurrence. A captured set can contain the same cookie
// twice with different values; injecting both leaves an order-dependent
// mix, which is exactly what triggers Google's CookieMismatch page.
function dedupeCookies(cookies) {
    const seen = new Map();
    for (const c of (Array.isArray(cookies) ? cookies : [])) {
        if (!c || typeof c.name !== 'string') continue;
        const d = String(c.domain || '.google.com').toLowerCase().replace(/^\./, '');
        const p = typeof c.path === 'string' && c.path ? c.path : '/';
        seen.set(`${c.name}\n${d}\n${p}`, c);
    }
    return [...seen.values()];
}

// Index an incoming cookie set by name+domain+path -> value, for the
// value-aware backup below.
function indexCookieValues(cookies) {
    const map = new Map();
    for (const c of dedupeCookies(cookies)) {
        const d = String(c.domain || '.google.com').toLowerCase().replace(/^\./, '');
        const p = typeof c.path === 'string' && c.path ? c.path : '/';
        map.set(`${c.name}\n${d}\n${p}`, String(c.value));
    }
    return map;
}

/**
 * Set a list of cookies. Returns { injected, failed }.
 */
async function setCookieList(cookies) {
    // Same-profile safety: snapshot the user's own Google cookies and
    // clear them first, so the injected shared session never mixes with
    // (or destroys) the user's own login — that mix is what triggers
    // Google's CookieMismatch page.
    await backupAndClearGoogleCookies(cookies);
    let injected = 0, failed = 0;
    const failedNames = [];
    const injectedDetails = [];
    const list = dedupeCookies(cookies).slice(0, 500);
    for (const c of list) {
        try {
            const details = toCookieDetails(c);
            if (!details) { failed++; continue; }
            // chrome.cookies.set resolves to null (no throw) when the
            // browser refuses the cookie — only count truthy results.
            let setResult = await chrome.cookies.set(details);
            if (!setResult) {
                // One retry — a cold cookie store can refuse the first set.
                try { setResult = await chrome.cookies.set(details); } catch (e) {}
            }
            if (setResult) {
                injected++;
                injectedDetails.push({ name: details.name, url: details.url });
            } else {
                failed++;
                failedNames.push(`${details.name}@${details.domain}`);
            }
        } catch (err) {
            console.warn(`[FlowAccess] Cookie set error for ${c && c.name}:`, err);
            failed++;
            failedNames.push(`${c && c.name}@?`);
        }
    }
    if (failedNames.length) console.warn('[FlowAccess] Refused cookies:', failedNames.slice(0, 20).join(', '));
    // Single write — tracks exactly the cookies of this injection.
    await resetInjectedCookies(injectedDetails);
    console.log(`[FlowAccess] Injected ${injected} cookies, ${failed} failed`);
    // Session (re)start: one-time sweep — close already-open Google tabs so
    // the shared session can't be used outside Flow.
    if (injected > 0) {
        try { await closeOpenGoogleTabs(); } catch (e) {}
    }
    return { injected, failed };
}

// ========================
// 2b. INJECTED-COOKIE TRACKING + TARGETED WIPE
// ========================
// We remember exactly which cookies we injected (name + url), so the
// away-wipe removes ONLY those — the user's own cookies are never touched.
const FA_INJECTED_KEY = 'faInjectedCookies';
const FA_AWAY_WIPE_KEY = 'faAwayWipe';

async function getInjectedCookies() {
    try {
        const r = await chrome.storage.local.get([FA_INJECTED_KEY]);
        return Array.isArray(r[FA_INJECTED_KEY]) ? r[FA_INJECTED_KEY] : [];
    } catch (e) { return []; }
}

// Replace the tracked set (used after a fresh full injection).
async function resetInjectedCookies(list) {
    try {
        await chrome.storage.local.set({ [FA_INJECTED_KEY]: Array.isArray(list) ? list : [] });
    } catch (e) {}
}

// Remove ONLY the cookies we injected. Returns the count removed.
// Sets the faAwayWipe flag so the dashboard can auto-pause immediately.
async function wipeInjectedCookies() {
    const list = await getInjectedCookies();
    if (!list.length) return 0;
    let removed = 0;
    for (const c of list) {
        try {
            if (c && c.name && c.url) {
                await chrome.cookies.remove({ url: c.url, name: c.name });
                removed++;
            }
        } catch (e) {}
    }
    try {
        await chrome.storage.local.remove([FA_INJECTED_KEY]);
        await chrome.storage.local.set({ [FA_AWAY_WIPE_KEY]: { at: Date.now(), removed } });
    } catch (e) {}
    console.log(`[FlowAccess] Away-wipe: removed ${removed}/${list.length} injected cookies`);
    return removed;
}

// ========================
// 2c. USER COOKIE BACKUP & RESTORE (same-profile safety)
// ========================
// The shared session is injected on .google.com — in a profile where the
// user is signed into their OWN Google account this would overwrite their
// cookies, and the later wipe would destroy them. The resulting
// half-admin/half-user cookie jar is exactly what makes Google show
// accounts.google.com/CookieMismatch. So before the first injection we
// snapshot every Google/Flow cookie, clear them for a clean consistent
// jar, and the full wipe restores the user's own cookies afterwards.
const FA_COOKIE_BACKUP_KEY = 'faGoogleCookieBackup';
const FA_COOKIE_BACKUP_VERSION = 1;

// Backup envelope: { v, cookies }. Backups written by older code (a bare
// array, no version) are treated as ABSENT — they may contain admin
// residue laundered as "user cookies" by the pre-value-aware code, and
// restoring them is exactly what produced CookieMismatch.
async function getCookieBackup() {
    try {
        const r = await chrome.storage.local.get([FA_COOKIE_BACKUP_KEY]);
        const b = r[FA_COOKIE_BACKUP_KEY];
        if (b && typeof b === 'object' && !Array.isArray(b) && b.v === FA_COOKIE_BACKUP_VERSION && Array.isArray(b.cookies)) {
            return b;
        }
        return { v: FA_COOKIE_BACKUP_VERSION, cookies: [] };
    } catch (e) { return { v: FA_COOKIE_BACKUP_VERSION, cookies: [] }; }
}

// Re-create chrome.cookies.set details from a chrome.cookies.getAll result.
function cookieToSetDetails(cookie) {
    const domain = cookie.domain || '';
    const host = domain.startsWith('.') ? domain.slice(1) : domain;
    const url = `${cookie.secure ? 'https:' : 'http:'}//${host}${cookie.path || '/'}`;
    const details = {
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite || 'lax',
    };
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0) {
        details.expirationDate = cookie.expirationDate;
    }
    return details;
}

// ========================
// COMPLETE GOOGLE SCOPE (backup + wipe coverage)
// ========================
// A Google login does not live on google.com alone — the SAME cookie names
// (SID/HSID/SSID/APISID/SAPISID...) also exist on youtube.com,
// googleapis.com, gmail.com, google.<country> etc. Only handling
// google.com left those other domains as a half-admin/half-user mix, which
// is exactly what kept producing CookieMismatch. The scope below covers
// every Google-owned domain, plus any domain present in the cookie set
// being injected (derived per injection).
const GOOGLE_DOMAIN_SUFFIXES = [
    'google.com', // also covers accounts.google.com, flow.google.com, ...
    'youtube.com',
    'youtu.be',
    'googleapis.com',
    'gstatic.com',
    'googleusercontent.com',
    'gmail.com',
    'googlemail.com',
    'googlevideo.com',
    'ggpht.com',
];

// google.<country>: google.co.uk, google.com.pk, google.de, ...
function isGoogleCcTld(d) {
    return /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(d);
}

// Domains touched by the incoming cookie set, plus their parents — a
// host-only accounts.google.com cookie also pulls in the .google.com
// scope whose cookies are sent to that host.
function scopeSuffixesFor(cookies) {
    const set = new Set(GOOGLE_DOMAIN_SUFFIXES);
    for (const c of (Array.isArray(cookies) ? cookies : [])) {
        let d = String((c && c.domain) || '').toLowerCase().replace(/^\./, '');
        if (!d) d = 'google.com';
        const parts = d.split('.');
        for (let i = 0; i < parts.length - 1; i++) set.add(parts.slice(i).join('.'));
    }
    return set;
}

function isScopedCookie(cookie, scope) {
    const d = String((cookie && cookie.domain) || '').toLowerCase().replace(/^\./, '');
    if (!d) return false;
    if (isGoogleCcTld(d)) return true;
    for (const s of scope) { if (d === s || d.endsWith('.' + s)) return true; }
    return false;
}

// Remove every in-scope cookie, then VERIFY the jar is actually clean
// (up to 3 passes). Returns the number of cookies that resisted removal.
async function clearScopedCookies(scope, why) {
    let lastTargets = [];
    for (let pass = 1; pass <= 3; pass++) {
        let all = [];
        try { all = await chrome.cookies.getAll({}) || []; } catch (e) { break; }
        const targets = all.filter(c => isScopedCookie(c, scope));
        if (!targets.length) {
            if (pass > 1 || lastTargets.length) console.log(`[FlowAccess] ${why}: jar clean (pass ${pass}).`);
            return 0;
        }
        lastTargets = targets;
        await Promise.all(targets.map(removeOneCookie));
    }
    let rest = [];
    try { rest = (await chrome.cookies.getAll({}) || []).filter(c => isScopedCookie(c, scope)); } catch (e) {}
    if (rest.length) console.warn(`[FlowAccess] ${why}: ${rest.length} cookies resisted wipe:`,
        rest.map(c => `${c.name}@${c.domain}`).join(', '));
    return rest.length;
}

// COMPLETE backup + wipe BEFORE injecting the shared session:
// 1. Decide whether the live jar currently holds OUR injected session
//    (browser died mid-session → crash recovery) or the USER's own
//    cookies (normal case).
// 2a. Crash recovery: keep the stored versioned backup — it holds the
//     user's real cookies from before that session.
// 2b. Normal case: DISCARD any stored backup (a leftover from older code
//     may be poisoned with admin residue — keeping it blindly is what
//     caused CookieMismatch) and snapshot the live jar, excluding our
//     own residue by value.
// 3. Wipe the complete scope and VERIFY it is empty.
// 4. Only then inject the new cookies into a clean jar.
async function backupAndClearGoogleCookies(cookies) {
    const scope = scopeSuffixesFor(cookies);
    const incomingValues = indexCookieValues(cookies);
    let all = [];
    try { all = await chrome.cookies.getAll({}) || []; } catch (e) { all = []; }
    const scoped = all.filter(c => isScopedCookie(c, scope));

    // Does the live jar currently hold OUR injected session? Compare the
    // scoped jar against the incoming set: in a crashed session every
    // comparable cookie matches; in a user jar (different Google
    // session) essentially none do. The two worlds are far apart, so a
    // 90% threshold is safe against a single rotated cookie.
    let comparable = 0, matching = 0;
    for (const c of scoped) {
        const d = String(c.domain || '').toLowerCase().replace(/^\./, '');
        const p = c.path || '/';
        const key = `${c.name}\n${d}\n${p}`;
        if (incomingValues.has(key)) {
            comparable++;
            if (incomingValues.get(key) === String(c.value)) matching++;
        }
    }
    const jarHoldsOurSession = comparable >= 5 && (matching / comparable) >= 0.9;

    const existing = await getCookieBackup();
    if (existing.cookies.length && jarHoldsOurSession) {
        console.log('[FlowAccess] Jar holds our injected session (crash recovery) — keeping the stored user backup.');
    } else {
        if (existing.cookies.length) {
            console.log('[FlowAccess] Discarding stale backup — live jar holds the user\'s own cookies, taking a fresh snapshot.');
        }
        // A jar cookie matching an incoming cookie on name+domain+path
        // WITH THE SAME VALUE is leftover from a previous injection — not
        // the user's cookie — so it is excluded from the backup (the wipe
        // below deletes it). A same-key cookie with a DIFFERENT value is
        // the user's own login and IS backed up. This makes the flow
        // fully automatic: no manual cookie deletion is ever needed and
        // the user never notices anything.
        const targets = scoped.filter(c => {
            const d = String(c.domain || '').toLowerCase().replace(/^\./, '');
            const p = c.path || '/';
            const key = `${c.name}\n${d}\n${p}`;
            if (incomingValues.has(key) && incomingValues.get(key) === String(c.value)) return false;
            return true;
        });
        const backup = { v: FA_COOKIE_BACKUP_VERSION, cookies: targets.map(cookieToSetDetails) };
        try {
            await chrome.storage.local.set({ [FA_COOKIE_BACKUP_KEY]: backup });
            console.log(`[FlowAccess] Backed up ${backup.cookies.length} user cookies (complete Google scope).`);
        } catch (e) {
            console.warn('[FlowAccess] Could not store cookie backup:', e);
            return;
        }
    }
    const leftover = await clearScopedCookies(scope, 'pre-inject clear');
    if (leftover) console.warn(`[FlowAccess] ${leftover} cookies still present after pre-inject clear.`);
}

// Restore the user's own Google/Flow cookies after the full wipe, then
// drop the backup so the next session takes a fresh snapshot.
async function restoreGoogleCookies() {
    const stored = await getCookieBackup();
    const backup = stored.cookies || [];
    if (!backup.length) return 0;
    let restored = 0;
    for (const details of backup) {
        try {
            const res = await chrome.cookies.set(details);
            if (res) restored++;
        } catch (e) {}
    }
    try { await chrome.storage.local.remove([FA_COOKIE_BACKUP_KEY]); } catch (e) {}
    console.log(`[FlowAccess] Restored ${restored}/${backup.length} backed-up cookies.`);
    return restored;
}

/**
 * Parse an endpoint JSON body into a cookie array.
 * Handles: { cookies: [...] }, { cookies: "<json string>" }, [...]
 */
function parseEndpointCookies(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.cookies)) return data.cookies;
    if (data && typeof data.cookies === 'string') {
        const parsed = JSON.parse(data.cookies);
        if (Array.isArray(parsed)) return parsed;
    }
    throw new Error('Unknown cookie format in response');
}

// ========================
// 2. MESSAGE HANDLING
// ========================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only accept messages from our own extension contexts
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ success: false, error: 'Unauthorized sender' });
        return false;
    }

    // Cookie injection request from website (via content script bridge)
    if (request.action === 'INJECT_COOKIES') {
        (async () => {
            try {
                // Refuse while the watchdog is expected but missing — otherwise
                // removing the watchdog would silently drop the protection.
                if (!(await injectionAllowed())) {
                    sendResponse({ success: false, error: 'FlowAccess Pro missing — injection refused' });
                    return;
                }
                const { injected, failed } = await setCookieList(request.cookies);
                console.log('[FlowAccess] DEBUG INJECT_COOKIES received cookies:', request.cookies);
                // No auto-open: the user opens Flow from the dashboard
                // (saved project / New Project button). Injection only.
                const tabId = null;
                if (injected === 0) {
                    sendResponse({ success: false, injected, failed, tabId,
                        error: `0 of ${(request.cookies || []).length} cookies injected — cookie data invalid or rejected by the browser` });
                } else {
                    sendResponse({ success: true, injected, failed, tabId });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // Fetch cookies from endpoint URL, inject them, and open Flow
    if (request.action === 'FETCH_AND_INJECT') {
        const endpointUrl = request.endpointUrl;
        if (typeof endpointUrl !== 'string' || !/^https:\/\//i.test(endpointUrl)) {
            sendResponse({ success: false, error: 'Invalid endpoint URL' });
            return false;
        }
        console.log('[FlowAccess] Fetching cookies from endpoint');

        (async () => {
            try {
                if (!(await injectionAllowed())) {
                    sendResponse({ success: false, error: 'FlowAccess Pro missing — injection refused' });
                    return;
                }
                const resp = await (async () => {
                    // Hard timeout: a dead/hanging endpoint must never leave
                    // the dashboard stuck on "Injecting access...".
                    const ctrl = new AbortController();
                    const fetchTimer = setTimeout(() => ctrl.abort(), 15000);
                    try {
                        return await fetch(endpointUrl, { signal: ctrl.signal });
                    } catch (err) {
                        if (err && err.name === 'AbortError') {
                            throw new Error('Cookie endpoint timed out after 15s — check the URL in admin panel');
                        }
                        throw err;
                    } finally {
                        clearTimeout(fetchTimer);
                    }
                })();
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();

                const cookies = parseEndpointCookies(data);
                console.log(`[FlowAccess] Got ${cookies.length} cookies from endpoint`);
                console.log('[FlowAccess] DEBUG FETCH_AND_INJECT raw endpoint response:', data);
                console.log('[FlowAccess] DEBUG FETCH_AND_INJECT parsed cookies:', cookies);

                const { injected, failed } = await setCookieList(cookies);

                // No auto-open: the user opens Flow from the dashboard
                // (saved project / New Project button). Injection only.
                let tabId = null;

                if (injected === 0) {
                    sendResponse({ success: false, injected, failed, total: cookies.length, tabId,
                        debugCookies: cookies, debugRaw: data,
                        error: `0 of ${cookies.length} cookies injected — check the endpoint response format` });
                } else {
                    sendResponse({ success: true, injected, failed, total: cookies.length, tabId,
                        debugCookies: cookies, debugRaw: data });
                }
            } catch (err) {
                console.error('[FlowAccess] FETCH_AND_INJECT error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true;
    }

    // Forget the paired watchdog and return to single-extension mode
    // (used from the dashboard when the watchdog was removed on purpose).
    // The 10-year registry cookie must go too, otherwise syncPeerId would
    // re-pair instantly; the faPeerForgotten tombstone blocks adoption
    // until a genuine watchdog reinstall re-arms it (see onInstalled).
    if (request.action === 'UNPAIR_PEER') {
        peerWatchdogId = null;
        (async () => {
            try {
                await chrome.cookies.remove({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
            } catch (e) {
                console.warn('[FlowAccess] UNPAIR_PEER cookie remove failed:', e);
            }
            try {
                await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']);
                await chrome.storage.local.set({ faPeerForgotten: true });
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false });
            }
        })();
        return true;
    }

    // Extension presence check (+ watchdog protection status for the dashboard)
    if (request.action === 'PING') {
        // MV3 setInterval is unreliable when the service worker is suspended;
        // the dashboard PINGs every ~10s, so use it as the enforcement heartbeat.
        enforceCookieCopierDenylist().catch(() => {});
        (async () => {
            try {
                const wd = await getWatchdogStatus();
                sendResponse({
                    installed: true,
                    version: chrome.runtime.getManifest().version,
                    watchdogExpected: wd.expected,
                    watchdogAlive: wd.alive
                });
            } catch (e) {
                sendResponse({ installed: true, version: chrome.runtime.getManifest().version, watchdogExpected: false, watchdogAlive: false });
            }
        })();
        return true;
    }

    // Wipe Flow/Google cookies (scoped — never touches other sites' cookies)
    if (request.action === 'WIPE_COOKIES') {
        wipeFlowCookies().then(() => sendResponse({ success: true }));
        return true;
    }

    // Dashboard poll: are the injected cookies still intact? (away-wipe
    // clears the tracked list, so a wipe shows up as intact:false.)
    if (request.action === 'GET_INJECTED_STATE') {
        (async () => {
            const list = await getInjectedCookies();
            sendResponse({ success: true, intact: list.length > 0, count: list.length });
        })();
        return true;
    }

    // Website asks: is the user signed into Google in THIS browser profile?
    // Read-only check — used to advise a fresh Chrome profile before sessions.
    if (request.action === 'CHECK_GOOGLE_LOGIN') {
        (async () => {
            try {
                const injected = await getInjectedCookies();
                const cookies = await chrome.cookies.getAll({ domain: '.google.com' });
                const loginNames = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'];
                const loggedIn = cookies.some(c => loginNames.includes(c.name) && c.value);
                sendResponse({ success: true, loggedIn, sessionActive: injected.length > 0 });
            } catch (err) {
                sendResponse({ success: false, error: err && err.message ? err.message : 'check failed' });
            }
        })();
        return true;
    }

    // Dashboard acknowledges the away-wipe push — clear the one-shot flag.
    if (request.action === 'CLEAR_AWAY_WIPE') {
        (async () => {
            try { await chrome.storage.local.remove([FA_AWAY_WIPE_KEY]); } catch (e) {}
            sendResponse({ success: true });
        })();
        return true;
    }

    // Close all Flow tabs (for pause/expire)
    if (request.action === 'CLOSE_FLOW_TAB') {
        closeFlowTabs();
        sendResponse({ success: true });
        return false;
    }

    // Stop Flow — wipe Flow cookies AND close Flow tabs
    if (request.action === 'STOP_FLOW') {
        (async () => {
            await wipeFlowCookies();
            closeFlowTabs();
            sendResponse({ success: true });
        })();
        return true;
    }

    // ---- Project history (3 entries, deduped) ----
    if (request.action === 'PROJECT_SAVE') {
        (async () => {
            try {
                const url = request.url;
                if (typeof url !== 'string' || !/^https:\/\/flow\.google\.com\/project\//i.test(url)) {
                    sendResponse({ success: false, error: 'Not a Flow project URL' });
                    return;
                }
                sendResponse(await saveProjectToHistory(url, request.name));
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
    if (request.action === 'PROJECT_LIST') {
        (async () => {
            try { sendResponse({ success: true, projects: await getProjectHistory() }); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }
    if (request.action === 'PROJECT_REMOVE') {
        (async () => {
            try { sendResponse(await removeProjectFromHistory(request.url)); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }
    if (request.action === 'PROJECT_CLEAR') {
        (async () => {
            try { sendResponse(await clearProjectHistory()); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }

    // Open the projects side panel (from the floating launcher on Flow pages)
    if (request.action === 'OPEN_SIDE_PANEL') {
        (async () => {
            try {
                let tabId = sender && sender.tab ? sender.tab.id : undefined;
                if (tabId === undefined) {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tabs && tabs[0]) tabId = tabs[0].id;
                }
                if (tabId === undefined) throw new Error('No tab to open the panel on');
                await chrome.sidePanel.open({ tabId });
                sendResponse({ success: true });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    sendResponse({ success: false, error: 'Unknown action' });
    return false;
});

// Hostname-exact Flow URL matching — a substring check would also match
// lookalike hosts (e.g. flow.google.com.evil.com).
function isFlowUrl(u) {
    try { return new URL(u).hostname === 'flow.google.com'; }
    catch (e) { return false; }
}

function closeFlowTabs() {
    chrome.tabs.query({}, (tabs) => {
        if (!tabs) return;
        tabs.forEach(tab => {
            if (tab.url && isFlowUrl(tab.url)) {
                chrome.tabs.remove(tab.id).catch(() => {});
            }
        });
    });
}

// ========================
// 2b. PROJECT HISTORY (max 3, event-driven dedup)
// ========================
// Single source of truth for saved Flow projects. Every save is
// deduplicated by project ID: re-saving moves the entry to the front
// instead of creating a duplicate. Capped at 3 entries (newest first) —
// a 4th project cannot be saved until one is removed.
const PROJECT_HISTORY_KEY = 'faProjectHistory';
const PROJECT_HISTORY_MAX = 3;

function projectIdOf(url) {
    try {
        const m = String(url).match(/\/project\/([a-zA-Z0-9_\-]+)/i);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

function cleanProjectUrl(url) {
    try {
        const p = new URL(url);
        const m = p.pathname.match(/\/project\/[a-zA-Z0-9_\-]+/i);
        return m ? `${p.origin}${m[0]}` : url;
    } catch (e) { return url; }
}

async function getProjectHistory() {
    let list = [];
    try {
        const r = await chrome.storage.local.get([PROJECT_HISTORY_KEY, 'faSavedProjects']);
        if (Array.isArray(r[PROJECT_HISTORY_KEY])) {
            list = r[PROJECT_HISTORY_KEY];
        } else if (Array.isArray(r.faSavedProjects) && r.faSavedProjects.length) {
            // One-time migration from the legacy max-3 URL list
            list = r.faSavedProjects
                .map(u => ({ url: cleanProjectUrl(u), name: projectIdOf(u) || String(u), savedAt: Date.now() }))
                .filter(p => projectIdOf(p.url));
            await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: list });
        }
    } catch (e) {}
    // Enforce the 3-project cap on read too (drops any pre-cap extras).
    return (Array.isArray(list) ? list : []).slice(0, PROJECT_HISTORY_MAX);
}

async function saveProjectToHistory(url, name) {
    const clean = cleanProjectUrl(url);
    const id = projectIdOf(clean);
    if (!id) return { success: false, error: 'Not a Flow project URL' };
    const list = await getProjectHistory();
    const already = list.some(p => projectIdOf(p.url) === id);
    const next = list.filter(p => projectIdOf(p.url) !== id);
    // Hard cap: a NEW project cannot be saved while 3 are already saved.
    // Re-saving an existing one (moves to front) is always allowed.
    if (!already && next.length >= PROJECT_HISTORY_MAX) {
        return { success: false, error: 'PROJECT_LIMIT_REACHED', projects: list };
    }
    const label = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : id;
    next.unshift({ url: clean, name: label, savedAt: Date.now() });
    const trimmed = next.slice(0, PROJECT_HISTORY_MAX);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: trimmed });
    return { success: true, projects: trimmed, added: !already };
}

async function removeProjectFromHistory(url) {
    const id = projectIdOf(url);
    const list = await getProjectHistory();
    const next = id ? list.filter(p => projectIdOf(p.url) !== id) : list.filter(p => p.url !== url);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: next });
    return { success: true, projects: next };
}

async function clearProjectHistory() {
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: [] });
    return { success: true, projects: [] };
}

// ========================
// 3. AWAY-WIPE (no tab blocking)
// ========================
// Normal browsing stays fully open — no tab is ever closed for visiting
// another site. The only automatic reaction: when any tab navigates to a
// real website other than Flow while we hold injected cookies, ONLY those
// injected cookies are wiped (nothing else is touched). The dashboard
// notices the missing cookies and auto-pauses the session.

// Hosts where an active session may live. Everything else counts as "away".
const FA_ALLOWED_HOSTS = ['flow.google.com'];

function isAwayUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false; // ignore chrome://, about:, etc.
    try {
        return !FA_ALLOWED_HOSTS.includes(new URL(url).hostname.toLowerCase());
    } catch (e) {
        return false;
    }
}

async function handleTabNavigation(url) {
    if (!isAwayUrl(url)) return;
    await wipeInjectedCookies(); // no-op when nothing was injected
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = (tab && (tab.url || tab.pendingUrl)) || (changeInfo && changeInfo.url);
    handleTabNavigation(url).catch(() => {});

    if (url && isFlowUrl(url)) {
        enforceSingleFlowTab();
    }
});

chrome.tabs.onCreated.addListener((tab) => {
    if (tab) {
        const url = tab.url || tab.pendingUrl;
        handleTabNavigation(url).catch(() => {});
    }
});

// ========================
// 3b. GOOGLE TAB GUARD
// ========================
// The injected session must never be usable outside Flow. Two rules:
//
// 1. On every injection — i.e. when the user starts/resumes a session —
//    already-open Google tabs are CLOSED (one-time sweep).
// 2. Afterwards, the away-wipe above already wipes the injected cookies the
//    moment any tab navigates to a Google domain (google.com !=
//    flow.google.com, so it counts as "away").
//
// flow.google.com is the session host and is never treated as "Google".

function isGoogleDomainTab(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        const h = new URL(url).hostname.toLowerCase();
        if (h === 'flow.google.com') return false;
        return h === 'google.com' || h.endsWith('.google.com');
    } catch (e) { return false; }
}

// One-time sweep on session resume: close Google tabs so the shared session
// can't be used outside Flow. The user's own cookies are untouched — only
// the tabs are closed.
async function closeOpenGoogleTabs() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return 0; }
    let closed = 0;
    for (const t of tabs || []) {
        if (t && t.id != null && isGoogleDomainTab(t.url)) {
            try { await chrome.tabs.remove(t.id); closed++; } catch (e) {}
        }
    }
    if (closed) console.log(`[FlowAccess] Closed ${closed} Google tab(s) on session resume`);
    return closed;
}

// ========================
// 4. SINGLE FLOW TAB
// ========================

// Race-safe: instead of removing the tab that triggered the check,
// keep the newest Flow tab (highest tab id) and remove the older
// duplicates — deterministic no matter which update fired first.
function enforceSingleFlowTab() {
    chrome.tabs.query({}, (tabs) => {
        const flowTabs = (tabs || []).filter(t => t.url && isFlowUrl(t.url));

        if (flowTabs.length <= 1) return;

        flowTabs.sort((a, b) => b.id - a.id);
        const keep = flowTabs[0];
        for (let i = 1; i < flowTabs.length; i++) {
            chrome.tabs.remove(flowTabs[i].id).catch(() => {});
        }
        chrome.tabs.update(keep.id, { active: true }).catch(() => {});
        if (keep.windowId) {
            chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
        }
        console.log('[FlowAccess] Duplicate Flow tabs closed, kept newest');
    });
}

// ========================
// 5. COMPLETE COOKIE WIPE (Session End)
// ========================
// Removes the shared session across the COMPLETE Google scope —
// anything the injection may have touched. Other sites' cookies and
// unrelated tabs are never touched.

function removeOneCookie(cookie) {
    return new Promise((resolve) => {
        try {
            const protocol = cookie.secure ? 'https:' : 'http:';
            const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
            const url = `${protocol}//${domain}${cookie.path || '/'}`;
            chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

async function wipeFlowCookies() {
    console.warn('[FlowAccess] Wiping Google/Flow cookies (complete scope)...');
    const scope = scopeSuffixesFor([]);
    const leftover = await clearScopedCookies(scope, 'session wipe');
    console.log(`[FlowAccess] Session wipe done (${leftover} leftover).`);
    // Bring the user's own Google login back (backed up before injection).
    try { await restoreGoogleCookies(); } catch (e) {
        console.warn('[FlowAccess] Cookie restore error:', e);
    }
    // NOTE: unrelated tabs are intentionally NOT reloaded.
}

console.log('[FlowAccess] Background service worker initialized');

// ========================
// 6. COOKIE-COPIER DENYLIST (only these are blocked)
// ========================
// Every other extension is left completely alone — the browser behaves
// like a normal one. ONLY extensions whose job is copying/exporting
// cookies stay blocked, because they could steal the injected session.
// IDs verified against the Chrome Web Store listings.
const COOKIE_COPY_DENYLIST = new Set([
    'fngmhnnpilhplaeedifhccceomclgfbg', // EditThisCookie
    'hlkenndednhfkekhgcdicdfddnkalmdm', // Cookie-Editor (Moustachauve)
    'iphcomljdfghbkdcfndaijbokpgddeno', // Cookie Editor (HotCleaner)
    'mhelhppllnfkpaboohnijkfjeclehgab', // Open Cookie Editor
    'ookdjilphngeeeghgngjabigmpepanpl', // Cookie Editor (thanhbui28)
]);
const SELF_DISABLE_GUARD_MS = 15000;

// IDs we disabled ourselves, persisted in chrome.storage.local under
// 'faSelfDisabled' as { id: timestamp }. The peer-gone handlers must
// ignore these — a disable performed by our own enforcement is not
// tampering and must never nuke the session. Persisted (not in-memory)
// so a service-worker restart between our disable and the management
// event cannot lose the guard.
const SELF_DISABLED_KEY = 'faSelfDisabled';

async function markSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        map[id] = Date.now();
        await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map });
    } catch (e) {}
}

async function clearSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        if (map[id]) { delete map[id]; await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map }); }
    } catch (e) {}
}

// Reads the persisted guard; prunes entries older than SELF_DISABLE_GUARD_MS.
async function wasSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        const t = map[id];
        if (!t) return false;
        if (Date.now() - t > SELF_DISABLE_GUARD_MS) {
            delete map[id];
            try { await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map }); } catch (e) {}
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// The guard record is written BEFORE setEnabled runs, so the onDisabled
// event — which may fire before the callback — is already covered.
async function disableExtension(id, reason) {
    await markSelfDisabled(id);
    return new Promise((resolve) => {
        chrome.management.setEnabled(id, false, () => {
            if (chrome.runtime.lastError) {
                console.log(`[FlowAccess] Could not disable (${reason}):`, chrome.runtime.lastError.message);
                clearSelfDisabled(id).then(() => resolve(false)); // didn't happen — don't guard it
            } else {
                console.log(`[FlowAccess] Disabled extension (${reason}): ${id}`);
                resolve(true);
            }
        });
    });
}

async function enforceCookieCopierDenylist() {
    if (!chrome.management) return;
    const myId = chrome.runtime.id;
    let extensions = [];
    try {
        extensions = await new Promise((resolve) => {
            try { chrome.management.getAll((list) => resolve(list || [])); }
            catch (e) { resolve([]); }
        });
    } catch (e) { return; }
    for (const ext of extensions) {
        if (!ext || ext.id === myId) continue;
        if (!COOKIE_COPY_DENYLIST.has(ext.id)) continue; // everything else is allowed
        if (!ext.enabled) continue;
        await disableExtension(ext.id, 'cookie copier denylist');
    }
}

enforceCookieCopierDenylist().catch(() => {});
setInterval(() => enforceCookieCopierDenylist().catch(() => {}), 30000);

if (chrome.management && chrome.management.onEnabled) {
    chrome.management.onEnabled.addListener((ext) => {
        if (!ext || ext.id === chrome.runtime.id) return;
        if (!COOKIE_COPY_DENYLIST.has(ext.id)) return; // everything else is allowed
        disableExtension(ext.id, 'cookie copier re-enabled').catch(() => {});
    });
}


if (chrome.management && chrome.management.onInstalled) {
    chrome.management.onInstalled.addListener((ext) => {
        if (!ext || ext.id === chrome.runtime.id) return;
        (async () => {
            // Selective tombstone clear (with retries): the watchdog's service
            // worker publishes its ID asynchronously after install, so the
            // registry cookie may not exist on the first read. Only a valid
            // EXT_ID_RE registry ID re-arms pairing — random extensions don't.
            for (let i = 0; i < 10; i++) {
                let regId = null;
                try { regId = await readPeerIdFromRegistry(); } catch (e) {}
                if (regId && EXT_ID_RE.test(regId)) {
                    try {
                        const t = await chrome.storage.local.get(['faPeerForgotten']);
                        if (t.faPeerForgotten) {
                            await chrome.storage.local.remove(['faPeerForgotten']);
                            console.log('[FlowAccess] Watchdog reinstall detected — pairing re-armed');
                        }
                    } catch (e) {}
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            // Pair eagerly with a (re)installed watchdog.
            try {
                await syncPeerIdWithRetry(6, 400);
                if (ext.id === peerWatchdogId) {
                    console.log('[FlowAccess] Watchdog paired:', ext.id);
                }
            } catch (e) {}
        })();
    });
}

console.log('[FlowAccess] All protections initialized');

// ========================
// 7. WATCHDOG (mutual protection) — ID-BASED
// ========================
// The watchdog is a tiny companion extension. Chrome gives an extension
// no hook for its own uninstall, so the watchdog wipes our cookies when
// WE are removed. Symmetrically, we watch the watchdog: if it is ever
// removed/disabled, we wipe the session immediately. Either removal
// order ends wiped — no bypass.
//
// Pairing is by extension ID only (never by name): each side publishes
// its chrome.runtime.id as an httpOnly registry cookie and reads the
// other's. The ID is persisted in storage so a cleared cookie jar does
// not break the pairing.
//
// Once a watchdog ID is known it is EXPECTED: cookie injection is
// refused while it is missing (see injectionAllowed), and the dashboard
// blocks Start/Resume until it is reinstalled. UNPAIR_PEER (from the
// dashboard) forgets it and returns to single-extension mode.
let peerWatchdogId = null;

async function publishOwnId() {
    try {
        await chrome.cookies.set({
            url: REGISTRY_URL,
            name: OWN_COOKIE_NAME,
            value: chrome.runtime.id,
            httpOnly: true,
            expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600
        });
    } catch (e) {
        console.warn('[FlowAccess] publishOwnId failed:', e);
    }
}

async function readPeerIdFromRegistry() {
    try {
        const c = await chrome.cookies.get({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
        if (c && c.value && EXT_ID_RE.test(c.value)) return c.value;
    } catch (e) {
        console.warn('[FlowAccess] readPeerIdFromRegistry failed:', e);
    }
    return null;
}

// Adopt a peer ID: persist it and rescue the watchdog if it is disabled
// (e.g. it was installed while we had not paired yet).
async function adoptPeerId(id) {
    peerWatchdogId = id;
    try { await chrome.storage.local.set({ faPeerWatchdogId: id, faWatchdogExpected: true }); } catch (e) {}
    try {
        const info = await chrome.management.get(id);
        if (info && !info.enabled) {
            await chrome.management.setEnabled(id, true);
            console.log('[FlowAccess] Watchdog rescued (re-enabled):', id);
        }
    } catch (e) {}
}

// Persisted self-disable record (storage key `faSelfDisabled`, written by
// enforcement): ids we disabled ourselves. Shape-tolerant: object map
// id->timestamp/true, or an array of ids. Numeric timestamps must be
// recent (5 min) — a stale record must never resurrect a watchdog the
// user disabled deliberately long ago.
const SELF_DISABLE_RECORD_MAX_AGE_MS = 5 * 60 * 1000;
async function selfDisableRecordExists(id) {
    if (await wasSelfDisabled(id)) return true; // persisted guard (survives SW restarts)
    try {
        const r = await chrome.storage.local.get(['faSelfDisabled']);
        const rec = r.faSelfDisabled;
        if (!rec || !id) return false;
        if (Array.isArray(rec)) return rec.includes(id);
        if (typeof rec === 'object') {
            const v = rec[id];
            if (v === undefined || v === null || v === false) return false;
            if (typeof v === 'number') return (Date.now() - v) < SELF_DISABLE_RECORD_MAX_AGE_MS;
            return true;
        }
    } catch (e) {}
    return false;
}

async function clearSelfDisableRecord(id) {
    try {
        const r = await chrome.storage.local.get(['faSelfDisabled']);
        const rec = r.faSelfDisabled;
        if (Array.isArray(rec)) {
            const next = rec.filter(x => x !== id);
            if (next.length !== rec.length) await chrome.storage.local.set({ faSelfDisabled: next });
        } else if (rec && typeof rec === 'object' && rec[id] !== undefined) {
            delete rec[id];
            await chrome.storage.local.set({ faSelfDisabled: rec });
        }
    } catch (e) {}
}

// Rescue decoupled from adoption: runs on every syncPeerId() when a valid
// registry ID exists. Re-enables the watchdog ONLY when it is disabled
// because OUR enforcement disabled it (self-disable record present) —
// the registry cookie is ground truth that this ID is the genuine
// watchdog, so the earlier disable was a pairing-race mistake. A watchdog
// disabled by anyone else is left alone (the tamper path handles it).
async function ensurePeerEnabled(id) {
    if (!id || !EXT_ID_RE.test(id)) return;
    try {
        const info = await chrome.management.get(id);
        if (!info || info.enabled) return;
        const selfDisabled = await selfDisableRecordExists(id);
        if (!selfDisabled) return;
        await chrome.management.setEnabled(id, true);
        console.log('[FlowAccess] Watchdog re-enabled (was self-disabled):', id);
        await clearSelfDisableRecord(id);
    } catch (e) {
        console.warn('[FlowAccess] ensurePeerEnabled failed:', e);
    }
}

async function syncPeerId() {
    // Tombstone: the user chose single-extension mode — never re-pair.
    try {
        const t = await chrome.storage.local.get(['faPeerForgotten']);
        if (t.faPeerForgotten) { peerWatchdogId = null; return null; }
    } catch (e) {}
    const fromRegistry = await readPeerIdFromRegistry();
    if (fromRegistry) {
        if (fromRegistry !== peerWatchdogId) {
            await adoptPeerId(fromRegistry);
        } else {
            // Already paired: still verify it wasn't wrongly disabled by us.
            await ensurePeerEnabled(fromRegistry).catch(() => {});
        }
        return peerWatchdogId;
    }
    // Registry cookie missing (e.g. cleared cookies) — fall back to storage,
    // but only for a well-formed ID of an extension that still exists.
    try {
        const s = await chrome.storage.local.get(['faPeerWatchdogId', 'faWatchdogId']);
        const stored = s.faPeerWatchdogId || s.faWatchdogId || null;
        if (stored && EXT_ID_RE.test(stored)) {
            try {
                await chrome.management.get(stored); // throws when the extension is gone
                peerWatchdogId = stored;
                if (!s.faPeerWatchdogId) {
                    try { await chrome.storage.local.set({ faPeerWatchdogId: stored }); } catch (e) {}
                }
            } catch (e) {
                // Ghost ID: the extension is no longer installed — drop the pairing.
                console.warn('[FlowAccess] Dropping ghost watchdog ID:', stored);
                peerWatchdogId = null;
                try { await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']); } catch (e2) {}
            }
        } else if (stored) {
            // Malformed stored ID — drop it too.
            console.warn('[FlowAccess] Dropping malformed stored watchdog ID');
            peerWatchdogId = null;
            try { await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']); } catch (e2) {}
        }
    } catch (e) {}
    return peerWatchdogId;
}

async function syncPeerIdWithRetry(tries, delayMs) {
    for (let i = 0; i < tries; i++) {
        const fromRegistry = await readPeerIdFromRegistry();
        if (fromRegistry) { await adoptPeerId(fromRegistry); return peerWatchdogId; }
        await new Promise(r => setTimeout(r, delayMs));
    }
    return syncPeerId();
}

async function getWatchdogStatus() {
    try {
        // Unconditional sync: PING must never report a stale in-memory ID.
        const id = await syncPeerId();
        if (!id) return { expected: false, alive: false };
        try {
            const info = await chrome.management.get(id);
            if (info && info.enabled) return { expected: true, alive: true };
        } catch (e) { /* peer gone from management */ }
        return { expected: true, alive: false };
    } catch (e) {
        return { expected: false, alive: false };
    }
}

async function injectionAllowed() {
    const wd = await getWatchdogStatus();
    return !(wd.expected && !wd.alive);
}

async function handleWatchdogGone(how) {
    console.warn(`[FlowAccess] Watchdog ${how} — wiping shared session now.`);
    try { await wipeFlowCookies(); } catch (e) {}
    try { closeFlowTabs(); } catch (e) {}
    // NOTE: the peer ID stays stored (EXPECTED) — injection remains
    // refused and the dashboard keeps showing "Watchdog Required" until
    // the watchdog is reinstalled (or UNPAIR_PEER is used).
}

async function initWatchdogProtection() {
    await publishOwnId().catch(() => {});
    await syncPeerId().catch(() => {});
}

async function getStoredPeerId() {
    try {
        const s = await chrome.storage.local.get(['faPeerWatchdogId']);
        return s.faPeerWatchdogId || null;
    } catch (e) { return null; }
}

// Peer-gone handling is DEBOUNCED: a legitimate extension reload fires
// onDisabled/onUninstalled transiently, so we never wipe immediately.
// Instead we schedule a re-check alarm; only if the peer is STILL gone
// when the alarm fires do we wipe the session.
const PEER_RECHECK_ALARM = 'fa-peer-recheck';
const PEER_EVENT_KEY = 'faPeerGoneEvent'; // { id, kind, at } persisted for the alarm

async function schedulePeerRecheck(id, kind) {
    try {
        await chrome.storage.local.set({ [PEER_EVENT_KEY]: { id, kind, at: Date.now() } });
        await chrome.alarms.create(PEER_RECHECK_ALARM, { delayInMinutes: 0.1 });
        console.log(`[FlowAccess] Peer ${kind} — re-check scheduled`);
    } catch (e) {
        console.warn('[FlowAccess] Could not schedule peer re-check:', e);
    }
}

if (chrome.management) {
    // onUninstalled only passes the id (the extension is already gone),
    // so compare against the stored peer ID.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            (async () => {
                const storedId = await getStoredPeerId();
                if (id !== peerWatchdogId && id !== storedId) return;
                // Ignore events caused by our own enforcement (section 6).
                if (await wasSelfDisabled(id)) {
                    console.log('[FlowAccess] Ignoring self-inflicted peer event:', id);
                    return;
                }
                schedulePeerRecheck(id, 'removed');
            })();
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            (async () => {
                const storedId = await getStoredPeerId();
                if (info.id !== peerWatchdogId && info.id !== storedId) return;
                // Ignore disables performed by our own enforcement (section 6) —
                // those are not tampering and must not nuke the session.
                if (await wasSelfDisabled(info.id)) {
                    console.log('[FlowAccess] Ignoring self-inflicted disable:', info.id);
                    return;
                }
                schedulePeerRecheck(info.id, 'disabled');
            })();
        });
    }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== PEER_RECHECK_ALARM) return;
        (async () => {
            let evt = null;
            try {
                const s = await chrome.storage.local.get([PEER_EVENT_KEY]);
                evt = s[PEER_EVENT_KEY] || null;
                await chrome.storage.local.remove([PEER_EVENT_KEY]);
            } catch (e) {}
            if (!evt || !evt.id) return;
            // Our own enforcement disabled it in the meantime — not tampering.
            if (await wasSelfDisabled(evt.id)) {
                console.log('[FlowAccess] Peer re-check: self-disable, skipping wipe:', evt.id);
                return;
            }
            // Still the expected peer? (It may have been unpaired since.)
            const stillPeer = (evt.id === peerWatchdogId) || (evt.id === await getStoredPeerId());
            if (!stillPeer) return;
            try {
                const info = await chrome.management.get(evt.id);
                if (info && info.enabled) {
                    console.log('[FlowAccess] Peer re-check: peer is back/enabled, no wipe.');
                    return;
                }
            } catch (e) {
                // management.get throws when the extension is uninstalled —
                // fall through to the wipe.
            }
            await handleWatchdogGone(evt.kind === 'removed' ? 'removed' : 'disabled');
        })();
    });
}

initWatchdogProtection().catch(() => {});
console.log('[FlowAccess] Watchdog protection initialized');
