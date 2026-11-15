(() => {
'use strict';
const API = (window.VUTA_API || '').replace(/\/$/, '') + '/api';
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Prices are stored and charged in KES. Visitors outside Kenya are shown USD (KES / rate, default 130).
const fmtKesOnly = n => 'KSh ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
function cur() {
  try { const p = localStorage.getItem('vuta_cur'); if (p === 'KES' || p === 'USD') return p; } catch {}
  try { if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Africa/Nairobi') return 'KES'; } catch {}
  const c = S.cfg && S.cfg.country; if (c) return c === 'KE' ? 'KES' : 'USD';
  return /-KE\b/i.test(navigator.language || '') ? 'KES' : 'USD';
}
const usdRate = () => Number(S.cfg && S.cfg.usdRate) || 130;
const fmtKes = n => cur() === 'USD' ? '$' + (Number(n) / usdRate()).toFixed(2) : fmtKesOnly(n);
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtDate = d => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });

const IC = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  lib: '<rect x="4" y="4" width="4" height="16" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><path d="M16.5 5.5l3.5 1-3.5 13-3.5-1"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  coin: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.7-1 1.4-2.5 1.8-2.5.7-2.5 1.8S10.5 16 12 16s2.5-.5 2.5-1.5" stroke="#201400" fill="none"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10a2 2 0 1 0 0 4M17 10a2 2 0 1 0 0 4"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  bell: '<path d="M6 17v-6a6 6 0 0 1 12 0v6l2 2H4zM10 21h4"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
};
const ic = n => `<svg class="i" viewBox="0 0 24 24">${IC[n]}</svg>`;

const S = { unread: 0, cfg: null, sb: null, session: null, me: null, film: {}, afterPay: null };

/* ───────── network ───────── */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (NATIVE) headers['X-Client'] = 'native';
  if (auth && S.session) headers.Authorization = 'Bearer ' + S.session.access_token;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 25000);
  let r;
  try { r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal, keepalive: method === 'POST' && path === '/progress' }); }
  catch { throw Object.assign(new Error('offline'), { offline: true }); }
  finally { clearTimeout(t); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'error'), { status: r.status, data });
  return data;
}

