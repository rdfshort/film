(() => {
'use strict';
const API = (window.VUTA_API || '').replace(/\/$/, '') + '/api';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kes = n => 'KSh ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
const dt = d => d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
let sb, session, cfg;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(API + '/admin' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.message || d.error || 'error'), { status: r.status, data: d });
  return d;
}
let tt; const toast = m => { let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.style.bottom = '24px'; document.body.appendChild(el); } el.textContent = m; el.classList.remove('hide'); clearTimeout(tt); tt = setTimeout(() => el.classList.add('hide'), 3000); };
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || 'Failed'); } };

const TABS = [['overview', 'Overview'], ['films', 'Catalogue'], ['pricing', 'Pricing & VIP'], ['payments', 'Payments'], ['users', 'Users'], ['notify', 'Notifications'], ['api', 'Syln API']];
let tab = 'overview';

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-t="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; go(); } });

async function go() {
  renderTabs();
  const v = $('#view'); v.innerHTML = '<div class="center"><div class="spin"></div></div>';
  try { await ({ overview, films, pricing, payments, users, notify, api: apiTab })[tab](v); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ── overview ── */
async function overview(v) {
  const s = await api('/stats');
  const days = Object.keys(s.revenue_by_day).sort(), max = Math.max(1, ...days.map(d => s.revenue_by_day[d]));
  const st = (l, val) => `<div class="stat"><b>${val}</b><span>${l}</span></div>`;
  v.innerHTML = `<div class="stats">${st('Registered users', s.users)}${st('Active VIP subscribers', s.active_vip)}${st('Total revenue', kes(s.revenue_kes))}${st('Coin sales', kes(s.coin_sales_kes))}${st('Coins sold', Number(s.coins_sold).toLocaleString())}${st('Episodes unlocked', s.unlocks)}${st('Pending / failed payments', s.tx_pending + ' / ' + s.tx_failed)}${st('Dramas in catalogue', s.films)}</div>
  <div class="box" style="margin:14px 0"><b>Revenue, last 14 days</b><div class="bars">${days.length ? days.map(d => `<i title="${d}: ${kes(s.revenue_by_day[d])}" style="height:${Math.max(3, s.revenue_by_day[d] / max * 100)}%"></i>`).join('') : '<span class="muted small">No successful payments yet.</span>'}</div></div>`;
}

/* ── catalogue ── */
async function films(v, page = 1, q = '') {
  const d = await api(`/films?page=${page}&q=${encodeURIComponent(q)}`);
  v.innerHTML = `<div class="box" style="margin:0 0 12px"><div class="frm"><div><label class="small muted">Search</label><input id="fq" value="${esc(q)}" placeholder="Title…"></div><button class="btn sm sec" id="fs">Search</button><button class="btn sm" id="sync">Sync from Syln</button></div><p class="small muted" style="margin:8px 0 0">Titles are third-party content provided through the Syln API. Hide anything unavailable or that you are not licensed to show.</p></div>
  <div class="tw"><table><tr><th>Drama</th><th>Eps</th><th>Free eps</th><th>Coin price</th><th>Flags</th><th></th></tr>
  ${d.films.map(f => `<tr data-id="${esc(f.id)}"><td style="min-width:160px"><b>${esc(f.title)}</b><div class="muted small">${esc((f.genres || []).join(', '))}</div></td><td>${f.episode_count}</td>
  <td><input class="n" data-k="free_episodes" type="number" min="0" style="width:76px" value="${f.free_episodes ?? ''}" placeholder="global"></td>
  <td><input class="n" data-k="coin_price" type="number" min="0" style="width:76px" value="${f.coin_price ?? ''}" placeholder="global"></td>
  <td style="white-space:nowrap"><label class="small"><input type="checkbox" data-k="featured" ${f.featured ? 'checked' : ''} style="width:auto"> Featured</label><br><label class="small"><input type="checkbox" data-k="hidden" ${f.hidden ? 'checked' : ''} style="width:auto"> Hidden</label><br><label class="small"><input type="checkbox" data-k="vip_eligible" ${f.vip_eligible ? 'checked' : ''} style="width:auto"> VIP ok</label></td>
  <td><input class="n" data-k="collections" style="width:130px" value="${esc((f.collections || []).join(','))}" placeholder="collections"></td></tr>`).join('')}</table></div>
  <div style="display:flex;gap:8px;justify-content:center"><button class="btn sec sm" id="pp" ${page <= 1 ? 'disabled' : ''}>Prev</button><span class="muted small" style="align-self:center">Page ${page} · ${d.total} dramas</span><button class="btn sec sm" id="np" ${page * d.pageSize >= d.total ? 'disabled' : ''}>Next</button></div>
  <h3 style="margin-top:22px">Collections</h3><div id="colls"></div>`;
  $('#fs').onclick = () => films(v, 1, $('#fq').value.trim());
  $('#fq').onkeydown = e => { if (e.key === 'Enter') $('#fs').click(); };
  $('#pp').onclick = () => films(v, page - 1, q); $('#np').onclick = () => films(v, page + 1, q);
  $('#sync').onclick = guard(async e => { e.target.disabled = true; toast('Syncing…'); const r = await api('/sync', { method: 'POST', body: { pages: 3 } }); if (r.failed?.length) alert(`Saved ${r.synced} dramas.\n\nProblems:\n` + r.failed.join('\n')); else toast(`Saved ${r.synced} dramas`); films(v, 1, q); });
  v.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('change', guard(async e => {
    const k = e.target.dataset.k; if (!k) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    await api('/films/' + encodeURIComponent(tr.dataset.id), { method: 'PATCH', body: { [k]: val === '' ? null : val } }); toast('Saved');
  })));
  collections($('#colls'));
}
async function collections(el) {
  const { items } = await api('/collections');
  el.innerHTML = `<div class="tw"><table><tr><th>Slug</th><th>Title</th><th>VIP only</th><th>Active</th><th>Sort</th><th></th></tr>${items.map(c => `<tr data-s="${esc(c.slug)}"><td>${esc(c.slug)}</td><td><input data-k="title" value="${esc(c.title)}"></td><td><input type="checkbox" data-k="vip_only" ${c.vip_only ? 'checked' : ''} style="width:auto"></td><td><input type="checkbox" data-k="active" ${c.active ? 'checked' : ''} style="width:auto"></td><td><input data-k="sort" type="number" value="${c.sort}" style="width:70px"></td><td><button class="btn sm sec" data-del>Delete</button></td></tr>`).join('')}
  <tr id="newc"><td><input id="ns" placeholder="slug e.g. vip-picks"></td><td><input id="nt" placeholder="Title"></td><td><input type="checkbox" id="nv" style="width:auto"></td><td></td><td></td><td><button class="btn sm" id="addc">Add</button></td></tr></table></div><p class="small muted">Assign a drama to a collection by typing its slug in the drama's “collections” box above. VIP-only collections require VIP for premium episodes.</p>`;
  const save = guard(async tr => { await api('/collections/' + tr.dataset.s, { method: 'PUT', body: { title: $('[data-k=title]', tr).value, vip_only: $('[data-k=vip_only]', tr).checked, active: $('[data-k=active]', tr).checked, sort: $('[data-k=sort]', tr).value } }); toast('Saved'); });
  el.querySelectorAll('tr[data-s]').forEach(tr => { tr.addEventListener('change', () => save(tr)); $('[data-del]', tr).onclick = guard(async () => { await api('/collections/' + tr.dataset.s, { method: 'DELETE' }); collections(el); }); });
  $('#addc', el).onclick = guard(async () => { const s = $('#ns', el).value.trim(); if (!s) return; await api('/collections/' + encodeURIComponent(s), { method: 'PUT', body: { title: $('#nt', el).value || s, vip_only: $('#nv', el).checked } }); collections(el); });
}

/* ── pricing, settings, VIP ── */
async function pricing(v) {
  const [set, pk, pl] = await Promise.all([api('/settings'), api('/packages'), api('/plans')]);
  const pm = set.payment_methods || {};
  v.innerHTML = `<h3 style="margin-top:0">Global settings</h3><div class="box" style="margin:0 0 14px"><div class="frm">
    <div><label class="small muted">Free episodes per drama</label><input id="s_free" type="number" min="0" value="${set.free_episodes ?? 3}"></div>
    <div><label class="small muted">Default coins per premium episode</label><input id="s_price" type="number" min="1" value="${set.default_coin_price ?? 20}"></div>
    <div><label class="small muted">Site name</label><input id="s_name" value="${esc(set.site_name || 'VUTA')}"></div></div>
    <div style="margin:12px 0;display:flex;gap:18px;flex-wrap:wrap">${[['mpesa', 'M-Pesa STK Push'], ['card', 'Visa / Mastercard'], ['apple_pay', 'Apple Pay']].map(([k, l]) => `<label><input type="checkbox" data-pm="${k}" ${pm[k] ? 'checked' : ''} style="width:auto"> ${l}</label>`).join('')}</div>
    <button class="btn sm" id="saveset">Save settings</button></div>
  <h3>Coin packages</h3><div class="tw"><table><tr><th>Coins</th><th>Price (KSh)</th><th>Label</th><th>Sort</th><th>Active</th><th></th></tr>
  ${pk.items.map(p => `<tr data-id="${p.id}"><td><input data-k="coins" type="number" value="${p.coins}" style="width:90px"></td><td><input data-k="price_kes" type="number" step="0.01" value="${p.price_kes}" style="width:100px"></td><td><input data-k="label" value="${esc(p.label || '')}"></td><td><input data-k="sort" type="number" value="${p.sort}" style="width:60px"></td><td><input data-k="active" type="checkbox" ${p.active ? 'checked' : ''} style="width:auto"></td><td><button class="btn sm sec" data-save>Save</button></td></tr>`).join('')}
  <tr id="newp"><td><input id="np_c" type="number" placeholder="coins" style="width:90px"></td><td><input id="np_p" type="number" placeholder="KSh" style="width:100px"></td><td colspan="3"></td><td><button class="btn sm" id="addp">Add</button></td></tr></table></div>
  <h3>VIP plans</h3><p class="small muted">Optional: paste a Paystack plan code to enable automatic card renewal. M-Pesa purchases cover one period and do not auto-renew.</p>
  <div class="tw"><table><tr><th>Name</th><th>Days</th><th>Price (KSh)</th><th>Benefits (one per line)</th><th>Paystack plan</th><th>Active</th><th></th></tr>
  ${pl.items.map(p => `<tr data-id="${p.id}"><td><input data-k="name" value="${esc(p.name)}"><div class="muted small">${esc(p.code)}</div></td><td><input data-k="days" type="number" value="${p.days}" style="width:70px"></td><td><input data-k="price_kes" type="number" step="0.01" value="${p.price_kes}" style="width:90px"></td><td><textarea data-k="benefits" rows="3" style="min-width:200px">${esc((p.benefits || []).join('\n'))}</textarea></td><td><input data-k="paystack_plan_code" value="${esc(p.paystack_plan_code || '')}" placeholder="PLN_xxx"></td><td><input data-k="active" type="checkbox" ${p.active ? 'checked' : ''} style="width:auto"></td><td><button class="btn sm sec" data-save>Save</button></td></tr>`).join('')}</table></div>`;
  $('#saveset').onclick = guard(async () => {
    const payment_methods = {}; v.querySelectorAll('[data-pm]').forEach(c => { payment_methods[c.dataset.pm] = c.checked; });
    await api('/settings', { method: 'PUT', body: { free_episodes: Number($('#s_free').value), default_coin_price: Number($('#s_price').value), site_name: $('#s_name').value.trim() || 'VUTA', payment_methods } }); toast('Settings saved');
  });
  const rowBody = tr => { const o = {}; tr.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; }); return o; };
  v.querySelectorAll('tr[data-id]').forEach(tr => $('[data-save]', tr).onclick = guard(async () => {
    const isPlan = !!$('[data-k=days]', tr);
    await api((isPlan ? '/plans/' : '/packages/') + tr.dataset.id, { method: 'PUT', body: rowBody(tr) }); toast('Saved');
  }));
  $('#addp').onclick = guard(async () => { await api('/packages', { method: 'POST', body: { coins: $('#np_c').value, price_kes: $('#np_p').value } }); pricing(v); });
}

