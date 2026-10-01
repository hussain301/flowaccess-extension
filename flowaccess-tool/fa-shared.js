// ============================================================
// FlowAccess — shared helpers (content scripts + side panel)
// Project URL utils, 4 copy formats, clipboard with fallback.
// Loaded before flow-guard.js and sidepanel.js — NOT in the
// service worker (it defines its own copies).
// ============================================================
(function (global) {
    'use strict';

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
            return m ? (p.origin + m[0]) : url;
        } catch (e) { return url; }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Four copy formats for a project entry {url, name}
    function projectCopyFormats(p) {
        const url = p && p.url ? p.url : '';
        const name = p && p.name ? p.name : (projectIdOf(url) || 'Flow project');
        const id = projectIdOf(url) || url;
        return {
            link: url,                                  // 1. Plain link
            markdown: '[' + name + '](' + url + ')',     // 2. Markdown link
            html: '<a href="' + url + '">' + escapeHtml(name) + '</a>', // 3. HTML link
            id: id                                      // 4. Project ID only
        };
    }

    // Clipboard with fallback: navigator.clipboard first, then a hidden
    // textarea + document.execCommand('copy') for non-secure contexts.
    // Returns a Promise<boolean>.
    function copyTextWithFallback(text) {
        const t = String(text == null ? '' : text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(t).then(
                () => true,
                () => legacyCopy(t)
            );
        }
        return Promise.resolve(legacyCopy(t));
    }

    function legacyCopy(t) {
        try {
            const doc = global.document;
            if (!doc || !doc.body) return false;
            const ta = doc.createElement('textarea');
            ta.value = t;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
            doc.body.appendChild(ta);
            ta.focus();
            ta.select();
            let ok = false;
            try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
            ta.remove();
            return !!ok;
        } catch (e) { return false; }
    }

    global.FaShared = {
        projectIdOf: projectIdOf,
        cleanProjectUrl: cleanProjectUrl,
        escapeHtml: escapeHtml,
        projectCopyFormats: projectCopyFormats,
        copyTextWithFallback: copyTextWithFallback
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
