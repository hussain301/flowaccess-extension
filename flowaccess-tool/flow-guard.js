// ============================================================
// FlowAccess — Flow Guard v6 (flow.google.com)
// Features: Fake credits on Flow's REAL credit elements,
//           projects blur, save project (max 3), per-user fake
//           identity (random gmail + emoji avatar), keyboard block
//
// Credit display technique: Flow's own credit anchors are
// targeted and stamped with data-* attributes; injected CSS
// hides their original content and renders the fake values
// via ::after { content: attr(...) }. This survives Flow's
// SPA re-renders because the CSS applies automatically.
// ============================================================

(() => {
    'use strict';


    // ============================
    // STATE
    // ============================
    let fakeBalance = 45000;
    let fakeModelName = '';
    let projectHistory = [];  // 3 entries {url, name, savedAt} — background is source of truth
    let fakeEmail = null;     // per-user random gmail (replaces real account email)
    let fakeEmoji = null;     // per-user random avatar emoji
    let lastGenerateClick = 0;

    // Talk to the background service worker (project history store, panel)
    function bgSend(action, payload) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(Object.assign({ action }, payload || {}), (res) => {
                    resolve(res || { success: false, error: 'No response' });
                });
            } catch (e) {
                resolve({ success: false, error: e.message });
            }
        });
    }

    function refreshHistoryCache() {
        return bgSend('PROJECT_LIST').then(res => {
            if (res && res.success && Array.isArray(res.projects)) {
                projectHistory = res.projects;
            }
            return projectHistory;
        }).catch(() => projectHistory);
    }

    function isProjectSaved(url) {
        const id = window.FaShared ? FaShared.projectIdOf(url) : null;
        if (!id) return false;
        return projectHistory.some(p => {
            const pid = window.FaShared ? FaShared.projectIdOf(p.url) : null;
            return pid === id;
        });
    }

    // Per-model generation cost (displayed + deducted)
    const creditMap = {
        'Omni 1.1 Flash': 12,
        'Veo 3.1 - Lite': 5,
        'Veo 3.1 - Fast': 10,
        'Veo 3.1 - Quality': 100,
        'default': 50
    };

    // Real Flow credit elements (stable across re-renders)
    const BALANCE_ANCHOR_SEL = "a[href*='flow_ai_credits_page']";
    const MODEL_COST_ANCHOR_SEL = "a[href*='g1_ai_credit_menu']";

    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(
            ['fakeBalance', 'faFakeEmail', 'faFakeEmoji'],
            r => {
                if (typeof r.fakeBalance === 'number') fakeBalance = r.fakeBalance;
                if (typeof r.faFakeEmail === 'string' && r.faFakeEmail.includes('@')) fakeEmail = r.faFakeEmail;
                if (typeof r.faFakeEmoji === 'string' && r.faFakeEmoji) fakeEmoji = r.faFakeEmoji;
                if (!fakeEmail || !fakeEmoji) {
                    if (!fakeEmail) fakeEmail = makeRandomEmail();
                    if (!fakeEmoji) fakeEmoji = FAKE_EMOJIS[Math.floor(Math.random() * FAKE_EMOJIS.length)];
                    chrome.storage.local.set({ faFakeEmail: fakeEmail, faFakeEmoji: fakeEmoji });
                }
                try { scheduleIdentitySweep(); } catch (e) {}
            }
        );
        // Project history lives in the background (3 entries, deduped;
        // legacy max-3 list is migrated there on first read).
        refreshHistoryCache().catch(() => {});
    }

    // Per-user fake identity: random gmail + random avatar emoji,
    // generated once per browser and reused afterwards.
    const FAKE_EMOJIS = ['🦊','🐼','🐯','🦁','🐸','🐵','🐧','🦄','🐝','🦋','🐢','🐙','🦀','🐳','🦜','🌟','⚡','🔥','🌈','🍀','🎭','🚀','👾','🤖','👻','🍩','🎧','🛹'];
    function makeRandomEmail() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let s = '';
        for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return 'user' + s + '@gmail.com';
    }

    function persistBalance() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ fakeBalance });
        }
    }

    // ============================
    // CSS — render fake values on Flow's own elements
    // ============================
    const style = document.createElement('style');
    style.id = 'fa-guard-style';
    style.textContent = `
        /* --- Fake balance on Flow's real credit link --- */
        ${BALANCE_ANCHOR_SEL} {
            font-size: 0 !important;
            color: transparent !important;
            pointer-events: none !important;
            position: relative !important;
            white-space: nowrap !important;
        }
        ${BALANCE_ANCHOR_SEL} > * { display: none !important; }
        ${BALANCE_ANCHOR_SEL}::after {
            content: attr(data-fa-credits) " credits" !important;
            font-family: 'Google Sans', Roboto, 'Segoe UI', Arial, sans-serif !important;
            font-size: 14px !important;
            font-weight: 500 !important;
            letter-spacing: 0.25px !important;
            color: #e8eaed !important;
            visibility: visible !important;
            white-space: nowrap !important;
        }

        /* --- Fake per-model cost on Flow's credit menu link --- */
        ${MODEL_COST_ANCHOR_SEL} {
            color: transparent !important;
            position: relative !important;
            white-space: nowrap !important;
        }
        ${MODEL_COST_ANCHOR_SEL} > * { display: none !important; }
        ${MODEL_COST_ANCHOR_SEL}::after {
            content: attr(data-fa-model-cost) " credits" !important;
            font-family: 'Google Sans', Roboto, 'Segoe UI', Arial, sans-serif !important;
            font-size: 12px !important;
            font-weight: 500 !important;
            letter-spacing: 0.25px !important;
            color: #9aa0a6 !important;
            visibility: visible !important;
            white-space: nowrap !important;
        }

        /* --- Blurred Project Card --- */
        [data-fa-blur="true"] {
            filter: blur(12px) saturate(0.3) !important;
            pointer-events: none !important;
            user-select: none !important;
            opacity: 0.5 !important;
            position: relative !important;
            overflow: hidden !important;
        }
        [data-fa-blur="true"]::after {
            content: "\\1F512" !important;
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-size: 32px !important;
            z-index: 10 !important;
            filter: none !important;
            opacity: 1 !important;
            pointer-events: none !important;
        }

        /* --- Save Button --- */
        #fa-save-btn {
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            background: #1a73e8 !important;
            color: #fff !important;
            border: none !important;
            padding: 10px 20px !important;
            border-radius: 24px !important;
            font-family: 'Google Sans', sans-serif !important;
            font-size: 14px !important;
            font-weight: 500 !important;
            cursor: pointer !important;
            z-index: 999999 !important;
            box-shadow: 0 4px 12px rgba(26,115,232,0.4) !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
        }
        #fa-save-btn:hover { background: #1557b0 !important; transform: translateY(-2px) !important; }
        #fa-save-btn.saved { background: #0d9488 !important; }

        /* --- Fake per-user avatar (replaces real Google profile photo) --- */
        .fa-fake-avatar {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            border-radius: 50% !important;
            background: #3c4043 !important;
            flex: 0 0 auto !important;
            user-select: none !important;
            line-height: 1 !important;
        }

        /* --- Hide Credit Banner (original) --- */
        flow-credit-banner, .credit-banner { display:none!important; }

        /* --- Upsell Link Fake --- */
        a.upsell-link { pointer-events:none!important; }
        a.upsell-link span.mdc-button__label { font-size:0!important; }
        a.upsell-link span.mdc-button__label::after {
            content:'Google Ultra Plan 20x'!important; font-size:14px!important; color:#000!important;
            font-family:'Google Sans',Roboto,Arial,sans-serif!important; font-weight:500!important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // ============================
    // 1. FAKE CREDITS ON REAL FLOW ELEMENTS
    // ============================
    function renderFakeCredits() {
        // Main balance anchor
        const balanceAnchor = document.querySelector(BALANCE_ANCHOR_SEL);
        if (balanceAnchor) {
            const val = String(fakeBalance);
            if (balanceAnchor.getAttribute('data-fa-credits') !== val) {
                balanceAnchor.setAttribute('data-fa-credits', val);
            }
        }

        // Per-model cost anchor
        const costAnchor = document.querySelector(MODEL_COST_ANCHOR_SEL);
        const cost = creditMap[fakeModelName];
        if (costAnchor && cost !== undefined) {
            const val = String(cost);
            if (costAnchor.getAttribute('data-fa-model-cost') !== val) {
                costAnchor.setAttribute('data-fa-model-cost', val);
            }
        }
    }

    // Re-stamp quickly when Flow re-renders (SPA)
    const creditObserver = new MutationObserver(() => renderFakeCredits());
    function watchCredits() {
        if (document.body && !watchCredits._on) {
            creditObserver.observe(document.body, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['href', 'data-fa-credits', 'data-fa-model-cost']
            });
            watchCredits._on = true;
        }
    }

    function deductForGeneration() {
        const now = Date.now();
        if (now - lastGenerateClick < 5000) return; // throttle double clicks
        lastGenerateClick = now;
        const cost = creditMap[fakeModelName] !== undefined ? creditMap[fakeModelName] : creditMap['default'];
        fakeBalance = Math.max(0, fakeBalance - cost);
        persistBalance();
        renderFakeCredits();
    }

    function looksLikeGenerateButton(el) {
        const t = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        return /^(generate|create|submit|go|render)$/.test(t) || /generate|create video|create image/.test(aria);
    }

    // ============================
    // 2. MODEL DETECTION
    // ============================
    function detectModel() {
        // Prefer the actually-selected option
        const selected = document.querySelector('button[aria-selected="true"], [role="option"][aria-selected="true"]');
        const candidates = selected ? [selected] : Array.from(document.querySelectorAll('button'));
        for (const b of candidates) {
            const t = (b.textContent || '').trim();
            if (t && t.length < 40 && creditMap[t] !== undefined) {
                if (fakeModelName !== t) {
                    fakeModelName = t;
                    renderFakeCredits();
                }
                return;
            }
        }
    }

    // ============================
    // 3. BLUR OTHER PROJECTS (ONLY on home page)
    // ============================
    function blurOtherProjects() {
        const path = window.location.pathname;

        if (path !== '/' && path !== '') {
            document.querySelectorAll('[data-fa-blur]').forEach(el => el.removeAttribute('data-fa-blur'));
            return;
        }

        const projectLinks = document.querySelectorAll('a[href*="/project/"]');

        projectLinks.forEach(link => {
            const href = link.getAttribute('href') || '';
            let card = link;
            for (let i = 0; i < 4; i++) {
                if (card.parentElement && card.parentElement !== document.body) {
                    card = card.parentElement;
                } else break;
            }

            const text = (card.textContent || '').toLowerCase();
            if (text.includes('new project')) {
                card.removeAttribute('data-fa-blur');
                return;
            }

            if (projectHistory.length) {
                const isSaved = projectHistory.some(p => {
                    const projectId = window.FaShared ? FaShared.projectIdOf(p.url) : null;
                    return projectId && href.includes(projectId);
                });
                if (isSaved) {
                    card.removeAttribute('data-fa-blur');
                    return;
                }
            }

            card.setAttribute('data-fa-blur', 'true');
        });
    }

    // ============================
    // 3b. FAKE PER-USER IDENTITY
    // ============================
    // Replaces the shared account's real photo with the user's random emoji
    // and the real gmail address with the user's random gmail (per browser).
    const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

    function applyFakeIdentity() {
        if (!fakeEmail || !fakeEmoji) return;

        // 1. Avatar photo -> emoji
        document.querySelectorAll('img').forEach(img => {
            if (img.dataset.faAvatarDone) return;
            const src = img.getAttribute('src') || '';
            if (!src.includes('googleusercontent.com')) return;
            img.dataset.faAvatarDone = '1';
            const s = document.createElement('span');
            s.className = 'fa-fake-avatar';
            s.textContent = fakeEmoji;
            s.title = '';
            const rawSize = parseInt(img.getAttribute('width') || img.width || '32', 10);
            const px = Math.max(20, Math.min(96, isNaN(rawSize) ? 32 : rawSize));
            s.style.width = px + 'px';
            s.style.height = px + 'px';
            s.style.fontSize = Math.round(px * 0.62) + 'px';
            try { img.replaceWith(s); } catch (e) {}
        });

        // 2. Real gmail -> per-user random gmail (leaf text nodes only)
        document.querySelectorAll('div, span, p, a, button').forEach(el => {
            if (el.children.length !== 0 || el.dataset.faEmailDone) return;
            const t = (el.textContent || '').trim();
            if (EMAIL_RE.test(t) && t.toLowerCase() !== fakeEmail.toLowerCase()) {
                el.dataset.faEmailDone = '1';
                el.textContent = fakeEmail;
            }
        });
    }

    // Instant identity enforcement: the account menu popup is inserted
    // into the DOM the moment the profile is clicked. Polling every 2s
    // lets the real account flash first — so watch for new nodes and
    // sweep inside the same frame (MutationObserver callbacks run as
    // microtasks, before the browser paints the popup).
    let identityScheduled = false;
    function scheduleIdentitySweep() {
        if (identityScheduled) return;
        identityScheduled = true;
        requestAnimationFrame(() => {
            identityScheduled = false;
            try { applyFakeIdentity(); } catch (e) {}
        });
    }
    try {
        const identityObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'childList' && m.addedNodes.length) { scheduleIdentitySweep(); break; }
                if (m.type === 'attributes') { scheduleIdentitySweep(); break; }
            }
        });
        if (document.documentElement) {
            identityObserver.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
        }
    } catch (e) {}

    // ============================
    // 4. SAVE PROJECT (3-entry history) + PROJECTS LAUNCHER
    // ============================
    // Save is event-driven and deduplicated by the background store:
    // clicking Save on an already-saved project just re-copies the link.
    function currentProjectName(fallbackUrl) {
        const t = (document.title || '').trim();
        if (t && !/^flow$/i.test(t)) return t.split(' - ')[0].slice(0, 80);
        const id = window.FaShared ? FaShared.projectIdOf(fallbackUrl) : null;
        return id || 'Flow project';
    }

    function showSaveButton() {
        if (document.getElementById('fa-save-btn')) return;
        const url = window.location.href;
        if (!/\/project\/[a-zA-Z0-9_\-]+/i.test(url)) return;
        if (!document.body) return;

        const cleanUrl = window.FaShared ? FaShared.cleanProjectUrl(url) : url;
        const btn = document.createElement('button');
        btn.id = 'fa-save-btn';

        const paint = () => {
            if (isProjectSaved(cleanUrl)) {
                btn.textContent = '✅ Project Saved';
                btn.classList.add('saved');
            } else {
                btn.textContent = '💾 Save Project';
                btn.classList.remove('saved');
            }
        };
        paint();

        btn.onclick = async () => {
            const name = currentProjectName(cleanUrl);
            const res = await bgSend('PROJECT_SAVE', { url: cleanUrl, name });
            if (res && res.success) {
                projectHistory = res.projects || projectHistory;
                const formats = window.FaShared
                    ? FaShared.projectCopyFormats({ url: cleanUrl, name })
                    : { link: cleanUrl };
                const copied = window.FaShared
                    ? await FaShared.copyTextWithFallback(formats.link)
                    : false;
                btn.textContent = copied ? '✅ Saved & Copied!' : '✅ Saved';
                btn.classList.add('saved');
                setTimeout(paint, 2000);
            } else {
                const limited = res && res.error === 'PROJECT_LIMIT_REACHED';
                btn.textContent = limited ? '⚠️ Max 3 projects' : '⚠️ Save failed';
                setTimeout(paint, 2000);
            }
        };
        document.body.appendChild(btn);
    }


    // ============================
    // 8. CLICK INTERCEPT (generation deduction only)
    // ============================
    // NOTE: account menu (avatar, switch account, sign out) is intentionally
    // left fully original — no blocking here.
    document.addEventListener('click', e => {
        const t = e.target.closest('a, button, [role="menuitem"]');
        if (!t) return;
        if (t.tagName === 'BUTTON' && looksLikeGenerateButton(t)) {
            deductForGeneration();
        }
    }, true);

    // ============================
    // 9. PERIODIC ENFORCEMENT
    // ============================
    setInterval(() => {
        watchCredits();
        renderFakeCredits();
        detectModel();
        applyFakeIdentity();
        blurOtherProjects();
    }, 2000);


    // ============================
    // 11. MODEL AUTO-SWITCH
    // ============================
    // User request 2026-10-01: his Flow account has no credits for the paid
    // models, so "Veo 3.1 - Lite [Lower Priority]" — the 5th item in Flow's
    // model menu (user's XPath: //flow-menu-item[5]/button) — must ALWAYS be
    // the selected model: on page load, and whenever the user picks any other
    // model. Flow's own selector then shows the actually-selected model.
    // Matching is fuzzy (normalized text) so extra icons/whitespace can't
    // break it; interception is on pointerdown AND click (capture phase).
    const FA_MODEL_BTN_SEL = 'flow-menu-item button, .mat-mdc-menu-content button, button.mat-mdc-menu-item';
    const FA_TARGET_HINT = 'lower priority';
    const FA_MODEL_HINTS = ['omni 1.1 flash', 'veo 3.1 - lite', 'veo 3.1 - fast', 'veo 3.1 - quality'];

    function faNorm(t) { return (t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

    function faIsOtherModelButton(btn) {
        const t = faNorm(btn.textContent);
        if (!t || t.indexOf(FA_TARGET_HINT) !== -1) return false;
        if (btn.closest('flow-menu-item')) return true; // the model menu's own items
        return FA_MODEL_HINTS.some(h => t.indexOf(h) !== -1);
    }

    // Target item: text match first, 5th menu item as fallback (user's XPath).
    function faFindTargetItem() {
        const items = document.querySelectorAll('flow-menu-item button');
        for (const b of items) {
            if (faNorm(b.textContent).indexOf(FA_TARGET_HINT) !== -1) return b;
        }
        if (items.length >= 5) return items[4]; // flow-menu-item[5]
        const any = document.querySelectorAll(FA_MODEL_BTN_SEL);
        for (const b of any) {
            if (faNorm(b.textContent).indexOf(FA_TARGET_HINT) !== -1) return b;
        }
        return null;
    }

    let faLastIntercept = 0;

    function faInterceptModelPick(e) {
        try {
            const btn = (e.target && e.target.closest) ? e.target.closest(FA_MODEL_BTN_SEL) : null;
            if (!btn) return;
            // Only items inside the OPEN menu — never the selector trigger itself.
            if (!btn.closest('.cdk-overlay-container, .mat-mdc-menu-content, flow-menu-item')) return;
            if (!faIsOtherModelButton(btn)) return;
            // pointerdown + click both fire for one user gesture: handle once.
            const now = Date.now();
            if (now - faLastIntercept < 800) return;
            // Fail safe: if the target item isn't in the open menu, don't
            // block the user's click.
            const target = faFindTargetItem();
            if (!target) return;
            faLastIntercept = now;
            e.preventDefault();
            e.stopPropagation();
            target.click();
            console.log('[FlowAccess] model auto-switched to Veo 3.1 - Lite [Lower Priority]');
        } catch (err) {}
    }

    function faWatchModelSelect() {
        // Register once: init() can run again on SPA navigation.
        if (window.__faModelWatch) return;
        window.__faModelWatch = true;
        document.addEventListener('pointerdown', faInterceptModelPick, true);
        document.addEventListener('click', faInterceptModelPick, true);
        console.log('[FlowAccess] model auto-switch watch active');
    }

    // The model selector trigger: the closed dropdown showing the current model.
    function faModelTrigger() {
        const els = document.querySelectorAll('button, [role="button"]');
        for (const el of els) {
            if (el.closest('.cdk-overlay-container, .mat-mdc-menu-content')) continue;
            const t = faNorm(el.textContent);
            if (!t || t.length > 60) continue;
            if (t.indexOf(FA_TARGET_HINT) !== -1) return el;
            if (FA_MODEL_HINTS.some(h => t.indexOf(h) !== -1)) return el;
        }
        return null;
    }

    // Open the model menu invisibly and pick the target item (used on load).
    function faOpenAndPickTarget() {
        let trig = null;
        try { trig = faModelTrigger(); } catch (e) {}
        if (!trig) return;
        const overlay = document.querySelector('.cdk-overlay-container');
        const prevVis = overlay ? overlay.style.visibility : '';
        const restore = () => { if (overlay) overlay.style.visibility = prevVis; };
        setTimeout(restore, 8000); // failsafe
        if (overlay) overlay.style.visibility = 'hidden'; // no visible flicker
        try { trig.click(); } catch (e) {}
        let inner = 0;
        const iv2 = setInterval(() => {
            inner++;
            let target = null;
            try { target = faFindTargetItem(); } catch (e) {}
            if (target) {
                clearInterval(iv2);
                restore();
                try { target.click(); } catch (e) {}
                console.log('[FlowAccess] model auto-selected on load: Veo 3.1 - Lite [Lower Priority]');
            } else if (inner > 20) {
                clearInterval(iv2);
                restore();
                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (e) {}
            }
        }, 200);
    }

    // On page load: make sure the target model ends up selected.
    function faEnsureTargetOnLoad() {
        if (window.__faEnsure) return;
        window.__faEnsure = true;
        let tries = 0;
        const iv = setInterval(() => {
            tries++;
            let cur = null, menuOpen = false;
            try {
                const trig = faModelTrigger();
                cur = trig ? faNorm(trig.textContent) : null;
                menuOpen = !!faFindTargetItem();
            } catch (e) {}
            if (cur && cur.indexOf(FA_TARGET_HINT) !== -1) { clearInterval(iv); return; } // already correct
            if (menuOpen) {
                // Menu is already open: pick the target directly.
                clearInterval(iv);
                let target = null;
                try { target = faFindTargetItem(); } catch (e) {}
                if (target) { try { target.click(); } catch (e) {} }
                return;
            }
            if (!cur) { if (tries >= 15) clearInterval(iv); return; } // trigger not rendered yet
            clearInterval(iv);
            faOpenAndPickTarget();
        }, 1000);
    }

    // ============================
    // INIT
    // ============================
    // Event-driven auto-save: visiting a project page records it in the
    // 3-entry history (deduplicated by the background store).
    function autoSaveCurrentProject() {
        const url = window.location.href;
        if (!/\/project\/[a-zA-Z0-9_\-]+/i.test(url)) return;
        if (isProjectSaved(url)) return;
        const cleanUrl = window.FaShared ? FaShared.cleanProjectUrl(url) : url;
        bgSend('PROJECT_SAVE', { url: cleanUrl, name: currentProjectName(cleanUrl) })
            .then(res => { if (res && res.success) projectHistory = res.projects || projectHistory; })
            .catch(() => {});
    }

    function init() {
        watchCredits();
        renderFakeCredits();
        detectModel();
        showSaveButton();
        autoSaveCurrentProject();
        applyFakeIdentity();
        blurOtherProjects();
        faWatchModelSelect();
        faEnsureTargetOnLoad();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else init();
    window.addEventListener('load', () => setTimeout(init, 1500));

    // SPA navigation
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            const old = document.getElementById('fa-save-btn');
            if (old) old.remove();
            setTimeout(init, 1000);
        }
    }, 500);

    console.log('[FlowAccess] Flow Guard v6 active');

    // Guarantee the model watcher is registered even if an init() step throws.
    try { faWatchModelSelect(); } catch (e) {}
})();
