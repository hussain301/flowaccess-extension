// FlowAccess Popup — minimal, no technical details shown to user

const DEFAULT_DASHBOARD_URL = 'http://localhost:5500/website/dashboard.html';

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

function getDashboardUrl() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['dashboardUrl'], (r) => {
        resolve(typeof r.dashboardUrl === 'string' && r.dashboardUrl ? r.dashboardUrl : DEFAULT_DASHBOARD_URL);
      });
    } catch (e) {
      resolve(DEFAULT_DASHBOARD_URL);
    }
  });
}

// Check if Flow tab is open
chrome.tabs.query({}, (tabs) => {
  const flowOpen = tabs.some(t => t.url && t.url.includes('flow.google.com'));
  const sessionEl = document.getElementById('sessionStatus');

  if (flowOpen) {
    sessionEl.innerHTML = '<span class="dot dot-green"></span> Active';
  } else {
    sessionEl.innerHTML = '<span class="dot dot-red"></span> Inactive';
  }
});

// Dashboard URL setting — also used as the allowed bridge origin
const dashUrlInput = document.getElementById('dashUrl');
const urlHint = document.getElementById('urlHint');

getDashboardUrl().then(url => { dashUrlInput.value = url; });

function dashboardOrigin(url) {
  try { return new URL(url).origin; } catch (e) { return null; }
}

document.getElementById('saveUrlBtn').addEventListener('click', () => {
  const url = dashUrlInput.value.trim() || DEFAULT_DASHBOARD_URL;
  const origin = dashboardOrigin(url);
  if (!origin || !/^https?:$/.test(new URL(url).protocol)) {
    urlHint.style.color = '#ef4444';
    urlHint.textContent = 'Please enter a valid http(s) URL.';
    return;
  }
  chrome.storage.local.set({ dashboardUrl: url, dashboardOrigins: [origin] }, () => {
    urlHint.style.color = '#10b981';
    urlHint.textContent = 'Saved ✓';
    setTimeout(() => { urlHint.textContent = ''; }, 2000);
  });
});

// Dashboard button
document.getElementById('dashBtn').addEventListener('click', async () => {
  const url = await getDashboardUrl();
  chrome.tabs.create({ url });
  window.close();
});
