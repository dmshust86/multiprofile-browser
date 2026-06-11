'use strict';
/* Partitions chrome renderer — drives the tabstrip/toolbar for one
   profile window. All real browsing happens in main-process
   WebContentsViews; this page only renders UI state. */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') || 'single';
const IDENTITY = {
  name: params.get('name') || 'Profile',
  color: params.get('color') || '#3e7bd6',
  icon: params.get('icon') || '◆',
  temp: params.get('temp') === '1'
};
function applyIdentity(idn) {
  IDENTITY.name = idn.name; IDENTITY.color = idn.color; IDENTITY.icon = idn.icon;
  if (typeof idn.temp === 'boolean') IDENTITY.temp = idn.temp;
  document.documentElement.style.setProperty('--profile', IDENTITY.color);
  $('#badgeIcon').textContent = IDENTITY.icon;
  $('#badgeName').textContent = IDENTITY.name;
  $('#profileBadge').title = MODE === 'workspace'
    ? `Workspace window — each tab is its own profile. The active tab belongs to “${IDENTITY.name}”.`
    : `All cookies, logins and storage in this window belong to “${IDENTITY.name}” only.`;
  $('#badgeTemp').classList.toggle('hidden', !IDENTITY.temp);
}
applyIdentity(IDENTITY);
if (MODE === 'workspace') $('#btnNewTab').title = 'New tab — next profile in rotation';

let STATE = { tabs: [], activeTabId: null, address: '', canBack: false, canFwd: false, loading: false, bookmarked: false };
let addressFocused = false;
const downloads = new Map();

/* ---------------- tab strip ---------------- */
function renderTabs() {
  const strip = $('#tabStrip');
  strip.innerHTML = '';
  for (const t of STATE.tabs) {
    const tab = el('div', 'tab' + (t.id === STATE.activeTabId ? ' active' : '') + (MODE === 'workspace' ? ' colored' : ''));
    if (MODE === 'workspace' && t.color) {
      tab.style.setProperty('--tabcolor', t.color);
      tab.title = `${t.profileName}`;
      const dot = el('span', 'tabdot');
      dot.style.background = t.color;
      tab.appendChild(dot);
    }
    if (t.loading) tab.appendChild(el('span', 'spin'));
    else if (t.favicon) {
      const img = el('img', 'fav');
      img.src = t.favicon;
      img.onerror = () => img.remove();
      tab.appendChild(img);
    }
    tab.appendChild(el('span', 'label', t.title || t.url || 'New tab'));
    const x = el('button', 'x', '✕');
    x.onclick = (e) => { e.stopPropagation(); window.chrome_api.closeTab(t.id); };
    tab.appendChild(x);
    tab.onclick = () => { if (overlayOpen) closeOverlay(); window.chrome_api.selectTab(t.id); };
    tab.onauxclick = (e) => { if (e.button === 1) window.chrome_api.closeTab(t.id); };
    strip.appendChild(tab);
  }
}

function renderNav() {
  $('#btnBack').disabled = !STATE.canBack;
  $('#btnFwd').disabled = !STATE.canFwd;
  $('#btnReload').classList.toggle('hidden', STATE.loading);
  $('#btnStop').classList.toggle('hidden', !STATE.loading);
  $('#btnBookmark').textContent = STATE.bookmarked ? '★' : '☆';
  $('#btnBookmark').classList.toggle('on', STATE.bookmarked);
  if (!addressFocused) $('#address').value = STATE.address;
}

window.chrome_api.onTabsUpdate((state) => {
  STATE = state;
  if (state.activeIdentity) applyIdentity(state.activeIdentity);
  renderTabs();
  renderNav();
});

/* ---------------- toolbar actions ---------------- */
$('#btnNewTab').onclick = () => window.chrome_api.newTab();
$('#btnBack').onclick = () => window.chrome_api.back();
$('#btnFwd').onclick = () => window.chrome_api.forward();
$('#btnReload').onclick = () => window.chrome_api.reload();
$('#btnStop').onclick = () => window.chrome_api.stop();
$('#btnHome').onclick = () => window.chrome_api.home();
$('#btnBookmark').onclick = async () => {
  const r = await window.chrome_api.bookmarkToggle();
  if (r && r.error) flashPlaceholder(r.error);
};

const address = $('#address');
address.addEventListener('focus', () => { addressFocused = true; address.select(); });
address.addEventListener('blur', () => { addressFocused = false; address.value = STATE.address; });
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.chrome_api.navigate(address.value);
    address.blur();
  }
  if (e.key === 'Escape') address.blur();
});
function flashPlaceholder(msg) {
  const old = address.placeholder;
  address.placeholder = msg;
  setTimeout(() => { address.placeholder = old; }, 2500);
}

/* ---------------- overlay panels ---------------- */
const overlay = $('#overlay');
let overlayOpen = false;

function openOverlay(panel) {
  overlayOpen = true;
  overlay.classList.remove('hidden');
  window.chrome_api.requestOverlay(true);
  switchPanel(panel);
}
function closeOverlay() {
  overlayOpen = false;
  overlay.classList.add('hidden');
  window.chrome_api.requestOverlay(false);
}
function switchPanel(name) {
  document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'bookmarks') loadBookmarks();
  if (name === 'history') loadHistory();
  if (name === 'downloads') loadDownloads();
  if (name === 'note') loadNote();
  if (name === 'profiles') loadProfileTargets();
}
$('#panelTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) switchPanel(b.dataset.panel);
});
$('#btnCloseOverlay').onclick = closeOverlay;
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlayOpen) closeOverlay(); });

$('#btnPanels').onclick = () => (overlayOpen ? closeOverlay() : openOverlay('bookmarks'));
$('#btnNote').onclick = () => (overlayOpen ? closeOverlay() : openOverlay('note'));
$('#btnProfileMenu').onclick = () => (overlayOpen ? closeOverlay() : openOverlay('profiles'));