/* ── payments ── */
async function payments(v, status = '', page = 1) {
  const d = await api(`/transactions?page=${page}&status=${status}`);
  v.innerHTML = `<div class="chips" style="padding:0 0 10px">${['', 'success', 'pending', 'failed', 'refunded'].map(s => `<button class="chip ${s === status ? 'on' : ''}" data-s="${s}">${s || 'All'}</button>`).join('')}</div>
  <div class="tw"><table><tr><th>Date</th><th>User</th><th>Type</th><th>Amount</th><th>Channel</th><th>Status</th><th>Reference</th><th></th></tr>
  ${d.items.map(t => `<tr><td>${dt(t.created_at)}</td><td>${esc(t.profiles?.email || '')}</td><td>${t.kind === 'vip' ? 'VIP' : (t.coins + ' coins')}</td><td>${kes(t.amount_kes)}</td><td>${esc(t.channel || '')}</td><td><span class="st ${t.status}">${t.status}</span></td><td class="small muted">${esc(t.reference)}</td><td>${t.status === 'success' ? `<button class="btn sm sec" data-ref="${esc(t.reference)}">Refund</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No transactions.</td></tr>'}</table></div>
  <div style="display:flex;gap:8px;justify-content:center"><button class="btn sec sm" id="pp" ${page <= 1 ? 'disabled' : ''}>Prev</button><span class="muted small" style="align-self:center">Page ${page} · ${d.total}</span><button class="btn sec sm" id="np" ${page * d.pageSize >= d.total ? 'disabled' : ''}>Next</button></div>`;
  v.querySelectorAll('[data-s]').forEach(b => b.onclick = () => payments(v, b.dataset.s, 1));
  $('#pp').onclick = () => payments(v, status, page - 1); $('#np').onclick = () => payments(v, status, page + 1);
  v.querySelectorAll('[data-ref]').forEach(b => b.onclick = guard(async () => {
    if (!confirm('Refund this payment via Paystack and reverse the coins/VIP it granted?')) return;
    await api(`/transactions/${b.dataset.ref}/refund`, { method: 'POST' }); toast('Refunded'); payments(v, status, page);
  }));
}

/* ── users ── */
async function users(v, q = '', page = 1) {
  const d = await api(`/users?page=${page}&q=${encodeURIComponent(q)}`);
  v.innerHTML = `<div class="frm" style="margin-bottom:10px"><div><input id="uq" placeholder="Search email…" value="${esc(q)}"></div><button class="btn sm sec" id="us">Search</button></div>
  <div class="tw"><table><tr><th>User</th><th>Coins</th><th>VIP until</th><th>Role</th><th>Joined</th><th></th></tr>
  ${d.items.map(u => `<tr data-id="${u.id}"><td>${esc(u.email)}<div class="muted small">${esc(u.display_name || '')}</div></td><td>${u.wallets?.balance ?? 0}</td><td>${u.vip_until && new Date(u.vip_until) > new Date() ? dt(u.vip_until) : '—'}</td><td>${u.role}</td><td>${dt(u.created_at)}</td>
  <td style="white-space:nowrap"><button class="btn sm sec" data-coins>± Coins</button> <button class="btn sm sec" data-dis>${u.disabled ? 'Enable' : 'Disable'}</button> <button class="btn sm sec" data-role="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button></td></tr>`).join('')}</table></div>
  <div style="display:flex;gap:8px;justify-content:center"><button class="btn sec sm" id="pp" ${page <= 1 ? 'disabled' : ''}>Prev</button><span class="muted small" style="align-self:center">Page ${page} · ${d.total}</span><button class="btn sec sm" id="np" ${page * d.pageSize >= d.total ? 'disabled' : ''}>Next</button></div>`;
  $('#us').onclick = () => users(v, $('#uq').value.trim(), 1); $('#uq').onkeydown = e => { if (e.key === 'Enter') $('#us').click(); };
  $('#pp').onclick = () => users(v, q, page - 1); $('#np').onclick = () => users(v, q, page + 1);
  const row = d.items.reduce((m, u) => (m[u.id] = u, m), {});
  v.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    $('[data-coins]', tr).onclick = guard(async () => { const n = prompt('Add (positive) or remove (negative) coins:', '50'); if (!n) return; const r = await api(`/users/${id}/coins`, { method: 'POST', body: { delta: n, note: 'admin' } }); if (!r.ok) throw new Error('Not allowed (balance cannot go below 0)'); toast('Balance: ' + r.balance); users(v, q, page); });
    $('[data-dis]', tr).onclick = guard(async () => { await api('/users/' + id, { method: 'PATCH', body: { disabled: !row[id].disabled } }); users(v, q, page); });
    $('[data-role]', tr).onclick = guard(async e => { if (!confirm('Change this user\'s role?')) return; await api('/users/' + id, { method: 'PATCH', body: { role: e.target.dataset.role } }); users(v, q, page); });
  });
}

/* ── notifications ── */
async function notify(v) {
  const d = await api('/notifications');
  v.innerHTML = `<div class="card" style="padding:14px;margin-bottom:14px"><b>Send a notification</b>
    <div class="muted small" style="margin:4px 0 10px">${d.devices} phone${d.devices === 1 ? '' : 's'} registered for push. ${d.pushReady ? '' : '<b style="color:#ff6b6b">Push is not set up on the server yet, so messages only appear in the in-app inbox.</b>'}</div>
    <div class="frm" style="flex-direction:column;align-items:stretch;gap:8px">
      <select id="na"><option value="all">Everyone</option><option value="vip">VIP members</option><option value="user">One user (by email)</option></select>
      <input id="ne" class="hide" placeholder="User email">
      <input id="nt" maxlength="80" placeholder="Title, e.g. New dramas this week">
      <input id="nb" maxlength="200" placeholder="Message (optional)">
      <select id="nu"><option value="">Opens the app</option><option value="#/home">Opens Home</option><option value="#/wallet">Opens Wallet</option><option value="#/discover">Opens Discover</option></select>
      <button class="btn" id="ns">Send</button></div></div>
    <div class="tw"><table><tr><th>Date</th><th>To</th><th>Title</th><th>Message</th></tr>${d.items.map(n => `<tr><td>${dt(n.created_at)}</td><td>${esc(n.audience)}</td><td>${esc(n.title)}</td><td>${esc(n.body)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing sent yet.</td></tr>'}</table></div>`;
  $('#na').onchange = () => $('#ne').classList.toggle('hide', $('#na').value !== 'user');
  $('#ns').onclick = guard(async () => {
    const title = $('#nt').value.trim(); if (!title) return toast('Add a title');
    if (!confirm('Send this notification now?')) return;
    const r = await api('/notify', { method: 'POST', body: { audience: $('#na').value, email: $('#ne').value, title, body: $('#nb').value, url: $('#nu').value } });
    toast(`Sent. Pushed to ${r.pushed} phone${r.pushed === 1 ? '' : 's'}.`); notify(v);
  });
}

/* ── Syln API ── */
async function apiTab(v, errorsOnly = false) {
  const [s, l] = await Promise.all([api('/api-status'), api('/logs' + (errorsOnly ? '?errors=1' : ''))]);
  v.innerHTML = `<div class="box" style="margin:0 0 12px"><div><span class="dot ${s.ok ? 'ok' : 'bad'}"></span><b>${s.ok ? 'Connected' : 'Not connected'}</b> <span class="muted small">${esc(s.base)}</span></div>
  <div class="muted small" style="margin-top:6px">Token configured: ${s.tokenConfigured ? 'yes' : '<b style="color:var(--err)">no — set SYLN_API_TOKEN on the server</b>'} · Latency: ${s.ms} ms · Platforms: ${s.platforms ?? '—'} · Last ${s.recentRequests} requests: ${s.recentErrors} errors</div>
  ${s.ok ? '' : `<div class="err">${esc(s.error || '')}. If the token is set, check the endpoint paths and auth header in the server .env against the Syln docs.</div>`}
  <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" id="rc">Re-check</button><button class="btn sm sec" id="eo">${errorsOnly ? 'Show all' : 'Errors only'}</button></div></div>
  <div class="tw"><table><tr><th>Time</th><th>Endpoint</th><th>Status</th><th>ms</th><th>Error</th></tr>${l.items.map(r => `<tr><td>${dt(r.ts)}</td><td class="small">${esc(r.endpoint)}</td><td>${r.status || '—'}</td><td>${r.ms ?? ''}</td><td class="small" style="color:var(--err)">${esc(r.error || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No requests logged yet.</td></tr>'}</table></div>`;
  $('#rc').onclick = () => apiTab(v, errorsOnly); $('#eo').onclick = () => apiTab(v, !errorsOnly);
}

/* ── boot ── */
(async () => {
  const gate = $('#gate');
  try {
    cfg = await (await fetch(API + '/public-config')).json();
    sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    session = (await sb.auth.getSession()).data.session;
    if (!session) { gate.innerHTML = '<p>Please log in on the main site first, then reopen this page.</p><a class="btn" href="index.html">Go to site</a>'; return; }
    await api('/stats'); // 403 for non-admins
    gate.classList.add('hide'); $('#app').classList.remove('hide');
    sb.auth.onAuthStateChange((_e, s) => { if (s) session = s; });
    go();
  } catch (e) {
    const back = '<a class="btn" href="index.html">Back to site</a>';
    if (e.status === 403) gate.innerHTML = '<p>This account is not an administrator.</p>' + back;
    else if (e.status === 401) gate.innerHTML = '<p>Your login has expired. Log out and log in again on the main site, then reopen this page.</p>' + back;
    else gate.innerHTML = `<p>Could not load the admin page.</p><p class="muted small">Reason: ${esc(e.status ? 'server replied ' + e.status + ' (' + (e.data?.error || e.message) + ')' : e.message || 'unknown')}</p><p class="muted small">Check <a href="/api/health" style="color:var(--ac)">/api/health</a> and <a href="/api/public-config" style="color:var(--ac)">/api/public-config</a>.</p>` + back;
  }
})();
})();