/* ───────── ui helpers ───────── */
let toastT;
function toast(msg) {
  let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.remove('hide'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hide'), 3200);
}
function modal(html, { onClose } = {}) {
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = `<div class="sheet">${html}</div>`;
  const close = () => { ov.remove(); onClose && onClose(); };
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  $('#layer').appendChild(ov);
  return { el: $('.sheet', ov), close };
}
const skeleton = () => `<div class="top"><span class="brand">VUTA</span></div><div class="grid">${Array.from({ length: 9 }, () => '<div><div class="sk" style="aspect-ratio:9/16"></div></div>').join('')}</div>`;
const errView = (msg, retry = true) => `<div class="empty"><p>${esc(msg)}</p>${retry ? '<button class="btn sec" data-act="reload">Try again</button>' : ''}</div>`;
const netMsg = e => e.offline ? 'You appear to be offline. Check your connection.' : 'Could not load this right now. Please try again.';

document.addEventListener('error', e => { // a poster failed: try the original address once, then once more shortly after
  const t = e.target; if (!t || !t.classList || !t.classList.contains('pimg')) return;
  const o = t.getAttribute('data-o'); const n = +(t.dataset.n || 0);
  if (n >= 2 || !o) { t.style.visibility = 'hidden'; return; }
  t.dataset.n = n + 1;
  if (n === 0 && t.getAttribute('src') !== o) t.src = o; else setTimeout(() => { t.src = o + (o.includes('?') ? '&' : '?') + 'r=' + Date.now(); }, 1500);
}, true);
document.addEventListener('error', e => { if (e.target.classList?.contains('pimg')) e.target.remove(); }, true);

let EAGER = 0; // first N posters on a screen load immediately, the rest lazily
const imgSrc = (u, w) => { try { const p = S && S.cfg && S.cfg.imageProxy; return p ? p.replace('{url}', encodeURIComponent(u)).replace('{w}', w) : u; } catch { return u; } };
const imgLoad = () => (EAGER > 0 ? (EAGER--, 'fetchpriority="high"') : 'loading="lazy"');
const cardHtml = (f, o = {}) => `<a class="card" href="${o.href || '#/film/' + encodeURIComponent(f.id)}"><div class="poster"><div class="ph">${esc((f.title || '?')[0])}</div>${f.poster_url ? `<img class="pimg" ${imgLoad()} decoding="async" referrerpolicy="no-referrer" alt="" data-o="${esc(f.poster_url)}" src="${esc(imgSrc(f.poster_url, 360))}">` : ''}${o.badge ? `<span class="badge ${o.badgeCls || ''}">${esc(o.badge)}</span>` : ''}${o.pct != null ? `<div class="prog"><i style="width:${o.pct}%"></i></div>` : ''}</div><div class="ct">${esc(f.title)}</div><div class="cs">${esc(o.sub !== undefined ? o.sub : f.episode_count ? f.episode_count + ' episodes' : '')}</div></a>`;
const rowHtml = (title, films, o) => films?.length ? `<h2 class="sec">${esc(title)}</h2><div class="row">${films.map(f => cardHtml(f, o ? o(f) : {})).join('')}</div>` : '';

function topBar(extra = '') {
  const m = S.me;
  const right = S.session
    ? `<a class="coinpill" href="#/wallet">${ic('coin')}<span id="pillbal">${m ? Number(m.balance).toLocaleString() : '…'}</span></a>`
    : `<button class="btn sm" data-act="login">Log in</button>`;
  return `<div class="top"><span class="brand"><img class="logo" src="icons/favicon.png" alt="" width="26" height="26">${esc(S.cfg.siteName || 'VUTA')}</span><span class="sp"></span>${extra}${S.session ? `<a class="ib bell" href="#/notifications" aria-label="Notifications">${ic('bell')}<i class="dot${S.unread ? '' : ' hide'}" id="bdot"></i></a>` : ''}${right}</div>`;
}
function needLogin(msg) {
  $('#main').innerHTML = topBar() + `<div class="empty"><p>${esc(msg)}</p><button class="btn" data-act="login">Log in or sign up</button></div>`;
}

/* ───────── auth ───────── */
async function refreshMe() {
  if (!S.session) { S.me = null; return; }
  try { S.me = await api('/me'); } catch (e) { if (e.status === 401 || e.status === 403) { S.me = null; } }
  const p = $('#pillbal'); if (p && S.me) p.textContent = Number(S.me.balance).toLocaleString();
}
function authModal(mode = 'login') {
  const m = modal(`
    <h3>${mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Reset password' : 'Welcome back'}</h3>
    <p class="muted small">${mode === 'forgot' ? 'We will email you a reset link.' : 'Watch free episodes, unlock premium ones and keep your progress.'}</p>
    <form id="af">
      ${mode === 'register' ? '<div class="field"><label>Name</label><input name="name" maxlength="40" autocomplete="nickname" placeholder="Your name"></div>' : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      ${mode !== 'forgot' ? `<div class="field"><label>Password</label><input name="password" type="password" required minlength="8" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" placeholder="At least 8 characters"></div>` : ''}
      <div class="err hide" id="aerr"></div>
      <button class="btn block" type="submit">${mode === 'register' ? 'Sign up' : mode === 'forgot' ? 'Send reset link' : 'Log in'}</button>
    </form>
    <p class="small muted" style="text-align:center;margin-top:14px">
      ${mode === 'login' ? '<a href="#" data-m="register" style="color:var(--ac)">Create account</a> · <a href="#" data-m="forgot" style="color:var(--ac)">Forgot password?</a>' : '<a href="#" data-m="login" style="color:var(--ac)">Back to log in</a>'}
    </p>`);
  m.el.addEventListener('click', e => { const a = e.target.closest('[data-m]'); if (a) { e.preventDefault(); m.close(); authModal(a.dataset.m); } });
  m.el.querySelector('#af').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target), err = $('#aerr', m.el), btn = $('button[type=submit]', m.el);
    err.classList.add('hide'); btn.disabled = true;
    const email = String(f.get('email')).trim(), password = String(f.get('password') || '');
    try {
      let res;
      if (mode === 'login') res = await S.sb.auth.signInWithPassword({ email, password });
      else if (mode === 'register') res = await S.sb.auth.signUp({ email, password, options: { data: { display_name: String(f.get('name') || '').trim().slice(0, 40) } } });
      else res = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (res.error) throw res.error;
      if (mode === 'forgot') { m.el.innerHTML = '<h3>Check your email</h3><p class="muted">If an account exists for that address, a reset link is on its way.</p><button class="btn block" data-close>OK</button>'; return; }
      if (mode === 'register' && !res.data.session) { m.el.innerHTML = '<h3>Confirm your email</h3><p class="muted">We sent a confirmation link. Open it, then log in.</p><button class="btn block" data-close>OK</button>'; return; }
      m.close(); toast(mode === 'register' ? 'Welcome!' : 'Logged in');
    } catch (ex) { err.textContent = /invalid login/i.test(ex.message) ? 'Wrong email or password.' : ex.message || 'Something went wrong.'; err.classList.remove('hide'); btn.disabled = false; }
  });
}
function newPasswordModal() {
  const m = modal(`<h3>Set a new password</h3><form id="pf"><div class="field"><input name="p" type="password" minlength="8" required placeholder="New password (8+ characters)" autocomplete="new-password"></div><div class="err hide" id="perr"></div><button class="btn block">Save password</button></form>`);
  $('#pf', m.el).addEventListener('submit', async e => {
    e.preventDefault();
    const { error } = await S.sb.auth.updateUser({ password: new FormData(e.target).get('p') });
    if (error) { const el = $('#perr', m.el); el.textContent = error.message; el.classList.remove('hide'); } else { m.close(); toast('Password updated'); }
  });
}

/* ───────── payments ───────── */
function methodsAvail() {
  const pm = S.cfg.paymentMethods || {};
  return [['mpesa', 'M-Pesa'], ['card', 'Card'], ['apple_pay', 'Apple Pay']].filter(([k]) => pm[k] && (k !== 'apple_pay' || (window.ApplePaySession && ApplePaySession.canMakePayments && ApplePaySession.canMakePayments())));
}
function checkout(kind, item) {
  if (!S.session) return authModal('login');
  if (NATIVE && S.cfg.storeBillingRequired) return modal(`<h3>Buy in the app store</h3><p class="muted">In the mobile app, coins and VIP are purchased through the App Store / Google Play. You can also pay by M-Pesa or card on our website.</p><button class="btn block" data-close>OK</button>`);
  const methods = methodsAvail();
  if (!methods.length) return toast('Payments are not available right now.');
  let channel = methods[0][0];
  const title = kind === 'vip' ? item.name : `${Number(item.coins).toLocaleString()} coins`;
  const m = modal(`
    <h3>${esc(title)}</h3><p class="muted">${fmtKes(item.price_kes)}${kind === 'vip' ? ` · ${item.days} days` : ''}</p>
    <div class="meth">${methods.map(([k, l], i) => `<button data-ch="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    <div class="field" id="phf"><label>M-Pesa phone number</label><input id="ph" inputmode="tel" placeholder="0712 345 678" value="${esc(localStorage.getItem('vuta_phone') || '')}"></div>
    <div class="err hide" id="perr"></div>
    <button class="btn block" id="go">Pay ${fmtKes(item.price_kes)}</button>
    <p class="small muted" style="text-align:center">${cur() === 'USD' ? `You will be charged ${fmtKesOnly(item.price_kes)} (about ${fmtKes(item.price_kes)}). ` : ''}Secured by Paystack</p>`);
  const sync = () => { $('#phf', m.el).classList.toggle('hide', channel !== 'mpesa'); };
  sync();
  m.el.addEventListener('click', e => { const b = e.target.closest('[data-ch]'); if (!b) return; channel = b.dataset.ch; m.el.querySelectorAll('[data-ch]').forEach(x => x.classList.toggle('on', x === b)); sync(); });
  $('#go', m.el).addEventListener('click', async ev => {
    const btn = ev.currentTarget, err = $('#perr', m.el); err.classList.add('hide'); btn.disabled = true;
    const phone = $('#ph', m.el).value.trim();
    try {
      if (channel === 'mpesa') localStorage.setItem('vuta_phone', phone);
      const r = await api(kind === 'vip' ? '/pay/vip' : '/pay/coins', { method: 'POST', body: { [kind === 'vip' ? 'planId' : 'packageId']: item.id, channel, phone } });
      if (r.mode === 'redirect') {
        const B = NATIVE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
        if (!B) { location.href = r.url; return; }
        // In the app: open Paystack in the phone's browser and keep this screen, which polls for the result.
        await B.open({ url: r.url });
        m.el.innerHTML = `<div class="center" style="flex-direction:column;align-items:center;gap:14px"><div class="spin"></div><h3>Complete your payment</h3><p class="muted" style="text-align:center">Finish paying in the browser, then come back here. This screen updates by itself.</p></div>`;
        pollPayment(r.reference, m); return;
      }
      m.el.innerHTML = `<div class="center" style="flex-direction:column;align-items:center;gap:14px"><div class="spin"></div><h3>Check your phone</h3><p class="muted" style="text-align:center">${esc(r.message)}</p></div>`;
      pollPayment(r.reference, m);
    } catch (e) { err.textContent = e.data?.message || (e.offline ? netMsg(e) : 'Could not start payment.'); err.classList.remove('hide'); btn.disabled = false; }
  });
}
async function pollPayment(ref, m) {
  const show = html => { if (m) m.el.innerHTML = html; };
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 2500 : 4000));
    try {
      const s = await api('/pay/status/' + ref);
      if (s.status === 'success') {
        await refreshMe(); route(true);
        show(`<div class="center" style="flex-direction:column;align-items:center;gap:10px"><div style="color:var(--ok)">${ic('check')}</div><h3>Payment received</h3><p class="muted">${s.kind === 'vip' ? 'VIP is now active.' : 'Coins added to your wallet.'}</p><button class="btn block" data-close>Continue</button></div>`);
        const cb = S.afterPay; S.afterPay = null; if (cb) setTimeout(() => { m && m.close(); cb(); }, 900);
        return;
      }
      if (s.status === 'failed') return show(`<h3>Payment not completed</h3><p class="muted">${esc(s.message || 'The payment failed or was cancelled. You have not been charged.')}</p><button class="btn block" data-close>Close</button>`);
    } catch { /* keep polling through network blips */ }
  }
  show('<h3>Still waiting…</h3><p class="muted">We have not received confirmation yet. If you paid, your balance will update automatically within a few minutes.</p><button class="btn block" data-close>Close</button>');
}
function buyCoinsSheet() {
  const m = modal(`<h3>Get coins</h3><p class="muted small">Unlock premium episodes instantly.</p><div class="pk" style="padding:12px 0 0">${S.cfg.packages.map(pkgHtml).join('')}</div>`);
  m.el.addEventListener('click', e => { const p = e.target.closest('[data-pkg]'); if (p) { m.close(); checkout('coin_purchase', S.cfg.packages.find(x => x.id === p.dataset.pkg)); } });
}
function vipSheet() {
  const m = modal(`<h3>${ic('crown')} Go VIP</h3><p class="muted small">Watch eligible premium episodes without spending coins.</p><div style="margin-top:12px">${S.cfg.plans.map(planHtml).join('')}</div>`);
  m.el.addEventListener('click', e => { const p = e.target.closest('[data-plan]'); if (p) { m.close(); checkout('vip', S.cfg.plans.find(x => x.id === p.dataset.plan)); } });
}
const pkgHtml = p => { const save = p.price_kes < p.coins ? Math.round((1 - p.price_kes / p.coins) * 100) : 0; return `<div class="pkg" data-pkg="${p.id}"><b>${ic('coin')}${Number(p.coins).toLocaleString()}</b><div class="pr">${fmtKes(p.price_kes)}</div>${save ? `<div class="sv">Save ${save}%</div>` : ''}</div>`; };
const planHtml = p => `<div class="plan"><div style="flex:1"><b>${esc(p.name)}</b><div class="muted small">${p.days} days</div><ul>${(p.benefits || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul></div><button class="btn gold sm" data-plan="${p.id}">${fmtKes(p.price_kes)}</button></div>`;

