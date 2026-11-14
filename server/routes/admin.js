const router = require('express').Router();
const { db, cache, wrap, clampInt, isUuid, safeId } = require('../lib/core');
const { requireAdmin } = require('../lib/auth');
const syln = require('../lib/syln');
const ps = require('../lib/paystack');

router.use(requireAdmin);

const pickKeys = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const num = (v, d = null) => (v === null || v === '' || v === undefined ? d : Number.isFinite(Number(v)) ? Number(v) : d);
const bool = v => v === true || v === 'true';

router.get('/stats', wrap(async (_req, res) => {
  const { data, error } = await db.rpc('admin_stats');
  if (error) throw error;
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: tx } = await db.from('transactions').select('amount_kes,created_at').eq('status', 'success').gte('created_at', since);
  const byDay = {};
  (tx || []).forEach(t => { const d = t.created_at.slice(0, 10); byDay[d] = (byDay[d] || 0) + Number(t.amount_kes); });
  res.json({ ...data, revenue_by_day: byDay });
}));

// ── settings ──
const SETTING_KEYS = ['free_episodes', 'default_coin_price', 'payment_methods', 'site_name', 'ads_enabled'];
router.get('/settings', wrap(async (_req, res) => {
  const { data } = await db.from('settings').select('key,value');
  res.json(Object.fromEntries((data || []).map(r => [r.key, r.value])));
}));
router.put('/settings', wrap(async (req, res) => {
  const rows = Object.entries(req.body || {}).filter(([k]) => SETTING_KEYS.includes(k)).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (!rows.length) return res.status(400).json({ error: 'nothing_to_save' });
  const { error } = await db.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) throw error;
  cache.del('settings');
  res.json({ ok: true });
}));

// ── coin packages & VIP plans (same CRUD shape) ──
function crud(path, table, fields, clean) {
  router.get(path, wrap(async (_req, res) => { const { data } = await db.from(table).select('*').order('sort'); res.json({ items: data || [] }); }));
  router.post(path, wrap(async (req, res) => {
    const row = clean(pickKeys(req.body, fields)); if (!row) return res.status(400).json({ error: 'invalid' });
    const { data, error } = await db.from(table).insert(row).select().single(); if (error) throw error; res.json({ item: data });
  }));
  router.put(`${path}/:id`, wrap(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'bad_id' });
    const row = clean(pickKeys(req.body, fields), true); if (!row) return res.status(400).json({ error: 'invalid' });
    const { data, error } = await db.from(table).update(row).eq('id', req.params.id).select().single(); if (error) throw error; res.json({ item: data });
  }));
  router.delete(`${path}/:id`, wrap(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'bad_id' });
    // soft-disable: money records keep pointing at it
    await db.from(table).update({ active: false }).eq('id', req.params.id); res.json({ ok: true });
  }));
}
crud('/packages', 'coin_packages', ['coins', 'price_kes', 'label', 'sort', 'active'], (r, partial) => {
  if (r.coins !== undefined) { r.coins = num(r.coins); if (!(r.coins > 0)) return null; }
  if (r.price_kes !== undefined) { r.price_kes = num(r.price_kes); if (!(r.price_kes > 0)) return null; }
  if (!partial && (r.coins === undefined || r.price_kes === undefined)) return null;
  if (r.sort !== undefined) r.sort = num(r.sort, 0);
  if (r.active !== undefined) r.active = bool(r.active);
  return r;
});
crud('/plans', 'vip_plans', ['code', 'name', 'days', 'price_kes', 'benefits', 'paystack_plan_code', 'active', 'sort'], (r, partial) => {
  if (r.days !== undefined) { r.days = num(r.days); if (!(r.days > 0)) return null; }
  if (r.price_kes !== undefined) { r.price_kes = num(r.price_kes); if (!(r.price_kes > 0)) return null; }
  if (!partial && (!r.code || !r.name || r.days === undefined || r.price_kes === undefined)) return null;
  if (typeof r.benefits === 'string') r.benefits = r.benefits.split('\n').map(s => s.trim()).filter(Boolean);
  if (r.paystack_plan_code === '') r.paystack_plan_code = null;
  if (r.active !== undefined) r.active = bool(r.active);
  return r;
});

