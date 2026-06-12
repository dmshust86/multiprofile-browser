'use strict';
/* Partitions dashboard renderer. Talks to main only through window.api. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

let META = { colors: [], icons: [], searchEngines: [] };
let PROFILES = [];
let ACTIVE = [];
let SETTINGS = { domainRules: [], timers: [] };
const selected = new Set();

/* ---------------- PIN prompt (returns string or null) ---------------- */
function askPin(title) {
  return new Promise((resolve) => {
    const dlg = $('#pinModal');
    $('#pinTitle').textContent = title || 'Enter PIN';
    $('#pinError').classList.add('hidden');
    $('#pinInput').value = '';
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? $('#pinInput').value : null);
    };
    dlg.addEventListener('close', onClose);
    $('#pinForm').onsubmit = () => { dlg.returnValue = 'ok'; };
    $('#btnPinCancel').onclick = () => { dlg.returnValue = ''; dlg.close(); };
    dlg.showModal();
    $('#pinInput').focus();
  });
}
function pinErrorFlash() {
  const dlg = $('#pinModal');
  if (dlg.open) return;
  $('#pinError').classList.remove('hidden');
}

async function launchWithPin(profile) {
  if (!profile.hasPin) { await window.api.launchProfile(profile.id, null); return; }
  // loop until correct or cancelled
  for (;;) {
    const pin = await askPin(`Unlock “${profile.name}”`);
    if (pin === null) return;
    const r = await window.api.launchProfile(profile.id, pin);
    if (r.ok) return;
    $('#pinError').classList.remove('hidden');
    const again = await askPin(`Unlock “${profile.name}” — try again`);
    if (again === null) return;
    const r2 = await window.api.launchProfile(profile.id, again);
    if (r2.ok) return;
  }
}

/* ---------------- data load & render ---------------- */
async function refresh() {
  [PROFILES, ACTIVE, SETTINGS] = await Promise.all([
    window.api.listProfiles(),
    window.api.listActive(),
    window.api.getSettings()
  ]);
  renderProfiles();
  renderSessions();
  renderRules();
  renderTimers();
}

function isLive(profileId) {
  return ACTIVE.some((w) => w.profileId === profileId);
}

function profileCard(p) {
  const card = el('div', 'card');
  if (selected.has(p.id)) card.classList.add('selected');

  const spine = el('div', 'spine'); spine.style.background = p.color;
  card.appendChild(spine);

  const check = el('input', 'check');
  check.type = 'checkbox';
  check.checked = selected.has(p.id);
  check.title = 'Select for “Open selected”';
  check.onchange = () => {
    check.checked ? selected.add(p.id) : selected.delete(p.id);
    card.classList.toggle('selected', check.checked);
    $('#btnOpenSelected').disabled = selected.size === 0;
  };
  card.appendChild(check);

  const head = el('div', 'card-head');
  const icon = el('div', 'card-icon', p.icon); icon.style.background = p.color;
  const titleWrap = el('div');
  const title = el('div', 'card-title', p.name);
  if (p.hasPin) title.appendChild(el('span', 'lock-badge', ' 🔒'));
  const status = el('div', 'card-status');
  status.innerHTML = isLive(p.id)
    ? '<span class="live">● open now</span>'
    : `last opened ${fmtTime(p.lastOpenedAt)}`;
  titleWrap.append(title, status);
  head.append(icon, titleWrap);
  card.appendChild(head);

  card.appendChild(el('p', 'card-note', p.note || ''));

  const meta = el('div', 'card-meta');
  meta.append(el('span', null, p.partition.replace('persist:', '')));
  card.appendChild(meta);

  const actions = el('div', 'card-actions');
  const launch = el('button', 'primary grow', isLive(p.id) ? 'Focus window' : 'Launch');
  launch.onclick = () => launchWithPin(p);
  const edit = el('button', 'ghost', 'Edit');
  edit.onclick = () => openProfileModal(p);
  const arch = el('button', 'ghost', p.archived ? 'Restore' : 'Archive');
  arch.onclick = async () => { await window.api.updateProfile(p.id, { archived: !p.archived }); refresh(); };
  actions.append(launch, edit, arch);
  card.appendChild(actions);

  return card;
}