/* ───────── views ───────── */
let tok = 0;
const parse = () => { const h = location.hash.slice(1) || '/home'; const [p, q] = h.split('?'); return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), q: Object.fromEntries(new URLSearchParams(q || '')) }; };

function renderNav(tab) {
  const items = [['home', 'Home', 'home'], ['discover', 'Discover', 'compass'], ['library', 'My Library', 'lib'], ['wallet', 'Wallet', 'wallet'], ['profile', 'Profile', 'user']];
  $('#nav').innerHTML = items.map(([k, l, i]) => `<a href="#/${k}" class="${tab === k ? 'on' : ''}">${ic(i)}<span>${l}</span></a>`).join('');
}

const homeKey = () => 'vuta_home_' + ((S.session && S.session.user && S.session.user.id) || 'anon');
function paintHome(d) {
  EAGER = 8;
  const hero = d.featured[0] || d.trending[0];
  const empty = !hero && !d.latest.length;
  $('#main').innerHTML = topBar(`<a class="ib" href="#/discover" aria-label="Search">${ic('search')}</a>`) +
    (empty ? `<div class="empty"><p>No dramas yet. The catalogue is loading — check back in a moment.</p><button class="btn sec" data-act="reload">Refresh</button></div>` : '') +
    (hero ? `<a class="hero" href="#/film/${encodeURIComponent(hero.id)}">${hero.poster_url ? `<img class="pimg" fetchpriority="high" decoding="async" referrerpolicy="no-referrer" alt="" data-o="${esc(hero.poster_url)}" src="${esc(imgSrc(hero.poster_url, 720))}">` : ''}<div class="hc"><span class="badge" style="position:static">FEATURED</span><h1>${esc(hero.title)}</h1><div class="muted small">${esc((hero.genres || []).slice(0, 3).join(' · '))}</div></div></a>` : '') +
    (d.categories.length ? `<div class="chips" style="margin-top:14px">${d.categories.map(c => `<a class="chip" href="#/discover?genre=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div>` : '') +
    rowHtml('Continue watching', d.continueWatching, f => ({ href: `#/watch/${encodeURIComponent(f.id)}/${f.resume_ep}`, pct: f.duration_sec ? Math.min(100, Math.round(f.resume_pos / f.duration_sec * 100)) : 5, sub: 'Episode ' + f.resume_ep })) +
    rowHtml('Trending now', d.trending, (f) => ({ badge: f.featured ? 'HOT' : '' })) +
    d.collections.map(c => rowHtml(c.title, c.films, () => c.vip_only ? { badge: 'VIP', badgeCls: 'vip' } : {})).join('') +
    rowHtml('Latest releases', d.latest);
}

async function vHome(t) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(homeKey()) || 'null'); } catch {}
  if (cached) paintHome(cached); else $('#main').innerHTML = skeleton();
  let d; try { d = await api('/home'); } catch (e) { if (t !== tok || cached) return; return void ($('#main').innerHTML = topBar() + errView(netMsg(e))); }
  if (t !== tok) return;
  const fresh = JSON.stringify(d);
  try { if (localStorage.getItem(homeKey()) === fresh) return; localStorage.setItem(homeKey(), fresh); } catch {}
  paintHome(d);
}

async function vDiscover(t, q) {
  let page = 1, genre = q.genre || '', text = q.q || '', total = 0, items = [], busy = false;
  const cats = (await api('/home').catch(() => ({ categories: [] }))).categories || [];
  if (t !== tok) return;
  $('#main').innerHTML = topBar() + `<div class="pad"><input id="sq" type="search" placeholder="Search dramas…" value="${esc(text)}" autocomplete="off"></div><div class="chips" style="margin-top:10px"><button class="chip ${genre ? '' : 'on'}" data-g="">All</button>${cats.map(c => `<button class="chip ${c === genre ? 'on' : ''}" data-g="${esc(c)}">${esc(c)}</button>`).join('')}</div><div id="res"></div><div class="center hide" id="more"><button class="btn sec">Load more</button></div>`;
  const res = $('#res');
  async function load(reset) {
    if (busy) return; busy = true;
    if (reset) { page = 1; items = []; res.innerHTML = `<div class="grid">${Array.from({ length: 6 }, () => '<div class="sk" style="aspect-ratio:9/16"></div>').join('')}</div>`; }
    try {
      const d = await api(`/films?page=${page}&genre=${encodeURIComponent(genre)}&q=${encodeURIComponent(text)}`);
      if (t !== tok) return;
      items = items.concat(d.films); total = d.total;
      res.innerHTML = items.length ? `<div class="grid">${items.map(f => cardHtml(f)).join('')}</div>` : `<div class="empty">No dramas found${text ? ` for “${esc(text)}”` : ''}.</div>`;
      $('#more').classList.toggle('hide', items.length >= total);
    } catch (e) { res.innerHTML = errView(netMsg(e)); }
    busy = false;
  }
  let deb; $('#sq').addEventListener('input', e => { clearTimeout(deb); deb = setTimeout(() => { text = e.target.value.trim(); load(true); }, 450); });
  $('.chips', $('#main')).addEventListener('click', e => {
    const g = e.target.closest('[data-g]');
    if (g) { genre = g.dataset.g; $('#main').querySelectorAll('[data-g]').forEach(x => x.classList.toggle('on', x === g)); load(true); }
  });
  $('#more button').addEventListener('click', () => { page++; load(false); });
  load(true);
}

async function vLibrary(t, q) {
  if (!S.session) return needLogin('Log in to see your watch history, saved dramas and unlocked episodes.');
  const tab = q.tab || 'continue';
  $('#main').innerHTML = topBar() + `<div class="tabs">${[['continue', 'Continue'], ['list', 'My List'], ['unlocked', 'Unlocked']].concat(FSP() ? [['downloads', 'Downloads']] : []).map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="lib"><div class="center"><div class="spin"></div></div></div>`;
  $('#main').querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#/library?tab=' + b.dataset.tab; });
  try {
    let html = '';
    if (tab === 'downloads') {
      html = dlHtml();
    } else if (tab === 'continue') {
      const d = await api('/me/history');
      html = d.items.length ? `<div class="grid">${d.items.map(f => cardHtml(f, { href: `#/watch/${encodeURIComponent(f.id)}/${f.resume_ep}`, sub: 'Episode ' + f.resume_ep })).join('')}</div>` : `<div class="empty"><p>Nothing watched yet.</p><a class="btn" href="#/discover">Find a drama</a></div>`;
    } else if (tab === 'list') {
      const d = await api('/me/list');
      html = d.items.length ? `<div class="grid">${d.items.map(f => cardHtml(f)).join('')}</div>` : `<div class="empty"><p>Your list is empty. Tap “My List” on any drama to save it.</p></div>`;
    } else {
      const d = await api('/me/unlocks');
      html = d.items.length ? `<div class="box">${d.items.map(u => `<a class="li" href="#/watch/${encodeURIComponent(u.film_id)}/${u.ep_no}"><span style="flex:1">${esc(u.films?.title || u.film_id)}<div class="muted small">Episode ${u.ep_no} · ${fmtDate(u.created_at)}</div></span><span class="muted small">${u.price} coins</span></a>`).join('')}</div>` : `<div class="empty"><p>Episodes you unlock with coins appear here and stay yours forever.</p></div>`;
    }
    if (t === tok) {
      $('#lib').innerHTML = html;
      if (tab === 'downloads') $('#lib').onclick = async e => { const b = e.target.closest('[data-dldel]'); if (!b) return; const [id, ep] = b.dataset.dldel.split('|'); const d = dlGet(id, +ep); if (d) { await dlRemove(d); $('#lib').innerHTML = dlHtml(); toast('Removed'); } };
    }
  } catch (e) { if (t === tok) $('#lib').innerHTML = errView(netMsg(e)); }
}

