// ============================================================
// FlowAccess Extension — Content Script (All URLs)
// Injected on every page at document_start
// Handles: Extension presence beacon, hardened website
//          communication bridge, away-wipe event forwarding
// ============================================================

(() => {

    // ========================
    // 1. EXTENSION PRESENCE BEACON
    // ========================

    // document_start can fire before <html> exists — a blind beacon write
    // here would throw and kill this whole content script (no beacon AND
    // no bridge). Wait for documentElement if it isn't there yet.
    function setBeacon() {
        try {
            const el = document.documentElement;
            if (!el) return false;
            el.dataset.flowAccessExtension = 'true';
            el.dataset.flowAccessVersion = chrome.runtime.getManifest().version;
            window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
                detail: { version: chrome.runtime.getManifest().version }
            }));
            return true;
        } catch (e) { return false; }
    }

    if (!setBeacon()) {
        const mo = new MutationObserver(() => { if (setBeacon()) mo.disconnect(); });
        mo.observe(document, { childList: true, subtree: true });
        setTimeout(() => mo.disconnect(), 10000); // safety
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
                detail: { version: chrome.runtime.getManifest().version }
            }));
        });
    }

    // ========================
    // 2. HARDENED WEBSITE BRIDGE
    // ========================
    // Only the configured FlowAccess dashboard origin may drive the
    // extension. Actions are allowlisted and payloads validated so a
    // malicious page cannot trigger privileged operations.

    const ALLOWED_ACTIONS = new Set([
        'PING',
        'INJECT_COOKIES',
        'FETCH_AND_INJECT',
        'WIPE_COOKIES',
        'GET_INJECTED_STATE',
        'CHECK_GOOGLE_LOGIN',
        'CLEAR_AWAY_WIPE',
        'CLOSE_FLOW_TAB',
        'STOP_FLOW',
        'GET_SAVED_PROJECTS',
        'REMOVE_SAVED_PROJECT',
        'PROJECT_SAVE',
        'PROJECT_LIST',
        'PROJECT_REMOVE',
        'PROJECT_CLEAR',
        'OPEN_SIDE_PANEL',
        'UNPAIR_PEER'
    ]);

    // Away-wipe push: when the background wipes the injected cookies
    // (user navigated away from Flow), it sets the faAwayWipe flag.
    // Forward it to the page immediately so the dashboard auto-pauses.
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.faAwayWipe || !changes.faAwayWipe.newValue) return;
            window.postMessage({ source: 'FLOW_ACCESS_EVENT', event: 'AWAY_WIPE' }, '*');
        });
    } catch (e) {}

    // Site access: the extension always trusts the production website plus
    // the local dev server. Stored dashboardOrigins (from the popup's
    // Dashboard URL setting) are merged in — they never replace these.
    const DEFAULT_ORIGINS = ['http://localhost:5500', 'https://flowaccess-phi.vercel.app'];

    let allowedOrigins = null;
    function getAllowedOrigins() {
        if (allowedOrigins) return Promise.resolve(allowedOrigins);
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get(['dashboardOrigins'], (r) => {
                    const stored = Array.isArray(r.dashboardOrigins) ? r.dashboardOrigins : [];
                    const list = [...new Set([...DEFAULT_ORIGINS, ...stored])];
                    allowedOrigins = list;
                    resolve(list);
                });
            } catch (e) {
                allowedOrigins = DEFAULT_ORIGINS.slice();
                resolve(allowedOrigins);
            }
        });
    }
    // Prime the cache early
    getAllowedOrigins();

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    // Validate action + payload shape before forwarding to background
    function validateBridgeMessage(action, payload) {
        if (!ALLOWED_ACTIONS.has(action)) return 'Unknown action';
        if (!isPlainObject(payload)) return 'Invalid payload';

        if (action === 'INJECT_COOKIES') {
            if (!Array.isArray(payload.cookies) || payload.cookies.length === 0 || payload.cookies.length > 500)
                return 'cookies must be a non-empty array (max 500)';
            for (const c of payload.cookies) {
                if (!isPlainObject(c) || typeof c.name !== 'string' || typeof c.value !== 'string')
                    return 'each cookie needs name/value strings';
            }
            if (payload.targetUrl !== undefined && typeof payload.targetUrl !== 'string')
                return 'targetUrl must be a string';
        }

        if (action === 'FETCH_AND_INJECT') {
            if (typeof payload.endpointUrl !== 'string' || !/^https:\/\//i.test(payload.endpointUrl))
                return 'endpointUrl must be an https URL';
            if (payload.endpointUrl.length > 2048) return 'endpointUrl too long';
        }

        const PROJECT_URL_RE = /^https:\/\/flow\.google\.com\/project\/[a-zA-Z0-9_\-]+/i;
        if (action === 'PROJECT_SAVE') {
            if (typeof payload.url !== 'string' || !PROJECT_URL_RE.test(payload.url))
                return 'url must be a Flow project URL';
            if (payload.url.length > 2048) return 'url too long';
            if (payload.name !== undefined && (typeof payload.name !== 'string' || payload.name.length > 120))
                return 'name must be a short string';
        }
        if (action === 'PROJECT_REMOVE') {
            if (typeof payload.url !== 'string' || !PROJECT_URL_RE.test(payload.url))
                return 'url must be a Flow project URL';
        }

        return null; // OK
    }

    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'FLOW_ACCESS_WEB') return;

        const reply = (response) => {
            window.postMessage({
                source: 'FLOW_ACCESS_EXTENSION_REPLY',
                id: event.data.id,
                response: response,
                payload: response
            }, event.origin || '*');
        };

        try {
            // 1. Origin must be a configured dashboard origin.
            // Never drop silently: tell the page exactly why, so the
            // dashboard shows the real cause instead of a generic
            // "Extension not responding" after its request timeout.
            const origins = await getAllowedOrigins();
            if (!origins.includes(event.origin)) {
                console.warn('[FlowAccess] Dropped bridge message — origin not allowed:', event.origin);
                reply({ success: false, error: 'Origin not allowed: ' + event.origin });
                return;
            }

            const { action, payload } = event.data;

            // 2a. Project history — forwarded to the background store
            // (single source of truth; 3 entries, deduped by project ID)
            if (action === 'GET_SAVED_PROJECTS' || action === 'PROJECT_LIST') {
                const response = await chrome.runtime.sendMessage({ action: 'PROJECT_LIST' });
                reply(response);
                return;
            }
            if (action === 'REMOVE_SAVED_PROJECT' || action === 'PROJECT_REMOVE') {
                const url = payload && payload.url;
                if (typeof url !== 'string' || !/^https:\/\/flow\.google\.com\/project\//i.test(url)) {
                    reply({ success: false, error: 'Invalid project url' });
                    return;
                }
                const response = await chrome.runtime.sendMessage({ action: 'PROJECT_REMOVE', url });
                reply(response);
                return;
            }

            // 2b. Action allowlist + payload schema validation
            const err = validateBridgeMessage(action, payload || {});
            if (err) {
                reply({ success: false, error: err });
                return;
            }

            // 3. Forward to background service worker
            const response = await chrome.runtime.sendMessage({ action, ...payload });
            reply(response);
        } catch (err) {
            try {
                reply({ success: false, error: err && err.message ? err.message : 'Bridge error' });
            } catch (e) { /* ignore */ }
        }
    });

    // ========================
    // 5. EXTENSION CONTEXT CHECK
    // ========================

    setInterval(() => {
        try {
            if (!chrome.runtime || !chrome.runtime.id) {
                window.location.reload();
            }
        } catch (e) {
            window.location.reload();
        }
    }, 5000);

})();