function renderProfiles() {
  const grid = $('#profileGrid'); grid.innerHTML = '';
  const live = PROFILES.filter((p) => !p.archived);
  if (!live.length) grid.appendChild(el('div', 'empty', 'No profiles yet. Create one to get a fully isolated browser identity.'));
  for (const p of live) grid.appendChild(profileCard(p));

  const archived = PROFILES.filter((p) => p.archived);
  $('#archivedWrap').classList.toggle('hidden', archived.length === 0);
  const agrid = $('#archivedGrid'); agrid.innerHTML = '';
  for (const p of archived) agrid.appendChild(profileCard(p));

  $('#btnOpenSelected').disabled = selected.size === 0;
}

function renderSessions() {
  const act = $('#activeList'); act.innerHTML = '';
  if (!ACTIVE.length) act.appendChild(el('div', 'empty', 'No browser windows are open.'));
  for (const w of ACTIVE) {
    const row = el('div', 'row');
    const dot = el('span', 'dot'); dot.style.background = w.color;
    const grow = el('div', 'grow');
    grow.append(el('div', 'name', `${w.icon} ${w.name}${w.temp ? '  (temporary)' : ''}`));
    grow.append(el('div', 'sub', `${w.tabCount} tab${w.tabCount === 1 ? '' : 's'} · ${w.urls[0] || ''}`));
    const close = el('button', 'ghost', 'Close');
    close.onclick = async () => { await window.api.closeWindow(w.key); setTimeout(refresh, 250); };
    row.append(dot, grow);
    if (w.temp) {
      const rename = el('button', 'ghost', 'Rename');
      rename.onclick = async () => {
        const name = prompt('Session name', w.name);
        if (name) { await window.api.renameTemp(w.tempId, name); refresh(); }
      };
      row.append(rename);
    }
    row.append(close);
    act.appendChild(row);
  }

  const saved = $('#savedList'); saved.innerHTML = '';
  for (const p of PROFILES) {
    const row = el('div', 'row');
    const dot = el('span', 'dot'); dot.style.background = p.color;
    const grow = el('div', 'grow');
    grow.append(el('div', 'name', `${p.icon} ${p.name}${p.archived ? '  (archived)' : ''}`));
    grow.append(el('div', 'sub', `status: ${isLive(p.id) ? 'open' : 'closed'} · last launch ${fmtTime(p.lastOpenedAt)}`));
    const launch = el('button', 'ghost', isLive(p.id) ? 'Focus' : 'Launch');
    launch.onclick = () => launchWithPin(p);
    const rename = el('button', 'ghost', 'Rename');
    rename.onclick = async () => {
      const name = prompt('Profile name', p.name);
      if (name) { await window.api.updateProfile(p.id, { name }); refresh(); }
    };
    const arch = el('button', 'ghost', p.archived ? 'Restore' : 'Archive');
    arch.onclick = async () => { await window.api.updateProfile(p.id, { archived: !p.archived }); refresh(); };
    const del = el('button', 'danger', 'Delete');
    del.onclick = async () => {
      let pin = null;
      if (p.hasPin) { pin = await askPin(`PIN for “${p.name}”`); if (pin === null) return; }
      await window.api.deleteProfile(p.id, pin);
      refresh();
    };
    row.append(dot, grow, launch, rename, arch, del);
    saved.appendChild(row);
  }
}

/* ---------------- domain rules ---------------- */
function renderRules() {
  const sel = $('#ruleProfile'); sel.innerHTML = '';
  for (const p of PROFILES.filter((x) => !x.archived)) {
    const o = el('option', null, p.name); o.value = p.id; sel.appendChild(o);
  }
  const list = $('#rulesList'); list.innerHTML = '';
  const rules = SETTINGS.domainRules || [];
  if (!rules.length) list.appendChild(el('div', 'empty', 'No rules yet. By default every profile stays fully isolated and you choose where links open.'));
  rules.forEach((r, idx) => {
    const p = PROFILES.find((x) => x.id === r.profileId);
    const row = el('div', 'row');
    const dot = el('span', 'dot'); dot.style.background = p ? p.color : '#555';
    const grow = el('div', 'grow');
    grow.append(el('div', 'name', r.domain));
    grow.append(el('div', 'sub', `opens in ${p ? p.name : '(deleted profile)'}`));
    const del = el('button', 'ghost', 'Remove');
    del.onclick = async () => {
      rules.splice(idx, 1);
      await window.api.setSettings({ domainRules: rules });
      refresh();
    };
    row.append(dot, grow, del);
    list.appendChild(row);
  });
}