async function vWallet(t, q) {
  if (!S.session) return needLogin('Log in to buy coins, go VIP and see your transactions.');
  const tab = q.tab || 'payments';
  $('#main').innerHTML = topBar() + `<div class="center"><div class="spin"></div></div>`;
  let w; try { [w] = await Promise.all([api('/me/wallet'), refreshMe()]); } catch (e) { if (t !== tok) return; return void ($('#main').innerHTML = topBar() + errView(netMsg(e))); }
  if (t !== tok) return;
  const m = S.me || {};
  const list = tab === 'payments'
    ? (w.payments.length ? w.payments.map(p => `<div class="li"><span style="flex:1">${p.kind === 'vip' ? 'VIP subscription' : Number(p.coins).toLocaleString() + ' coins'}<div class="muted small">${fmtDate(p.created_at)} · ${esc(p.channel || '')}</div></span><span>${fmtKes(p.amount_kes)}</span><span class="st ${p.status}">${p.status}</span></div>`).join('') : '<div class="empty">No payments yet.</div>')
    : (w.ledger.length ? w.ledger.map(l => `<div class="li"><span style="flex:1;text-transform:capitalize">${esc(l.reason.replace('_', ' '))}<div class="muted small">${fmtDate(l.created_at)}</div></span><b style="color:${l.delta > 0 ? 'var(--ok)' : 'var(--tx)'}">${l.delta > 0 ? '+' : ''}${l.delta}</b></div>`).join('') : '<div class="empty">No coin activity yet.</div>');
  $('#main').innerHTML = topBar() +
    `<div class="bal"><div class="muted small">Coin balance</div><b>${ic('coin')}${Number(w.balance).toLocaleString()}</b>${m.vip ? `<div class="small" style="margin-top:6px;color:var(--gold)">${ic('crown')} VIP until ${fmtDate(m.vip_until)}</div>` : ''}</div>` +
    `<h2 class="sec">Buy coins</h2><div class="pk">${S.cfg.packages.map(pkgHtml).join('')}</div>` +
    (S.cfg.plans.length ? `<h2 class="sec">${ic('crown')}&nbsp;VIP</h2>${S.cfg.plans.map(planHtml).join('')}` : '') +
    `<h2 class="sec">History</h2><div class="tabs">${[['payments', 'Payments'], ['coins', 'Coins']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="box">${list}</div>`;
  const main = $('#main');
  main.onclick = e => {
    const p = e.target.closest('[data-pkg]'); if (p) return checkout('coin_purchase', S.cfg.packages.find(x => x.id === p.dataset.pkg));
    const pl = e.target.closest('[data-plan]'); if (pl) return checkout('vip', S.cfg.plans.find(x => x.id === pl.dataset.plan));
    const tb = e.target.closest('[data-tab]'); if (tb) location.hash = '#/wallet?tab=' + tb.dataset.tab;
  };
}

async function vProfile(t) {
  if (!S.session) return needLogin('Log in to manage your account, VIP and wallet.');
  await refreshMe(); if (t !== tok) return;
  const m = S.me || {};
  $('#main').innerHTML = topBar() +
    `<div class="box"><div style="display:flex;align-items:center;gap:14px"><div class="poster" style="width:56px;aspect-ratio:1;border-radius:50%"><div class="ph" style="font-size:24px;color:var(--tx)">${esc((m.display_name || m.email || '?')[0].toUpperCase())}</div></div><div style="flex:1;min-width:0"><b>${esc(m.display_name || '')}</b><div class="muted small" style="overflow:hidden;text-overflow:ellipsis">${esc(m.email || '')}</div></div></div></div>` +
    `<div class="box"><div class="li"><span style="flex:1">Subscription</span><span style="color:${m.vip ? 'var(--gold)' : 'var(--mu)'}">${m.vip ? 'VIP · until ' + fmtDate(m.vip_until) : 'Free plan'}</span></div>` +
    (m.subscription?.auto_renew ? '<div class="li small muted">Auto-renews by card. Cancel anytime from your Paystack receipt email.</div>' : '') +
    `<div class="li"><span style="flex:1">Coin balance</span><span>${Number(m.balance || 0).toLocaleString()}</span></div>` +
    `<div class="li"><span style="flex:1">Member since</span><span>${m.created_at ? fmtDate(m.created_at) : ''}</span></div></div>` +
    `<div class="pad" style="display:grid;gap:10px"><button class="btn gold block" data-act="vip">${ic('crown')} ${m.vip ? 'Extend VIP' : 'Go VIP'}</button><button class="btn sec block" data-act="rename">Edit name</button><button class="btn sec block" data-act="cur">Currency: ${cur() === 'USD' ? 'USD ($)' : 'KSh'} · tap to change</button>${m.role === 'admin' ? '<a class="btn sec block" href="admin.html">Admin dashboard</a>' : ''}<button class="btn sec block" data-act="logout">Log out</button></div>`;
}

async function vFilm(t, id) {
  $('#main').innerHTML = `<div class="top"><a class="ib" href="#/home">${ic('back')}</a></div><div class="det"><div class="sk" style="width:120px;aspect-ratio:9/16"></div><div style="flex:1"><div class="sk" style="height:24px"></div></div></div>`;
  let d; try { d = await api('/films/' + encodeURIComponent(id)); } catch (e) { if (t !== tok) return; return void ($('#main').innerHTML = `<div class="top"><a class="ib" href="#/home">${ic('back')}</a></div>` + (e.status === 404 ? '<div class="empty">This drama is not available.</div>' : errView(netMsg(e)))); }
  if (t !== tok) return;
  S.film[id] = d;
  const { film, episodes } = d;
  let resume = 1;
  if (S.session) { try { const h = await api('/me/history'); const r = h.items.find(x => x.id === id); if (r) resume = r.resume_ep; } catch { /* ignore */ } }
  if (t !== tok) return;
  const free = episodes.filter(e => e.free).length;
  $('#main').innerHTML = `<div class="top"><a class="ib" href="javascript:history.back()" data-act="back">${ic('back')}</a></div>
    <div class="det"><div class="poster">${film.poster_url ? `<img class="pimg" fetchpriority="high" decoding="async" referrerpolicy="no-referrer" alt="" data-o="${esc(film.poster_url)}" src="${esc(imgSrc(film.poster_url, 480))}">` : ''}</div>
    <div style="flex:1;min-width:0"><h1>${esc(film.title)}</h1><div class="tags">${(film.genres || []).map(g => `<span class="tag">${esc(g)}</span>`).join('')}</div><div class="muted small">${episodes.length} episodes · first ${free} free</div></div></div>
    <p class="pad muted" style="margin:10px 0 14px;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden">${esc(film.description || 'No description available.')}</p>
    <div class="pad" style="display:flex;gap:10px"><a class="btn" style="flex:1" href="#/watch/${encodeURIComponent(id)}/${resume}">${ic('play')} ${resume > 1 ? 'Continue EP ' + resume : 'Watch now'}</a><button class="btn sec" data-act="mylist" data-id="${esc(id)}">${ic(d.inList ? 'check' : 'plus')} My List</button></div>
    <h2 class="sec">Episodes</h2>
    ${episodes.length ? `<div class="eps">${episodes.map(e => `<a class="ep ${e.vip_only ? 'vo' : ''}" href="#/watch/${encodeURIComponent(id)}/${e.ep_no}">${e.ep_no}${e.locked ? `<svg class="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">${IC.lock}</svg>` : ''}</a>`).join('')}</div>` : '<div class="empty">Episodes are not available yet.</div>'}`;
}

