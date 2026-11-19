const router = require('express').Router();
const { db, wrap, clampInt, safeId } = require('../lib/core');
const { optionalAuth, requireAuth, isVip } = require('../lib/auth');
const syln = require('../lib/syln');
const { authorize, downloadRights } = require('../lib/access');


async function load(filmId, ep) {
  if (!safeId(filmId) || !Number.isInteger(ep) || ep < 1) return {};
  await syln.ensureFilm(filmId);
  const { data: film } = await db.from('films').select('*').eq('id', filmId).eq('hidden', false).maybeSingle();
  if (!film) return {};
  const { data: episode } = await db.from('episodes').select('*').eq('film_id', filmId).eq('ep_no', ep).eq('hidden', false).maybeSingle();
  return { film, episode };
}

// Authorise → ask Syln for a FRESH playback URL → return it. A URL is never returned for a locked episode.
router.post('/play', optionalAuth, wrap(async (req, res) => {
  if (req.user && req.user.disabled) req.user = null;
  const filmId = String(req.body.filmId || ''), ep = Number(req.body.ep);
  const { film, episode } = await load(filmId, ep);
  if (!film || !episode) return res.status(404).json({ error: 'not_found' });

  const a = await authorize(req.user, film, episode);
  if (!a.allowed) {
    if (!req.user) return res.status(401).json({ error: 'auth_required', locked: true, price: a.price, vipOnly: a.vipOnly }); // guests: free episodes only
    const { data: w } = await db.from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle();
    return res.status(402).json({ error: a.reason, locked: true, price: a.price, vipOnly: a.vipOnly, balance: w?.balance || 0 });
  }
  let dl = null;
  if (req.body.download) {
    if (!req.user) return res.status(401).json({ error: 'auth_required' });
    dl = await downloadRights(req.user);
    if (!dl.ok) return res.status(403).json({ error: 'download_vip', message: 'Downloads are for VIP Monthly members.' });
  }
  try {
    const [p, { data: next }, { data: hist }] = await Promise.all([
      syln.getPlayback(filmId, { no: ep, id: episode.provider_episode_id }, film.platform),
      db.from('episodes').select('ep_no').eq('film_id', filmId).eq('hidden', false).gt('ep_no', ep).order('ep_no').limit(1),
      req.user ? db.from('watch_history').select('position_sec').eq('user_id', req.user.id).eq('film_id', filmId).eq('ep_no', ep).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    // Ad-free: admins and VIP Monthly only. Weekly VIP, free episodes and coin-unlocked episodes show ads.
    const adFree = req.user ? (dl || await downloadRights(req.user)).ok === true : false;
    res.set('Cache-Control', 'no-store');
    res.json({
      adFree, adFew: !adFree && isVip(req.user), // weekly VIP: ads, but a lot fewer
      url: p.url, type: /\.m3u8(\?|$)/i.test(p.url) ? 'hls' : 'file',
      subtitles: p.subtitles?.length ? p.subtitles : (episode.subtitles || []).filter(s => s.url).map(s => ({ lang: s.lang || 'en', label: s.label || 'Subtitles', url: s.url })),
      expiresIn: p.expires_in, nextEp: next?.[0]?.ep_no || null, resumeAt: hist?.position_sec || 0,
      access: a.reason, downloadUntil: dl ? dl.until : undefined, title: episode.title, filmTitle: film.title,
    });
  } catch (e) {
    const code = e.code || 'upstream_error';
    if (code === 'quota') return res.status(503).json({ error: 'busy', message: 'Playback has reached its daily limit. It resets at 3:00 AM Kenya time.' });
    if (code === 'stale_link') return res.status(503).json({ error: 'stale_link', message: 'This episode is temporarily unavailable. Please try another one.' });
    res.status(code === 'unavailable' || code === 'not_found' ? 404 : 503).json({ error: code === 'unavailable' || code === 'not_found' ? 'unavailable' : 'service_unavailable', message: 'This episode cannot be played right now. Please try again shortly.' });
  }
}));

router.post('/unlock', requireAuth, wrap(async (req, res) => {
  const filmId = String(req.body.filmId || ''), ep = Number(req.body.ep);
  const { film, episode } = await load(filmId, ep);
  if (!film || !episode) return res.status(404).json({ error: 'not_found' });
  const a = await authorize(req.user, film, episode);
  if (['free', 'vip', 'admin'].includes(a.reason)) return res.json({ ok: true, already: true, access: a.reason });
  if (a.reason === 'unlocked') return res.json({ ok: true, already: true, access: 'unlocked' });
  if (a.vipOnly) return res.status(403).json({ error: 'vip_required' });
  // price comes from the server's policy, never from the client
  const { data, error } = await db.rpc('unlock_episode', { p_user: req.user.id, p_film: filmId, p_ep: ep, p_price: a.price });
  if (error) throw error;
  if (!data.ok) return res.status(data.error === 'insufficient_coins' ? 402 : 400).json({ error: data.error, balance: data.balance, price: a.price });
  res.json({ ok: true, already: !!data.already, balance: data.balance, price: a.price });
}));

router.post('/progress', requireAuth, wrap(async (req, res) => {
  const filmId = String(req.body.filmId || ''), ep = Number(req.body.ep);
  if (!safeId(filmId) || !Number.isInteger(ep) || ep < 1) return res.status(400).json({ error: 'bad_request' });
  // only record progress for episodes the user may actually watch
  const { data: film } = await db.from('films').select('*').eq('id', filmId).maybeSingle();
  const { data: episode } = await db.from('episodes').select('*').eq('film_id', filmId).eq('ep_no', ep).maybeSingle();
  if (!film || !episode) return res.status(404).json({ error: 'not_found' });
  const a = await authorize(req.user, film, episode);
  if (!a.allowed) return res.status(403).json({ error: 'locked' });
  const { error } = await db.from('watch_history').upsert({
    user_id: req.user.id, film_id: filmId, ep_no: ep,
    position_sec: clampInt(req.body.position, 0, 86400, 0), duration_sec: clampInt(req.body.duration, 0, 86400, 0) || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,film_id,ep_no' });
  if (error) throw error;
  res.json({ ok: true });
}));

module.exports = router;