$('#btnAddRule').onclick = async () => {
  const domain = $('#ruleDomain').value.trim().replace(/^https?:\/\//, '').split('/')[0];
  const profileId = $('#ruleProfile').value;
  if (!domain || !profileId) return;
  const rules = SETTINGS.domainRules || [];
  rules.push({ domain, profileId });
  await window.api.setSettings({ domainRules: rules });
  $('#ruleDomain').value = '';
  refresh();
};

/* ---------------- quick open ---------------- */
async function quickOpen() {
  const url = $('#quickUrl').value.trim();
  if (!url) return;
  const r = await window.api.openSmart(url);
  if (r.ok) { $('#quickUrl').value = ''; return; }
  if (r.error === 'pin') {
    const p = PROFILES.find((x) => x.id === r.profileId);
    if (p) await launchWithPin(p);
    return;
  }
  $('#quickUrl').value = '';
  alert('No domain rule matched this URL. Add a rule in “Domain rules”, or launch a profile and open the link there.');
}
$('#btnQuickOpen').onclick = quickOpen;
$('#quickUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickOpen(); });

/* ---------------- profile editor modal ---------------- */
let editingId = null;
let chosenColor = null;
let chosenIcon = null;

function buildSwatches() {
  const colors = $('#fColors'); colors.innerHTML = '';
  for (const c of META.colors) {
    const s = el('button', 'swatch'); s.type = 'button'; s.style.background = c;
    s.onclick = () => { chosenColor = c; [...colors.children].forEach((x) => x.classList.toggle('sel', x === s)); };
    s.dataset.value = c;
    colors.appendChild(s);
  }
  const icons = $('#fIcons'); icons.innerHTML = '';
  for (const i of META.icons) {
    const s = el('button', 'swatch', i); s.type = 'button';
    s.onclick = () => { chosenIcon = i; [...icons.children].forEach((x) => x.classList.toggle('sel', x === s)); };
    s.dataset.value = i;
    icons.appendChild(s);
  }
  const se = $('#fSearch'); se.innerHTML = '';
  for (const e of META.searchEngines) {
    const o = el('option', null, e.name); o.value = e.id; se.appendChild(o);
  }
}

function openProfileModal(p) {
  editingId = p ? p.id : null;
  $('#modalTitle').textContent = p ? `Edit “${p.name}”` : 'New profile';
  $('#fName').value = p ? p.name : '';
  $('#fHome').value = p ? p.homepage : 'https://duckduckgo.com';
  $('#fNote').value = p ? p.note : '';
  $('#fSearch').value = p ? p.searchEngine : 'duckduckgo';
  $('#fStartup').value = p ? (p.startupBehavior === 'urls' ? 'urls' : 'homepage') : 'homepage';
  $('#fStartupUrls').value = p ? (p.startupUrls || []).join('\n') : '';
  $('#fDownloadDir').value = p ? (p.downloadDir || '') : '';
  $('#fPinCurrent').value = ''; $('#fPinNew').value = '';
  $('#pinMsg').textContent = p && p.hasPin
    ? 'This profile is PIN-locked. Enter the current PIN to change or remove it.'
    : 'A PIN is required to open or delete a locked profile on this Mac.';
  $('#btnDeleteProfile').classList.toggle('hidden', !p);
  $('#fStartupUrlsWrap').style.display = $('#fStartup').value === 'urls' ? '' : 'none';

  chosenColor = p ? p.color : META.colors[0];
  chosenIcon = p ? p.icon : META.icons[0];
  [...$('#fColors').children].forEach((x) => x.classList.toggle('sel', x.dataset.value === chosenColor));
  [...$('#fIcons').children].forEach((x) => x.classList.toggle('sel', x.dataset.value === chosenIcon));

  $('#profileModal').showModal();
  $('#fName').focus();
}

$('#fStartup').onchange = () => {
  $('#fStartupUrlsWrap').style.display = $('#fStartup').value === 'urls' ? '' : 'none';
};

$('#btnPickDir').onclick = async () => {
  const dir = await window.api.chooseDownloadDir();
  if (dir) $('#fDownloadDir').value = dir;
};
$('#btnClearDir').onclick = () => { $('#fDownloadDir').value = ''; };

$('#btnSavePin').onclick = async () => {
  if (!editingId) { $('#pinMsg').textContent = 'Save the profile first, then set a PIN.'; return; }
  const r = await window.api.setPin(editingId, $('#fPinCurrent').value || null, $('#fPinNew').value || null);
  $('#pinMsg').textContent = r.ok
    ? ($('#fPinNew').value ? 'PIN updated.' : 'PIN removed.')
    : r.error;
  if (r.ok) { $('#fPinCurrent').value = ''; $('#fPinNew').value = ''; refresh(); }
};

$('#profileForm').onsubmit = async (e) => {
  const payload = {
    name: $('#fName').value.trim(),
    homepage: $('#fHome').value.trim() || 'https://duckduckgo.com',
    note: $('#fNote').value,
    color: chosenColor,
    icon: chosenIcon,
    searchEngine: $('#fSearch').value,
    startupBehavior: $('#fStartup').value,
    startupUrls: $('#fStartupUrls').value.split('\n').map((s) => s.trim()).filter(Boolean)
  };
  const dir = $('#fDownloadDir').value;
  payload.downloadDir = dir || '';
  if (editingId) await window.api.updateProfile(editingId, payload);
  else await window.api.createProfile(payload);
  refresh();
};

$('#btnCancelModal').onclick = () => $('#profileModal').close();
$('#btnDeleteProfile').onclick = async () => {
  const p = PROFILES.find((x) => x.id === editingId);
  if (!p) return;
  let pin = null;
  if (p.hasPin) { pin = await askPin(`PIN for “${p.name}”`); if (pin === null) return; }
  const r = await window.api.deleteProfile(p.id, pin);
  if (r.ok) { $('#profileModal').close(); refresh(); }
  else if (r.error) alert(r.error);
};

/* ---------------- bulk actions ---------------- */
$('#btnNewProfile').onclick = () => openProfileModal(null);
$('#btnNewTemp').onclick = () => window.api.newTemp();
$('#btnOpenAll').onclick = async () => {
  const r = await window.api.openAll();
  for (const id of r.locked || []) {
    const p = PROFILES.find((x) => x.id === id);
    if (p) await launchWithPin(p);
  }
};
$('#btnOpenSelected').onclick = async () => {
  const ids = [...selected];
  const r = await window.api.launchMany(ids);
  for (const id of r.locked || []) {
    const p = PROFILES.find((x) => x.id === id);
    if (p) await launchWithPin(p);
  }
  selected.clear();
  refresh();
};
$('#btnOneWindow').onclick = async () => {
  // Selected profiles if any are checked, otherwise all of them.
  const ids = selected.size ? [...selected] : null;
  const r = await window.api.openWorkspace(ids);
  if (!r.ok && r.error) { alert(r.error); return; }
  if ((r.locked || []).length) {
    const names = r.locked
      .map((id) => PROFILES.find((x) => x.id === id))
      .filter(Boolean).map((p) => p.name).join(', ');
    alert(`PIN-locked profiles are skipped in shared windows — launch these individually: ${names}`);
  }
  selected.clear();
  refresh();
};
$('#btnReopenClosed').onclick = async () => {
  const r = await window.api.reopenClosed();
  if (!r.ok) alert('Nothing to reopen yet.');
};

/* ---------------- view switching ---------------- */
$('#navTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
});

/* ---------------- time tools ---------------- */
function populateZones() {
  const sel = $('#clockZone');
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']);
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const z of zones) {
    const o = el('option', null, z); o.value = z;
    if (z === current) o.selected = true;
    sel.appendChild(o);
  }
}
function tickClock() {
  const zone = $('#clockZone').value || undefined;
  const now = new Date();
  $('#clockFace').textContent = now.toLocaleTimeString([], { hour12: false, timeZone: zone });
  $('#clockDate').textContent = now.toLocaleDateString([], { weekday: 'long', dateStyle: undefined, timeZone: zone }) +
    ' · ' + now.toLocaleDateString([], { dateStyle: 'long', timeZone: zone });
}