/* ───────── player ───────── */
const P = { open: false };
function closePlayer(silent) {
  if (!P.open) return;
  saveProgress(true);
  clearInterval(P.saveT); clearTimeout(P.idleT);
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  const v = $('#vid'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  if (document.fullscreenElement) document.exitFullscreen?.();
  $('#player')?.remove(); P.open = false;
  window.removeEventListener('beforeunload', guard);
  if (!silent) { const id = P.id; location.hash = '#/film/' + encodeURIComponent(id); }
}
const guard = e => { const v = $('#vid'); if (v && !v.paused) { e.preventDefault(); e.returnValue = ''; } };

function saveProgress(force) {
  const v = $('#vid'); if (!P.open || !v || !P.ep || !P.access) return;
  const pos = Math.floor(v.currentTime || 0); if (!force && pos === P.lastSaved) return;
  P.lastSaved = pos;
  api('/progress', { method: 'POST', body: { filmId: P.id, ep: P.ep, position: pos, duration: Math.floor(v.duration || 0) } }).catch(() => {});
}

function appPrompt() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  modal(`<div style="text-align:center"><img src="icons/icon-192.png" alt="" width="72" height="72" style="border-radius:18px;margin-bottom:10px"><h3>Watch in the ${esc(S.cfg.siteName || 'ReelDrama')} app</h3>
    <p class="muted">${ios ? 'Episodes play in our Android app. An iPhone version is not available yet.' : 'Episodes play in our free Android app, with smooth playback and offline downloads for VIP.'}</p>
    ${ios ? '' : '<a class="btn block" href="download.html">Download the app</a>'}</div>`);
}
async function openPlayer(id, ep) {
  if (!NATIVE && !(S.cfg && S.cfg.webPlayback)) { // the website cannot stream these videos: send viewers to the app
    const t = tok; history.replaceState(null, '', '#/film/' + encodeURIComponent(id));
    if (!$('#main').querySelector('.det')) vFilm(t, id);
    return appPrompt();
  }
  if (!S.session) { location.hash = '#/film/' + encodeURIComponent(id); return authModal('login'); }
  if (P.open && P.id === id) return loadEpisode(ep);
  closePlayer(true);
  let fd = S.film[id];
  if (!fd) { try { fd = S.film[id] = await api('/films/' + encodeURIComponent(id)); } catch (e) { fd = dlOfflineFilm(id); if (!fd) { toast(e.status === 404 ? 'Drama not available' : netMsg(e)); location.hash = '#/home'; return; } } }
  P.open = true; P.id = id; P.film = fd.film; P.eps = fd.episodes; P.access = false;
  const el = document.createElement('div'); el.id = 'player';
  el.innerHTML = `<div class="pv paused loading" id="pv"><video id="vid" playsinline webkit-playsinline preload="auto"></video>
    <div class="cen"><div class="big">${ic('play')}</div><div class="spin" id="lsp"></div></div>
    <div class="pt"><button class="ib" data-p="close" aria-label="Close">${ic('back')}</button><div class="ti"><b id="ptt"></b><span id="pts"></span></div><button class="ib hide" data-p="cc" id="ccb" aria-label="Subtitles">${ic('cc')}</button><button class="ib dlb" data-p="dl" id="dlb" aria-label="Download"><em>VIP</em>${ic('download')}</button><button class="ib" data-p="eps" aria-label="Episodes">${ic('list')}</button></div>
    <div class="pb"><div class="bar" id="bar"><i><u id="bu"></u><s id="bs"></s></i></div><div class="pc"><button class="ib" data-p="pp" id="ppb" aria-label="Play or pause">${ic('play')}</button><span id="tm">0:00 / 0:00</span><span class="sp"></span><button class="ib" data-p="fs" aria-label="Full screen">${ic('full')}</button></div></div>
    <div id="pov"></div></div>`;
  $('#layer').appendChild(el);
  window.addEventListener('beforeunload', guard);
  wirePlayer();
  loadEpisode(ep);
}

