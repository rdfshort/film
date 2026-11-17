const router = require('express').Router();
const { db, cache, getSettings, wrap, clampInt, safeId, config } = require('../lib/core');
const { optionalAuth } = require('../lib/auth');
const syln = require('../lib/syln');
const { annotateEpisodes } = require('../lib/access');

router.use(optionalAuth);

// Dramas with a working poster go first, so the home screen looks right while covers are being repaired.
const mirroredFirst = arr => [...(arr || [])].sort((a, b) => (syln.isMirrored(b.poster_url) ? 1 : 0) - (syln.isMirrored(a.poster_url) ? 1 : 0));

const CARD = 'id,title,poster_url,genres,episode_count,featured,collections,views,created_at,vip_eligible';

// Refresh the catalogue in the background when it is empty or older than 6h (never blocks the request).
let lastKick = 0;
async function maybeSync() {
  if (Date.now() - lastKick < 10 * 60_000) return;
  lastKick = Date.now();
  const { data } = await db.from('films').select('fetched_at').order('fetched_at', { ascending: false }).limit(1);
  const stale = !data?.length || Date.now() - new Date(data[0].fetched_at).getTime() > 24 * 3600_000;
  if (stale) syln.syncCatalogue({ pages: 3 }).catch(e => console.warn('[sync]', e.message));
}

// Public bootstrap: only values that are safe for browsers.
router.get('/public-config', wrap(async (_req, res) => {
  const [s, pk, pl] = await Promise.all([
    getSettings(),
    db.from('coin_packages').select('id,coins,price_kes,label').eq('active', true).order('sort'),
    db.from('vip_plans').select('id,code,name,days,price_kes,benefits').eq('active', true).order('sort'),
  ]);
  res.json({
    supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnon,
    siteName: s.site_name || 'VUTA', paymentMethods: s.payment_methods || {},
    country: (() => { const k = String(_req.headers['cf-ipcountry'] || '').toUpperCase(); return /^[A-Z]{2}$/.test(k) && k !== 'XX' && k !== 'T1' ? k : ''; })(),
    usdRate: Number(process.env.USD_RATE) || 130,
    googleLogin: process.env.GOOGLE_LOGIN === 'true',
    webPlayback: process.env.WEB_PLAYBACK === 'true',
    imageProxy: process.env.IMAGE_PROXY || '',
    storeBillingRequired: process.env.NATIVE_STORE_BILLING === 'true',
    freeEpisodes: s.free_episodes, packages: pk.data || [], plans: pl.data || [],
  });
}));

router.get('/home', wrap(async (req, res) => {
  maybeSync();
  const vis = () => db.from('films').select(CARD).eq('hidden', false);
  const [featured, trending, latest, colls, genresQ] = await Promise.all([
    vis().eq('featured', true).limit(40),
    vis().order('views', { ascending: false }).limit(80),
    vis().order('created_at', { ascending: false }).limit(80),
    db.from('collections').select('slug,title,vip_only').eq('active', true).order('sort'),
    db.from('films').select('genres').eq('hidden', false).limit(400),
  ]);
  const counts = {};
  (genresQ.data || []).forEach(r => (r.genres || []).forEach(g => { counts[g] = (counts[g] || 0) + 1; }));
  const categories = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name]) => name);

  let cont = [];
  if (req.user) {
    const { data } = await db.from('watch_history').select('film_id,ep_no,position_sec,duration_sec,updated_at').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(30);
    const seen = new Set(); const rows = [];
    for (const r of data || []) { if (!seen.has(r.film_id)) { seen.add(r.film_id); rows.push(r); } }
    if (rows.length) {
      const { data: fs } = await db.from('films').select(CARD).in('id', rows.map(r => r.film_id)).eq('hidden', false);
      const m = Object.fromEntries((fs || []).map(f => [f.id, f]));
      cont = rows.filter(r => m[r.film_id]).slice(0, 10).map(r => ({ ...m[r.film_id], resume_ep: r.ep_no, resume_pos: r.position_sec, duration_sec: r.duration_sec }));
    }
  }
  const collections = [];
  for (const c of (colls.data || []).slice(0, 4)) {
    const { data } = await vis().contains('collections', [c.slug]).limit(40);
    if (data?.length) collections.push({ ...c, films: mirroredFirst(data).slice(0, 12) });
  }
  res.json({ featured: mirroredFirst(featured.data).slice(0, 12), trending: mirroredFirst(trending.data).slice(0, 12), latest: mirroredFirst(latest.data).slice(0, 18), categories, collections, continueWatching: cont });
}));

router.get('/films', wrap(async (req, res) => {
  const page = clampInt(req.query.page, 1, 500, 1), size = 24;
  const q = String(req.query.q || '').trim().slice(0, 80);
  const genre = String(req.query.genre || '').trim().slice(0, 40);
  const collection = String(req.query.collection || '').trim().slice(0, 60);

  const build = () => {
    let qb = db.from('films').select(CARD, { count: 'exact' }).eq('hidden', false);
    if (q) qb = qb.ilike('title', `%${q.replace(/[%_,]/g, ' ')}%`);
    if (genre) qb = qb.contains('genres', [genre]);
    if (collection) qb = qb.contains('collections', [collection]);
    return qb;
  };
  const sort = req.query.sort === 'popular' ? 'views' : 'created_at';
  const run = () => build().order(sort, { ascending: false }).range((page - 1) * size, page * size - 1);
  let { data, count, error } = await run();
  if (error) throw error;
  // Search our own database first. Only when nothing matches do we spend a provider request (daily quota).
  if (q && page === 1 && !count) {
    try { await syln.upsertFilms(await syln.searchAll(q)); ({ data, count, error } = await run()); if (error) throw error; } catch { /* API down or over quota: show what we have */ }
  }
  res.json({ films: data || [], total: count || 0, page, pageSize: size });
}));

router.get('/films/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: 'bad_id' });
  const ok = await syln.ensureFilm(id);
  const { data: film } = await db.from('films').select('*').eq('id', id).eq('hidden', false).maybeSingle();
  if (!ok || !film) return res.status(404).json({ error: 'not_found' });
  const { data: eps } = await db.from('episodes').select('ep_no,title,duration_sec,is_free,coin_price').eq('film_id', id).eq('hidden', false).order('ep_no');
  const episodes = await annotateEpisodes(req.user, film, eps || []);
  db.from('films').update({ views: (film.views || 0) + 1 }).eq('id', id).then(() => {}, () => {});
  const { raw, ...pub } = film;
  let inList = false;
  if (req.user) {
    const { data } = await db.from('my_list').select('film_id').eq('user_id', req.user.id).eq('film_id', id).maybeSingle();
    inList = !!data;
  }
  res.json({ film: pub, episodes, inList });
}));

module.exports = router;
