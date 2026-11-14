const router = require('express').Router();
const { db, wrap, safeId } = require('../lib/core');
const { requireAuth } = require('../lib/auth');

router.use(requireAuth);
const CARD = 'id,title,poster_url,genres,episode_count';

router.get('/', wrap(async (req, res) => {
  const [w, p, s] = await Promise.all([
    db.from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle(),
    db.from('profiles').select('email,display_name,role,vip_until,created_at').eq('id', req.user.id).maybeSingle(),
    db.from('subscriptions').select('status,started_at,expires_at,auto_renew,vip_plans(name,code)').eq('user_id', req.user.id).order('expires_at', { ascending: false }).limit(1),
  ]);
  const vip = !!(p.data?.vip_until && new Date(p.data.vip_until) > new Date());
  res.json({ ...p.data, balance: w.data?.balance || 0, vip, subscription: s.data?.[0] || null });
}));

router.patch('/', wrap(async (req, res) => {
  const name = String(req.body.display_name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'invalid_name' });
  await db.from('profiles').update({ display_name: name }).eq('id', req.user.id);
  res.json({ ok: true });
}));

router.get('/history', wrap(async (req, res) => {
  const { data } = await db.from('watch_history').select('film_id,ep_no,position_sec,duration_sec,updated_at').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(100);
  const seen = new Set(), rows = [];
  for (const r of data || []) if (!seen.has(r.film_id)) { seen.add(r.film_id); rows.push(r); }
  const { data: fs } = rows.length ? await db.from('films').select(CARD).in('id', rows.map(r => r.film_id)) : { data: [] };
  const m = Object.fromEntries((fs || []).map(f => [f.id, f]));
  res.json({ items: rows.filter(r => m[r.film_id]).map(r => ({ ...m[r.film_id], resume_ep: r.ep_no, resume_pos: r.position_sec, last_watched: r.updated_at })) });
}));

router.get('/unlocks', wrap(async (req, res) => {
  const { data } = await db.from('unlocks').select('film_id,ep_no,price,created_at,films(title,poster_url)').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(200);
  res.json({ items: data || [] });
}));

router.get('/wallet', wrap(async (req, res) => {
  const [w, led, tx] = await Promise.all([
    db.from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle(),
    db.from('coin_ledger').select('delta,balance_after,reason,created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50),
    db.from('transactions').select('reference,kind,amount_kes,coins,status,channel,created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50),
  ]);
  res.json({ balance: w.data?.balance || 0, ledger: led.data || [], payments: tx.data || [] });
}));

router.get('/list', wrap(async (req, res) => {
  const { data } = await db.from('my_list').select(`created_at,films(${CARD})`).eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json({ items: (data || []).map(r => r.films).filter(Boolean) });
}));
router.put('/list/:filmId', wrap(async (req, res) => {
  if (!safeId(req.params.filmId)) return res.status(400).json({ error: 'bad_id' });
  await db.from('my_list').upsert({ user_id: req.user.id, film_id: req.params.filmId }, { onConflict: 'user_id,film_id' });
  res.json({ ok: true });
}));
router.delete('/list/:filmId', wrap(async (req, res) => {
  await db.from('my_list').delete().eq('user_id', req.user.id).eq('film_id', req.params.filmId);
  res.json({ ok: true });
}));

module.exports = router;
