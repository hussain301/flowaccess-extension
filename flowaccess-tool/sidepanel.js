// ============================================================
// FlowAccess — Projects Side Panel
// Lists the 3-entry project history with copy-one / copy-all /
// open / delete / clear actions. Copy uses 4 formats with a
// clipboard fallback.
// ============================================================
(() => {
    'use strict';

    const listEl = document.getElementById('list');
    const countEl = document.getElementById('count');
    const searchEl = document.getElementById('search');
    const formatEl = document.getElementById('format');
    const toastEl = document.getElementById('toast');

    let projects = [];
    let toastTimer = null;

    function toast(msg, ok) {
        toastEl.style.display = 'block';
        toastEl.style.color = ok === false ? '#f87171' : '#4ade80';
        toastEl.textContent = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
    }

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

    function fmtDate(ts) {
        try {
            const d = new Date(ts);
            return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return ''; }
    }

    function currentFormat() {
        return formatEl.value || 'link';
    }

    function formatOne(p) {
        const f = FaShared.projectCopyFormats(p);
        return f[currentFormat()] || f.link;
    }

    async function copyOne(p) {
        const ok = await FaShared.copyTextWithFallback(formatOne(p));
        toast(ok ? '✅ Copied (' + currentFormat() + ')' : '❌ Copy failed', ok);
    }

    async function copyAll() {
        const visible = filteredProjects();
        if (!visible.length) { toast('Nothing to copy', false); return; }
        const text = visible.map(formatOne).join('\n');
        const ok = await FaShared.copyTextWithFallback(text);
        toast(ok ? '✅ Copied ' + visible.length + ' projects' : '❌ Copy failed', ok);
    }

    async function openProject(p) {
        try {
            await chrome.tabs.create({ url: p.url, active: true });
        } catch (e) {
            toast('❌ Could not open tab', false);
        }
    }

    async function deleteProject(p) {
        const res = await bgSend('PROJECT_REMOVE', { url: p.url });
        if (res && res.success) {
            projects = res.projects || [];
            render();
            toast('🗑 Removed');
        } else {
            toast('❌ Remove failed', false);
        }
    }

    async function clearAll() {
        if (!projects.length) return;
        if (!confirm('Delete all ' + projects.length + ' saved projects?')) return;
        const res = await bgSend('PROJECT_CLEAR');
        if (res && res.success) {
            projects = [];
            render();
            toast('🗑 All cleared');
        } else {
            toast('❌ Clear failed', false);
        }
    }

    function filteredProjects() {
        const q = (searchEl.value || '').trim().toLowerCase();
        if (!q) return projects;
        return projects.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.url || '').toLowerCase().includes(q));
    }

    function render() {
        const visible = filteredProjects();
        countEl.textContent = '· ' + projects.length + '/3';
        listEl.innerHTML = '';
        if (!visible.length) {
            const d = document.createElement('div');
            d.className = 'empty';
            d.textContent = projects.length
                ? 'No projects match your search.'
                : 'No saved projects yet.\nOpen a Flow project and hit 💾 Save Project.';
            listEl.appendChild(d);
            return;
        }
        visible.forEach(p => {
            const card = document.createElement('div');
            card.className = 'proj';

            const name = document.createElement('div');
            name.className = 'name';
            name.textContent = p.name || FaShared.projectIdOf(p.url) || 'Flow project';

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = (FaShared.projectIdOf(p.url) || '') +
                (p.savedAt ? ' · ' + fmtDate(p.savedAt) : '');

            const row = document.createElement('div');
            row.className = 'row-btns';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-ghost';
            copyBtn.textContent = '⧉ Copy';
            copyBtn.title = 'Copy in the selected format';
            copyBtn.addEventListener('click', () => copyOne(p));

            const openBtn = document.createElement('button');
            openBtn.className = 'btn-ghost';
            openBtn.textContent = '↗ Open';
            openBtn.addEventListener('click', () => openProject(p));

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-danger-ghost';
            delBtn.textContent = '✕';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', () => deleteProject(p));

            row.appendChild(copyBtn);
            row.appendChild(openBtn);
            row.appendChild(delBtn);
            card.appendChild(name);
            card.appendChild(meta);
            card.appendChild(row);
            listEl.appendChild(card);
        });
    }

    async function load() {
        const res = await bgSend('PROJECT_LIST');
        if (res && res.success && Array.isArray(res.projects)) {
            projects = res.projects;
        } else {
            projects = [];
        }
        render();
    }

    document.getElementById('copyAll').addEventListener('click', copyAll);
    document.getElementById('clearAll').addEventListener('click', clearAll);
    searchEl.addEventListener('input', render);
    formatEl.addEventListener('change', () => { /* applies to next copy */ });

    // Live refresh when history changes elsewhere (Flow tab saves, etc.)
    if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.faProjectHistory) {
                const v = changes.faProjectHistory.newValue;
                projects = Array.isArray(v) ? v : [];
                render();
            }
        });
    }

    load();
})();