const firedTimers = new Set();
function renderTimers() {
  const list = $('#timerList'); list.innerHTML = '';
  const timers = SETTINGS.timers || [];
  if (!timers.length) list.appendChild(el('div', 'empty', 'No countdowns saved.'));
  timers.forEach((t, idx) => {
    const row = el('div', 'row');
    const grow = el('div', 'grow');
    grow.append(el('div', 'name', t.label || 'Countdown'));
    const remaining = el('div', 'timer-remaining');
    remaining.dataset.endsAt = t.endsAt;
    remaining.dataset.id = t.id;
    remaining.dataset.label = t.label || 'Countdown';
    grow.append(remaining);
    grow.append(el('div', 'sub', new Date(t.endsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + (t.timeZone ? ` · ${t.timeZone}` : '')));
    const del = el('button', 'ghost', 'Remove');
    del.onclick = async () => {
      timers.splice(idx, 1);
      await window.api.setSettings({ timers });
      refresh();
    };
    row.append(grow, del);
    list.appendChild(row);
  });
}
function tickTimers() {
  document.querySelectorAll('.timer-remaining').forEach((n) => {
    const ends = Number(n.dataset.endsAt);
    const diff = ends - Date.now();
    if (diff <= 0) {
      n.textContent = 'Finished';
      n.classList.add('done');
      if (!firedTimers.has(n.dataset.id)) {
        firedTimers.add(n.dataset.id);
        window.api.fireTimer(n.dataset.label);
      }
    } else {
      const s = Math.floor(diff / 1000);
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      n.textContent = (d ? `${d}d ` : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }
  });
}
$('#btnAddTimer').onclick = async () => {
  const when = $('#timerWhen').value;
  if (!when) return;
  const timers = SETTINGS.timers || [];
  timers.push({
    id: String(Date.now()),
    label: $('#timerLabel').value.trim() || 'Countdown',
    endsAt: new Date(when).getTime(),
    timeZone: $('#clockZone').value
  });
  await window.api.setSettings({ timers });
  $('#timerLabel').value = ''; $('#timerWhen').value = '';
  refresh();
};

/* ---------------- proxy panel ---------------- */
function proxyModeToggle() {
  const rotating = $('#pxMode').value !== 'static';
  $('#pxRotating').classList.toggle('hidden', !rotating);
  $('#pxStatic').classList.toggle('hidden', rotating);
}

async function loadProxy() {
  const c = await window.api.getProxy();
  $('#pxEnabled').checked = !!c.enabled;
  $('#pxMode').value = c.mode || 'rotating';
  $('#pxScheme').value = c.scheme || 'http';
  $('#pxHost').value = c.host || '';
  $('#pxPort').value = c.port || '';
  $('#pxUser').value = c.usernameTemplate || '';
  $('#pxPass').value = '';
  $('#pxPass').placeholder = c.hasPassword ? '(unchanged — type to replace)' : '';
  $('#pxCountry').value = c.country || '';
  $('#pxRegion').value = c.region || '';
  $('#pxPool').value = '';
  $('#pxPool').placeholder = c.poolCount
    ? `${c.poolCount} IP(s) saved — type to replace`
    : 'host:port:user:pass';
  proxyModeToggle();
}

async function saveProxy() {
  const patch = {
    enabled: $('#pxEnabled').checked,
    mode: $('#pxMode').value,
    scheme: $('#pxScheme').value,
    host: $('#pxHost').value.trim(),
    port: $('#pxPort').value.trim(),
    usernameTemplate: $('#pxUser').value.trim(),
    country: $('#pxCountry').value.trim(),
    region: $('#pxRegion').value.trim()
  };
  if ($('#pxPass').value) patch.password = $('#pxPass').value;
  if ($('#pxPool').value.trim()) patch.pool = $('#pxPool').value;
  await window.api.setProxy(patch);
}

$('#pxMode').onchange = proxyModeToggle;

$('#pxSave').onclick = async () => {
  await saveProxy();
  await loadProxy();
  $('#pxSavedMsg').textContent = 'Saved. New settings apply the next time you open a profile.';
  setTimeout(() => { $('#pxSavedMsg').textContent = ''; }, 4000);
};

$('#pxTest').onclick = async () => {
  const out = $('#pxTestResult');
  out.classList.remove('error');
  out.textContent = 'Testing…';
  await saveProxy(); // test current field values
  const r = await window.api.testProxy();
  if (r && r.ok) {
    out.classList.remove('error');
    out.textContent = `OK — egress IP ${r.ip}${r.ms != null ? ` (${r.ms} ms)` : ''}`;
  } else {
    out.classList.add('error');
    out.textContent = (r && r.error) || 'Test failed.';
  }
  await loadProxy();
};

/* ---------------- boot ---------------- */
(async function boot() {
  META = await window.api.profileMeta();
  buildSwatches();
  populateZones();
  await refresh();
  await loadProxy();
  window.api.onStateChanged(() => refresh());
  setInterval(tickClock, 1000); tickClock();
  setInterval(tickTimers, 1000);
  setInterval(async () => { ACTIVE = await window.api.listActive(); renderProfiles(); renderSessions(); }, 5000);
})();