function wirePlayer() {
  const pv = $('#pv'), v = $('#vid');
  const idle = () => { clearTimeout(P.idleT); pv.classList.remove('idle'); if (!v.paused) P.idleT = setTimeout(() => pv.classList.add('idle'), 3000); };
  const toggle = () => { v.paused ? v.play().catch(() => {}) : v.pause(); idle(); };
  pv.addEventListener('mousemove', idle); pv.addEventListener('touchstart', idle, { passive: true });
  pv.addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b) { if (!e.target.closest('.pb,.pt,.lock,.eplist')) toggle(); return; }
    const a = b.dataset.p;
    if (a === 'close') closePlayer(); else if (a === 'pp') toggle();
    else if (a === 'fs') { if (document.fullscreenElement) document.exitFullscreen(); else (pv.requestFullscreen || pv.webkitRequestFullscreen || (() => v.webkitEnterFullscreen?.())).call(pv); }
    else if (a === 'eps') epSheet();
    else if (a === 'dl') downloadEpisode();
    else if (a === 'cc') { const tr = v.textTracks[0]; if (tr) { tr.mode = tr.mode === 'showing' ? 'hidden' : 'showing'; toast(tr.mode === 'showing' ? 'Subtitles on' : 'Subtitles off'); } }
  });
  v.addEventListener('play', () => { pv.classList.remove('paused'); $('#ppb').innerHTML = ic('pause'); idle(); });
  v.addEventListener('pause', () => { pv.classList.add('paused'); $('#ppb').innerHTML = ic('play'); pv.classList.remove('idle'); saveProgress(true); });
  v.addEventListener('waiting', () => { pv.classList.add('loading'); $('#lsp').classList.remove('hide'); });
  const ready = () => { pv.classList.remove('loading'); $('#lsp').classList.add('hide'); };
  v.addEventListener('playing', ready); v.addEventListener('canplay', ready);
  v.addEventListener('timeupdate', () => {
    const d = v.duration || 0, c = v.currentTime || 0, pct = d ? c / d * 100 : 0;
    $('#bu').style.width = pct + '%'; $('#bs').style.left = pct + '%'; $('#tm').textContent = `${fmtTime(c)} / ${fmtTime(d)}`;
  });
  v.addEventListener('ended', () => { saveProgress(true); if (P.next) loadEpisode(P.next); else endScreen(); });
  v.addEventListener('error', () => { if (!P.lastErr) P.lastErr = 'video element error ' + (v.error ? v.error.code + ' ' + (v.error.message || '') : ''); console.error('[player] video error', v.error); refreshSource(); });
  const bar = $('#bar');
  const seek = e => { const r = bar.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left; if (v.duration) v.currentTime = Math.min(1, Math.max(0, x / r.width)) * v.duration; };
  let drag = false;
  bar.addEventListener('pointerdown', e => { drag = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', e => { if (drag) seek(e); });
  bar.addEventListener('pointerup', () => { drag = false; });
  P.saveT = setInterval(() => { if (!v.paused) saveProgress(false); }, 10000);
  // block context menu / drag on the video so a long-press doesn't open the media URL
  v.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', function k(e) { if (!P.open) return document.removeEventListener('keydown', k); if (e.code === 'Space') { e.preventDefault(); toggle(); } if (e.code === 'ArrowRight') v.currentTime += 5; if (e.code === 'ArrowLeft') v.currentTime -= 5; });
}

const povSet = html => { const o = $('#pov'); if (o) o.innerHTML = html; };
async function loadEpisode(ep) {
  const pv = $('#pv'), v = $('#vid'); if (!pv) return;
  saveProgress(true);
  P.ep = ep; P.access = false; P.retries = 0; P.next = null; P.lastErr = ''; P.forceNative = false;
  pv.classList.add('loading'); $('#lsp').classList.remove('hide'); povSet('');
  v.pause(); if (P.hls) { P.hls.destroy(); P.hls = null; }
  v.removeAttribute('src'); v.load();
  $('#ptt').textContent = P.film.title; $('#pts').textContent = 'Episode ' + ep;
  history.replaceState(null, '', `#/watch/${encodeURIComponent(P.id)}/${ep}`);
  const dl = dlGet(P.id, ep);
  if (dl) { // a saved copy plays first: no data, instant start
    if (dlExpired(dl)) {
      if (navigator.onLine === false) { ready0(); return povSet(`<div class="lock"><h3>Download expired</h3><p class="muted">Renew your VIP Monthly to keep watching offline.</p><button class="btn sec" data-pv="back">Back</button></div>`); }
      dlRemove(dl).catch(() => {});
    } else {
      try { const url = await dlUrl(dl); if (P.ep !== ep || !P.open) return; P.access = true; P.next = nextEpOf(ep); P.resumeAt = 0; return attach(url, dl.type, []); } catch { /* fall through to streaming */ }
    }
  }
  try {
    const d = await api('/play', { method: 'POST', body: { filmId: P.id, ep } });
    if (P.ep !== ep || !P.open) return;
    P.access = true; P.next = d.nextEp; P.resumeAt = d.resumeAt;
    attach(d.url, d.type, d.subtitles);
  } catch (e) {
    if (P.ep !== ep || !P.open) return;
    ready0();
    if (e.status === 402) return lockScreen(ep, e.data);
    if (e.status === 401) { closePlayer(true); return authModal('login'); }
    if (e.status === 404) return povSet(`<div class="lock"><h3>Episode unavailable</h3><p class="muted">This episode isn't available right now.</p>${P.eps.some(x => x.ep_no === ep + 1) ? `<button class="btn" data-pv="next">Next episode</button>` : ''}<button class="btn sec" data-pv="back">Back to drama</button></div>`);
    povSet(`<div class="lock"><h3>${e.offline ? 'You are offline' : 'Having trouble playing'}</h3><p class="muted">${e.offline ? 'Reconnect to keep watching.' : 'The video service is busy. Please try again.'}</p><button class="btn" data-pv="retry">Try again</button><button class="btn sec" data-pv="back">Back to drama</button></div>`);
  }
}
const ready0 = () => { $('#pv')?.classList.remove('loading'); $('#lsp')?.classList.add('hide'); };

function attach(url, type, subs) {
  const v = $('#vid'); if (!v) return;
  v.querySelectorAll('track').forEach(t => t.remove());
  const cc = $('#ccb'); cc.classList.toggle('hide', !subs?.length);
  (subs || []).slice(0, 4).forEach((s, i) => { const t = document.createElement('track'); t.kind = 'subtitles'; t.src = s.url; t.label = s.label; t.srclang = s.lang; if (i === 0) t.default = true; v.appendChild(t); });
  const start = () => { const at = P.resumeAt || 0; P.resumeAt = 0; if (at > 2 && (!v.duration || at < v.duration - 3)) v.currentTime = at; v.play().catch(() => { $('#pv').classList.add('paused'); ready0(); }); };
  v.addEventListener('loadedmetadata', start, { once: true });
  // Browsers that can play HLS themselves (Safari, Chrome on Android) load a plain <video src> without hls.js.
  const nativeHls = type === 'hls' && !!v.canPlayType('application/vnd.apple.mpegurl');
  if (type === 'hls' && window.Hls && Hls.isSupported() && !(nativeHls && P.forceNative)) {
    P.hls = new Hls({ maxBufferLength: 20, startLevel: -1, capLevelToPlayerSize: true, enableWorker: true });
    P.hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      P.lastErr = `${d.type} / ${d.details}${d.response ? ' / HTTP ' + d.response.code : ''}`;
      console.error('[player] fatal HLS error', d);
      if (nativeHls && !P.forceNative) { // hls.js could not fetch it: let the browser's own HLS player try once
        P.forceNative = true; P.hls.destroy(); P.hls = null; console.info('[player] retrying with the browser\'s built-in HLS');
        return attach(url, type, subs);
      }
      refreshSource();
    });
    P.hls.loadSource(url); P.hls.attachMedia(v);
  } else { v.src = url; v.load(); }
}

// Signed playback URLs expire: on a playback error, ask the server for a fresh one and resume where we were.
async function refreshSource() {
  const v = $('#vid'); if (!P.open || !P.access) return;
  if (P.refreshing) return; P.refreshing = true;
  const ep = P.ep, at = v.currentTime || 0;
  try {
    if (P.retries >= 2) throw new Error('retries');
    P.retries++;
    $('#pv').classList.add('loading'); $('#lsp').classList.remove('hide');
    if (P.hls) { P.hls.destroy(); P.hls = null; }
    const d = await api('/play', { method: 'POST', body: { filmId: P.id, ep } });
    if (P.ep !== ep) return;
    P.resumeAt = at; attach(d.url, d.type, d.subtitles);
  } catch (e) {
    ready0();
    if (e.status === 402) lockScreen(ep, e.data);
    else povSet(`<div class="lock"><h3>Playback problem</h3><p class="muted">We couldn't load this episode. Check your connection and try again.</p>${P.lastErr ? `<p class="muted small" style="word-break:break-all">Details: ${esc(P.lastErr)}</p>` : ''}<button class="btn" data-pv="retry">Try again</button><button class="btn sec" data-pv="back">Back to drama</button></div>`);
  } finally { P.refreshing = false; }
}

function endScreen() {
  povSet(`<div class="lock"><h3>That's the last episode</h3><p class="muted">More dramas are waiting for you.</p><button class="btn" data-pv="more">Browse dramas</button><button class="btn sec" data-pv="back">Back to drama</button></div>`);
}
function lockScreen(ep, d) {
  d = d || {};
  const vipOnly = d.vipOnly;
  povSet(`<div class="lock"><div class="lk2">${ic('lock')}</div><h3>${vipOnly ? 'VIP exclusive' : 'Episode ' + ep + ' is premium'}</h3>
    <p class="muted">${vipOnly ? 'Available to VIP members only.' : `Unlock with ${d.price} coins · your balance: ${Number(d.balance || 0).toLocaleString()}`}</p>
    ${vipOnly ? '' : `<button class="btn" data-pv="unlock">${ic('coin')} ${d.balance >= d.price ? 'Unlock for ' + d.price + ' coins' : 'Get coins to unlock'}</button>`}
    <button class="btn gold" data-pv="vip">${ic('crown')} Go VIP</button><button class="btn sec" data-pv="eps">Choose another episode</button></div>`);
  P.lockData = d;
}
function epSheet() {
  const o = document.createElement('div'); o.className = 'eplist';
  o.innerHTML = `<div style="display:flex;align-items:center;margin-bottom:10px"><b style="flex:1">Episodes</b><button class="ib" data-x>${ic('x')}</button></div><div class="eps">${P.eps.map(e => `<button class="ep ${e.ep_no === P.ep ? 'cur' : ''} ${e.vip_only ? 'vo' : ''}" data-e="${e.ep_no}">${e.ep_no}${e.locked ? `<svg class="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">${IC.lock}</svg>` : ''}</button>`).join('')}</div>`;
  o.addEventListener('click', e => { if (e.target.closest('[data-x]')) return o.remove(); const b = e.target.closest('[data-e]'); if (b) { o.remove(); loadEpisode(Number(b.dataset.e)); } });
  $('#pv').appendChild(o);
}
async function refreshEps() { try { const d = await api('/films/' + encodeURIComponent(P.id)); S.film[P.id] = d; P.eps = d.episodes; } catch { /* keep old list */ } }

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-pv]'); if (!b || !P.open) return;
  const a = b.dataset.pv;
  if (a === 'back') closePlayer();
  else if (a === 'more') { closePlayer(true); location.hash = '#/discover'; }
  else if (a === 'next') loadEpisode(P.ep + 1);
  else if (a === 'retry') loadEpisode(P.ep);
  else if (a === 'eps') epSheet();
  else if (a === 'vip') { S.afterPay = async () => { await refreshEps(); loadEpisode(P.ep); }; vipSheet(); }
  else if (a === 'unlock') {
    const d = P.lockData || {};
    if (d.balance < d.price) { S.afterPay = () => loadEpisode(P.ep); return buyCoinsSheet(); }
    b.disabled = true;
    try { const r = await api('/unlock', { method: 'POST', body: { filmId: P.id, ep: P.ep } }); if (S.me) S.me.balance = r.balance ?? S.me.balance; toast('Episode unlocked'); await refreshEps(); loadEpisode(P.ep); }
    catch (er) { b.disabled = false; if (er.status === 402) { S.afterPay = () => loadEpisode(P.ep); buyCoinsSheet(); } else toast(er.data?.error === 'vip_required' ? 'This episode is for VIP members' : 'Could not unlock. Please try again.'); }
  }
});