// ── films / episodes / collections ──
router.get('/films', wrap(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1000, 1), size = 30, q = String(req.query.q || '').trim().slice(0, 80);
  let qb = db.from('films').select('id,title,poster_url,genres,episode_count,free_episodes,coin_price,vip_eligible,hidden,featured,collections,views', { count: 'exact' });
  if (q) qb = qb.ilike('title', `%${q.replace(/[%_,]/g, ' ')}%`);
  const { data, count } = await qb.order('created_at', { ascending: false }).range((page - 1) * size, page * size - 1);
  res.json({ films: data || [], total: count || 0, page, pageSize: size });
}));
router.patch('/films/:id', wrap(async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const b = req.body, u = {};
  if (b.hidden !== undefined) u.hidden = bool(b.hidden);
  if (b.featured !== undefined) u.featured = bool(b.featured);
  if (b.vip_eligible !== undefined) u.vip_eligible = bool(b.vip_eligible);
  if (b.free_episodes !== undefined) u.free_episodes = num(b.free_episodes);
  if (b.coin_price !== undefined) u.coin_price = num(b.coin_price);
  if (b.collections !== undefined) u.collections = (Array.isArray(b.collections) ? b.collections : String(b.collections).split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!Object.keys(u).length) return res.status(400).json({ error: 'nothing_to_save' });
  const { error } = await db.from('films').update(u).eq('id', req.params.id);
  if (error) throw error;
  res.json({ ok: true });
}));
router.get('/films/:id/episodes', wrap(async (req, res) => {
  const { data } = await db.from('episodes').select('ep_no,title,is_free,coin_price,hidden').eq('film_id', req.params.id).order('ep_no');
  res.json({ items: data || [] });
}));
router.patch('/films/:id/episodes/:ep', wrap(async (req, res) => {
  const b = req.body, u = {};
  if (b.is_free !== undefined) u.is_free = b.is_free === null || b.is_free === '' ? null : bool(b.is_free);
  if (b.coin_price !== undefined) u.coin_price = num(b.coin_price);
  if (b.hidden !== undefined) u.hidden = bool(b.hidden);
  const { error } = await db.from('episodes').update(u).eq('film_id', req.params.id).eq('ep_no', Number(req.params.ep));
  if (error) throw error;
  res.json({ ok: true });
}));
router.get('/collections', wrap(async (_req, res) => { const { data } = await db.from('collections').select('*').order('sort'); res.json({ items: data || [] }); }));
router.put('/collections/:slug', wrap(async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  const row = { slug, title: String(req.body.title || slug).slice(0, 80), vip_only: bool(req.body.vip_only), sort: num(req.body.sort, 0), active: req.body.active === undefined ? true : bool(req.body.active) };
  const { error } = await db.from('collections').upsert(row, { onConflict: 'slug' }); if (error) throw error; res.json({ ok: true });
}));
router.delete('/collections/:slug', wrap(async (req, res) => { await db.from('collections').delete().eq('slug', req.params.slug); res.json({ ok: true }); }));

// ── Syln connection ──
router.get('/api-status', wrap(async (_req, res) => {
  const [ping, last] = await Promise.all([syln.ping(), db.from('api_logs').select('status,ts').order('ts', { ascending: false }).limit(50)]);
  const rows = last.data || [];
  const errors = rows.filter(r => r.status === 0 || r.status >= 400).length;
  res.json({ ...ping, base: syln.cfg.base, recentRequests: rows.length, recentErrors: errors });
}));
router.get('/logs', wrap(async (req, res) => {
  let qb = db.from('api_logs').select('*').order('ts', { ascending: false }).limit(100);
  if (req.query.errors === '1') qb = qb.or('status.eq.0,status.gte.400');
  const { data } = await qb; res.json({ items: data || [] });
}));
router.post('/sync', wrap(async (req, res) => {
  try {
    res.json(await syln.syncCatalogue({ platform: req.body.platform || undefined, pages: clampInt(req.body.pages, 1, 20, 3) }));
  } catch (e) { res.status(502).json({ error: 'sync_failed', message: e.message }); }
}));
router.get('/platforms', wrap(async (_req, res) => res.json({ items: await syln.listPlatforms() })));

// ── payments ──
router.get('/transactions', wrap(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1000, 1), size = 40;
  let qb = db.from('transactions').select('reference,kind,amount_kes,coins,status,channel,created_at,paid_at,profiles:user_id(email)', { count: 'exact' });
  if (['pending', 'success', 'failed', 'refunded'].includes(req.query.status)) qb = qb.eq('status', req.query.status);
  const { data, count } = await qb.order('created_at', { ascending: false }).range((page - 1) * size, page * size - 1);
  res.json({ items: data || [], total: count || 0, page, pageSize: size });
}));
router.post('/transactions/:ref/refund', wrap(async (req, res) => {
  const ref = req.params.ref;
  if (!/^VUTA-[CV]-[a-f0-9]{18}$/.test(ref)) return res.status(400).json({ error: 'bad_ref' });
  try { await ps.refund(ref); } catch (e) { return res.status(502).json({ error: 'gateway_refund_failed', message: e.message }); }
  const { data, error } = await db.rpc('refund_transaction', { p_reference: ref });
  if (error) throw error;
  res.json(data);
}));

// ── users ──
router.get('/users', wrap(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1000, 1), size = 30, q = String(req.query.q || '').trim().slice(0, 80);
  let qb = db.from('profiles').select('id,email,display_name,role,disabled,vip_until,created_at,wallets(balance)', { count: 'exact' });
  if (q) qb = qb.ilike('email', `%${q.replace(/[%_,]/g, ' ')}%`);
  const { data, count } = await qb.order('created_at', { ascending: false }).range((page - 1) * size, page * size - 1);
  res.json({ items: data || [], total: count || 0, page, pageSize: size });
}));
router.patch('/users/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_modify_self' });
  const u = {};
  if (req.body.disabled !== undefined) u.disabled = bool(req.body.disabled);
  if (['user', 'admin'].includes(req.body.role)) u.role = req.body.role;
  await db.from('profiles').update(u).eq('id', req.params.id);
  cache.clear();
  res.json({ ok: true });
}));
router.post('/users/:id/coins', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const delta = Math.trunc(Number(req.body.delta));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) return res.status(400).json({ error: 'bad_delta' });
  const { data, error } = await db.rpc('admin_adjust_coins', { p_user: req.params.id, p_delta: delta, p_note: String(req.body.note || 'admin').slice(0, 60) });
  if (error) throw error;
  res.json(data);
}));

module.exports = router;
