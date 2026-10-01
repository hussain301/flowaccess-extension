// FlowAccess Pro popup — extracted from popup.html (MV3 bans inline scripts).
const el = document.getElementById('status');
const peerEl = document.getElementById('peer');
const pubEl = document.getElementById('pub');
chrome.cookies.get({ url: 'http://localhost:5500/', name: 'fa_watchdog_id' }).then(c => {
  if (c && c.value === chrome.runtime.id) {
    pubEl.innerHTML = '<span class="ok">Published ✓</span> <code>fa_watchdog_id</code> — the main extension can pair.';
  } else if (c && c.value) {
    pubEl.innerHTML = '<span class="warn">⚠️ Published with a different value.</span> Reload this extension to re-publish.';
  } else {
    pubEl.innerHTML = '<span class="bad">NOT published ✗</span> <code>fa_watchdog_id</code> — pairing is impossible. Reload this extension.';
  }
}).catch(() => {
  pubEl.innerHTML = '<span class="bad">NOT published ✗</span> — registry cookie read failed.';
});
chrome.storage.local.get(['faPeerMainId']).then(s => {
  const peerId = s.faPeerMainId;
  if (!peerId) {
    el.innerHTML = '<span class="warn">⚠️ Not paired yet.</span><br>The main extension has not published its ID. Make sure it is installed and reload this popup in a few seconds.';
    return;
  }
  peerEl.textContent = 'peer: ' + peerId;
  chrome.management.get(peerId).then(info => {
    if (info && info.enabled) {
      el.innerHTML = '<span class="ok">✅ Watching main extension</span><br>If it is removed or disabled, the shared session cookies will be wiped immediately.';
    } else {
      el.innerHTML = '<span class="warn">⚠️ Main extension is disabled.</span><br>Session was wiped. Re-enable it to continue.';
    }
  }).catch(() => {
    el.innerHTML = '<span class="bad">❌ Main extension not found.</span><br>It may have been uninstalled — the session was wiped.';
  });
}).catch(() => { el.textContent = 'Could not read pairing state.'; });