/* ───────── actions & router ───────── */
const actions = {
  login: () => authModal('login'),
  reload: () => route(true),
  back: (_a, e) => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = '#/home'); },
  vip: () => vipSheet(),
  logout: async () => { if (pushToken) { try { await api('/notifications/token/remove', { method: 'POST', body: { token: pushToken } }); } catch {} } S.unread = 0; await S.sb.auth.signOut(); S.me = null; location.hash = '#/home'; toast('Logged out'); },
  rename: () => {
    const m = modal(`<h3>Edit name</h3><div class="field"><input id="nn" maxlength="40" value="${esc(S.me?.display_name || '')}"></div><button class="btn block" id="sv">Save</button>`);
    $('#sv', m.el).onclick = async () => { try { await api('/me', { method: 'PATCH', body: { display_name: $('#nn', m.el).value } }); await refreshMe(); m.close(); route(true); } catch { toast('Could not save name'); } };
  },
  mylist: async (a) => {
    if (!S.session) return authModal('login');
    const id = a.dataset.id, has = a.querySelector('svg path')?.getAttribute('d') === IC.check.match(/d="([^"]+)"/)[1];
    try { await api('/me/list/' + encodeURIComponent(id), { method: has ? 'DELETE' : 'PUT' }); a.innerHTML = `${ic(has ? 'plus' : 'check')} My List`; toast(has ? 'Removed from My List' : 'Added to My List'); } catch { toast('Could not update list'); }
  },
};
actions.cur = () => { try { localStorage.setItem('vuta_cur', cur() === 'USD' ? 'KES' : 'USD'); } catch {} route(); };
document.addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (a && actions[a.dataset.act]) actions[a.dataset.act](a, e); });

function route() {
  const { parts, q } = parse(), t = ++tok, v = parts[0] || 'home';
  if (v !== 'watch') closePlayer(true);
  $('#main').onclick = null;
  const tabs = { home: 1, discover: 1, library: 1, wallet: 1, profile: 1 };
  renderNav(tabs[v] ? v : v === 'film' || v === 'watch' ? 'home' : 'home');
  window.scrollTo(0, 0);
  if (v === 'discover') return vDiscover(t, q);
  if (v === 'library') return vLibrary(t, q);
  if (v === 'notifications') return vNotifications(t);
  if (v === 'wallet') return vWallet(t, q);
  if (v === 'profile') return vProfile(t);
  if (v === 'film' && parts[1]) return vFilm(t, parts[1]);
  if (v === 'watch' && parts[1]) {
    const ep = parseInt(parts[2], 10) || 1;
    if (!P.open) { if (!$('#main').querySelector('.det')) vFilm(t, parts[1]); }
    return openPlayer(parts[1], ep);
  }
  return vHome(t);
}