/* ---------------- bookmarks panel ---------------- */
async function loadBookmarks() {
  const { items } = await window.chrome_api.bookmarks();
  const list = $('#bookmarkList');
  list.innerHTML = '';
  if (IDENTITY.temp) { list.appendChild(el('div', 'pempty', 'Temporary sessions do not keep bookmarks.')); return; }
  $('#panel-bookmarks .ptitle') && ($('#panel-bookmarks .ptitle').textContent = `Bookmarks — ${IDENTITY.name}`);
  if (!items.length) { list.appendChild(el('div', 'pempty', 'No bookmarks in this profile yet. Use ☆ in the toolbar.')); return; }
  for (const b of items) {
    const row = el('div', 'pitem');
    const grow = el('div', 'grow');
    grow.append(el('div', 't', b.title || b.url));
    grow.append(el('div', 'u', b.url));
    const open = el('button', null, 'Open');
    open.onclick = () => { window.chrome_api.newTab(b.url); closeOverlay(); };
    const del = el('button', null, 'Remove');
    del.onclick = async () => { await window.chrome_api.bookmarkDelete(b.id); loadBookmarks(); };
    row.append(grow, open, del);
    list.appendChild(row);
  }
}
$('#btnExportBm').onclick = () => window.chrome_api.bookmarksExport();
$('#btnImportBm').onclick = async () => {
  const r = await window.chrome_api.bookmarksImport();
  if (r && r.ok) loadBookmarks();
};

/* ---------------- history panel ---------------- */
async function loadHistory() {
  const { entries } = await window.chrome_api.history();
  const list = $('#historyList');
  list.innerHTML = '';
  if (!entries.length) { list.appendChild(el('div', 'pempty', IDENTITY.temp ? 'Temporary sessions keep no history.' : 'No history yet.')); return; }
  for (const h of entries) {
    const row = el('div', 'pitem');
    const grow = el('div', 'grow');
    grow.append(el('div', 't', h.title || h.url));
    grow.append(el('div', 'u', `${new Date(h.at).toLocaleString()} · ${h.url}`));
    const open = el('button', null, 'Open');
    open.onclick = () => { window.chrome_api.newTab(h.url); closeOverlay(); };
    row.append(grow, open);
    list.appendChild(row);
  }
}

/* ---------------- downloads panel ---------------- */
window.chrome_api.onDownloadUpdate((rec) => {
  downloads.set(rec.id, rec);
  if (overlayOpen && $('#panel-downloads').classList.contains('active')) renderDownloads();
});
async function loadDownloads() {
  const { items } = await window.chrome_api.downloads();
  for (const d of items) if (!downloads.has(d.id)) downloads.set(d.id, d);
  renderDownloads();
}
function renderDownloads() {
  const list = $('#downloadList');
  list.innerHTML = '';
  const items = [...downloads.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (!items.length) { list.appendChild(el('div', 'pempty', 'No downloads in this profile yet.')); return; }
  for (const d of items) {
    const row = el('div', 'pitem');
    const grow = el('div', 'grow');
    grow.append(el('div', 't', d.filename));
    grow.append(el('div', 'u', `${d.state} · ${d.savePath}`));
    row.append(grow);
    if (d.state === 'progressing' && d.totalBytes) {
      const bar = document.createElement('progress');
      bar.max = d.totalBytes; bar.value = d.receivedBytes;
      row.append(bar);
    }
    list.appendChild(row);
  }
}

/* ---------------- page note panel ---------------- */
async function loadNote() {
  $('#noteUrlLabel').textContent = STATE.address || 'No page loaded';
  if (IDENTITY.temp) {
    $('#noteText').value = '';
    $('#noteText').placeholder = 'Notes are kept in saved profiles only — temporary sessions leave nothing behind.';
    $('#noteText').disabled = true;
    $('#btnSaveNote').disabled = true;
    return;
  }
  const { text } = await window.chrome_api.noteForUrl(STATE.address);
  $('#noteText').value = text || '';
}
$('#btnSaveNote').onclick = async () => {
  await window.chrome_api.setNoteForUrl(STATE.address, $('#noteText').value);
  closeOverlay();
};

/* ---------------- open-in-profile panel ---------------- */
async function loadProfileTargets() {
  const ctx = await window.chrome_api.context();
  const list = $('#profileTargets');
  list.innerHTML = '';
  const targets = ctx.profiles.filter((p) => p.id !== ctx.profileId);
  if (!targets.length) list.appendChild(el('div', 'pempty', 'No other profiles yet — create one from the dashboard.'));
  for (const p of targets) {
    const row = el('div', 'pitem');
    const dot = el('span', 'dot'); dot.style.background = p.color;
    const grow = el('div', 'grow');
    grow.append(el('div', 't', `${p.icon} ${p.name}${p.hasPin ? ' 🔒' : ''}`));
    const open = el('button', null, 'Open here');
    open.onclick = async () => {
      let pin = null;
      if (p.hasPin) {
        pin = prompt(`PIN for “${p.name}”`);
        if (pin === null) return;
      }
      const r = await window.chrome_api.openInProfile(p.id, pin);
      if (r.ok) closeOverlay();
      else if (r.error === 'pin') alert('That PIN is incorrect.');
    };
    row.append(dot, grow, open);
    list.appendChild(row);
  }
}
$('#btnDupTemp').onclick = async () => { await window.chrome_api.duplicateToTemp(); closeOverlay(); };
$('#btnCopyUrl').onclick = () => { window.chrome_api.copyUrl(); closeOverlay(); };

/* ---------------- boot ---------------- */
window.chrome_api.requestState();