/* ───────── offline downloads (Android app only; saved in the app's private storage on the phone) ───────── */
const FSP = () => NATIVE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
const dlStoreKey = () => 'vuta_dl_' + ((S.session && S.session.user && S.session.user.id) || 'x');
const dlAll = () => { try { return JSON.parse(localStorage.getItem(dlStoreKey()) || '[]'); } catch { return []; } };
const dlWrite = l => { try { localStorage.setItem(dlStoreKey(), JSON.stringify(l)); } catch {} };
const dlGet = (id, ep) => dlAll().find(x => x.id === id && x.ep === ep);
const dlExpired = d => !d.until || new Date(d.until).getTime() < Date.now();
const dlSafe = x => String(x).replace(/[^a-z0-9_-]/gi, '_');
const nextEpOf = ep => (P.eps || []).map(e => e.ep_no).filter(n => n > ep).sort((a, b) => a - b)[0] || null;
async function dlUrl(d) {
  const { uri } = await FSP().getUri({ path: d.dir + '/' + d.file, directory: 'DATA' });
  return window.Capacitor.convertFileSrc(uri);
}
async function dlRemove(d) {
  try { await FSP().rmdir({ path: d.dir, directory: 'DATA', recursive: true }); } catch {}
  dlWrite(dlAll().filter(x => !(x.id === d.id && x.ep === d.ep)));
}
function dlOfflineFilm(id) {
  const items = dlAll().filter(x => x.id === id && !dlExpired(x)); if (!items.length) return null;
  return { film: { id, title: items[0].filmTitle, poster_url: items[0].poster }, episodes: items.map(i => ({ ep_no: i.ep, title: i.title || 'Episode ' + i.ep, is_free: true })).sort((a, b) => a.ep_no - b.ep_no), inList: false };
}
async function pool(jobs, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const j = jobs[i++]; await fn(j); } })); }
const CH = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
const errTxt = e => String((e && (e.message || e.errorMessage || e.code)) || e || 'unknown').slice(0, 90);
const dlText = async u => {
  try { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  catch (e1) { // fall back to the native HTTP client
    const h = CH(); if (!h) throw e1;
    const r = await h.get({ url: u, responseType: 'text' });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }
};
// Saves one remote file to the phone. Tries the native downloader first, then a plain request written out as a file.
async function dlFile(F, url, path) {
  try { await F.downloadFile({ url, path, directory: 'DATA', recursive: true }); return; }
  catch (e1) {
    const h = CH(); if (!h) throw e1;
    const r = await h.get({ url, responseType: 'blob' });
    if (r.status < 200 || r.status >= 300 || !r.data) throw new Error('HTTP ' + r.status);
    await F.writeFile({ path, data: r.data, directory: 'DATA', recursive: true });
  }
}

// Downloads an HLS stream into dir/index.m3u8 + numbered pieces; returns the playlist file name.
async function dlHls(url, dir, onPct) {
  const F = FSP();
  let txt, base = url;
  try { txt = await dlText(url); } catch (e) { throw new Error('playlist: ' + errTxt(e)); }
  if (/#EXT-X-STREAM-INF/.test(txt)) { // master playlist: take the best quality variant
    const L = txt.split(/\r?\n/); let best = null, bw = -1;
    for (let i = 0; i < L.length; i++) { const m = /BANDWIDTH=(\d+)/.exec(L[i]); if (L[i].startsWith('#EXT-X-STREAM-INF') && L[i + 1] && !L[i + 1].startsWith('#')) { const b = m ? +m[1] : 0; if (b > bw) { bw = b; best = L[i + 1].trim(); } } }
    if (best) { base = new URL(best, url).href; txt = await dlText(base); }
  }
  const jobs = [], out = []; let n = 0;
  const local = (abs) => { const ext = (new URL(abs).pathname.match(/\.[a-z0-9]{1,5}$/i) || ['.bin'])[0]; const name = 'p' + (n++) + ext; jobs.push({ url: abs, name }); return name; };
  for (const line of txt.split(/\r?\n/)) {
    if (/^#EXT-X-(KEY|MAP)/.test(line) && /URI="([^"]+)"/.test(line)) out.push(line.replace(/URI="([^"]+)"/, (_m, u) => 'URI="' + local(new URL(u, base).href) + '"'));
    else if (line && !line.startsWith('#')) out.push(local(new URL(line.trim(), base).href));
    else out.push(line);
  }
  if (!jobs.length) throw new Error('empty playlist');
  let done = 0;
  await pool(jobs, 4, async j => {
    for (let a = 0; ; a++) { try { await dlFile(F, j.url, dir + '/' + j.name); break; } catch (e) { if (a >= 2) throw new Error('piece ' + j.name + ': ' + errTxt(e)); } }
    onPct(Math.round(++done / jobs.length * 100));
  });
  await F.writeFile({ path: dir + '/index.m3u8', data: out.join('\n'), directory: 'DATA', encoding: 'utf8', recursive: true });
  return 'index.m3u8';
}

const DLB = { busy: false };
async function downloadEpisode() {
  if (!FSP()) return modal(`<h3>Download in the app</h3><p class="muted">Saving episodes to your phone works in the Android app.</p><a class="btn block" href="download.html">Get the app</a>`);
  if (!P.open || !P.ep) return;
  const id = P.id, ep = P.ep;
  if (dlGet(id, ep)) return toast('Already saved on this phone');
  if (DLB.busy) return toast('A download is already running');
  let d;
  try { d = await api('/play', { method: 'POST', body: { filmId: id, ep, download: true } }); }
  catch (e) {
    if (e.status === 403) return modal(`<h3>VIP Monthly feature</h3><p class="muted">Downloads are for VIP Monthly members.</p><button class="btn gold block" data-act="vip">${ic('crown')} Go VIP</button>`);
    if (e.status === 402) return toast('Unlock this episode first');
    return toast((e.data && e.data.message) || netMsg(e));
  }
  DLB.busy = true;
  const setPct = p => { const x = $('#dlb em'); if (x) { x.textContent = p + '%'; x.style.color = '#fff'; } };
  toast('Downloading…'); setPct(0);
  const dir = 'downloads/' + dlSafe(id) + '/' + ep;
  try {
    let file;
    if (d.type === 'hls') file = await dlHls(d.url, dir, setPct);
    else { file = 'video.mp4'; await dlFile(FSP(), d.url, dir + '/' + file); }
    const rec = { id, ep, dir, file, type: d.type === 'hls' ? 'hls' : 'file', until: d.downloadUntil, title: 'Episode ' + ep, filmTitle: P.film.title, poster: P.film.poster_url || '', at: Date.now() };
    dlWrite(dlAll().filter(x => !(x.id === id && x.ep === ep)).concat(rec));
    toast('Saved to your phone ✓');
  } catch (e) {
    try { await FSP().rmdir({ path: dir, directory: 'DATA', recursive: true }); } catch {}
    console.error('[download]', e);
    toast('Download failed: ' + errTxt(e));
  } finally {
    DLB.busy = false; const x = $('#dlb em'); if (x) { x.textContent = 'VIP'; x.style.color = ''; }
  }
}

function dlHtml() {
  const l = dlAll().sort((a, b) => b.at - a.at);
  if (!l.length) return `<div class="empty"><p>No downloads yet. Open an episode and tap the download button.</p></div>`;
  return `<div class="box">${l.map(u => `<div class="li"><a href="#/watch/${encodeURIComponent(u.id)}/${u.ep}" style="flex:1;color:inherit;text-decoration:none">${esc(u.filmTitle)}<div class="muted small">Episode ${u.ep}${dlExpired(u) ? ' · expired' : ''}</div></a><button class="btn sm sec" data-dldel="${esc(u.id)}|${u.ep}">Remove</button></div>`).join('')}</div>`;
}

/* ───────── notifications: inbox bell + phone push ───────── */
async function refreshBell() {
  if (!S.session) { S.unread = 0; return; }
  try { const d = await api('/notifications'); S.unread = d.unread; const x = $('#bdot'); if (x) x.classList.toggle('hide', !S.unread); } catch {}
}
async function vNotifications(t) {
  if (!S.session) return needLogin('Log in to see your notifications.');
  $('#main').innerHTML = topBar() + `<div class="center"><div class="spin"></div></div>`;
  let d; try { d = await api('/notifications'); } catch (e) { if (t !== tok) return; return void ($('#main').innerHTML = topBar() + errView(netMsg(e))); }
  if (t !== tok) return;
  $('#main').innerHTML = topBar() + `<h2 style="padding:6px 16px 0;margin:0">Notifications</h2>` + (d.items.length
    ? `<div class="box" style="margin-top:10px">${d.items.map(n => `<a class="li" href="${/^#\//.test(n.url || '') ? esc(n.url) : '#/notifications'}" style="color:inherit;text-decoration:none">${n.unread ? '<i class="dot2"></i>' : ''}<span style="flex:1"><b>${esc(n.title)}</b>${n.body ? `<div class="muted small">${esc(n.body)}</div>` : ''}<div class="muted small">${fmtDate(n.created_at)}</div></span></a>`).join('')}</div>`
    : `<div class="empty"><p>No notifications yet.</p></div>`);
  if (d.unread) { api('/notifications/seen', { method: 'POST' }).catch(() => {}); }
  S.unread = 0; const x = $('#bdot'); if (x) x.classList.add('hide');
}
let pushWired = false, pushToken = '';
async function initPush() {
  const PN = NATIVE && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
  if (!PN || !S.session) return;
  try {
    if (!pushWired) {
      pushWired = true;
      PN.addListener('registration', r => { pushToken = r.value; api('/notifications/token', { method: 'POST', body: { token: r.value } }).catch(() => {}); });
      PN.addListener('registrationError', e => console.warn('[push] registration error', e));
      PN.addListener('pushNotificationReceived', n => { toast((n.title || 'New notification') + (n.body ? ': ' + n.body : '')); refreshBell(); });
      PN.addListener('pushNotificationActionPerformed', a => { const u = a && a.notification && a.notification.data && a.notification.data.url; location.hash = /^#\//.test(u || '') ? u : '#/notifications'; });
    }
    let p = await PN.checkPermissions();
    if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PN.requestPermissions();
    if (p.receive === 'granted') await PN.register();
  } catch (e) { console.warn('[push]', e); }
}

/* ───────── boot ───────── */
async function boot() {
  try { S.cfg = await api('/public-config', { auth: false }); try { localStorage.setItem('vuta_cfg', JSON.stringify(S.cfg)); } catch {} }
  catch (e) { try { S.cfg = JSON.parse(localStorage.getItem('vuta_cfg') || 'null'); } catch {} if (!S.cfg) { $('#main').innerHTML = errView(netMsg(e)); return; } }
  document.title = (S.cfg.siteName || 'VUTA') + ' – Short Dramas';
  S.sb = supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const { data } = await S.sb.auth.getSession(); S.session = data.session;
  S.sb.auth.onAuthStateChange(async (ev, session) => {
    const was = !!S.session; S.session = session;
    if (ev === 'PASSWORD_RECOVERY') return newPasswordModal();
    if (ev === 'SIGNED_IN' && !was || ev === 'SIGNED_OUT') { S.film = {}; await refreshMe(); route(); if (ev === 'SIGNED_IN') { refreshBell(); initPush(); } }
  });
  try { await refreshMe(); } catch {}
  refreshBell(); initPush();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBell(); });
  window.addEventListener('hashchange', route);
  if (navigator.onLine === false && FSP() && !location.hash) location.hash = '#/library?tab=downloads';
  window.addEventListener('offline', () => toast('You are offline'));
  window.addEventListener('online', () => toast('Back online'));
  const pay = new URLSearchParams(location.search).get('pay') || new URLSearchParams(location.search).get('reference');
  route();
  if (pay && /^VUTA-[CV]-[a-f0-9]{18}$/.test(pay) && S.session) {
    history.replaceState(null, '', location.pathname + location.hash);
    const m = modal('<div class="center" style="flex-direction:column;align-items:center;gap:14px"><div class="spin"></div><h3>Confirming payment…</h3></div>');
    pollPayment(pay, m);
  }
  if ('serviceWorker' in navigator) { /* intentionally no SW: playback URLs must never be cached */ }
}
boot();
})();
