// Single source of truth for "is this episode free / what does it cost / may this user watch it".
// Used by catalogue listings (to show locks), unlock, and playback authorisation.
const { db, getSettings } = require('./core');
const { isVip } = require('./auth');

async function vipOnlyFilm(film) {
  if (!film.collections?.length) return false;
  const { data } = await db.from('collections').select('slug').in('slug', film.collections).eq('vip_only', true).eq('active', true);
  return !!(data && data.length);
}

function policyFor(film, ep, settings, vipOnly) {
  const freeCount = Number(film.free_episodes ?? settings.free_episodes ?? 3);
  const free = ep.is_free ?? ep.ep_no <= freeCount;
  const price = Number(ep.coin_price ?? film.coin_price ?? settings.default_coin_price ?? 20);
  return { free, price, vipOnly: !free && vipOnly };
}

// → { allowed, reason, price, free, vipOnly }
async function authorize(user, film, ep) {
  const settings = await getSettings();
  const vipOnly = await vipOnlyFilm(film);
  const pol = policyFor(film, ep, settings, vipOnly);
  if (pol.free) return { allowed: true, reason: 'free', ...pol };
  if (user) {
    if (isVip(user) && film.vip_eligible) return { allowed: true, reason: 'vip', ...pol };
    if (!pol.vipOnly) {
      const { data } = await db.from('unlocks').select('ep_no').eq('user_id', user.id).eq('film_id', film.id).eq('ep_no', ep.ep_no).maybeSingle();
      if (data) return { allowed: true, reason: 'unlocked', ...pol };
    }
  }
  return { allowed: false, reason: pol.vipOnly ? 'vip_required' : 'locked', ...pol };
}

// Annotate a whole episode list for the UI with one round trip (no playback URLs here).
async function annotateEpisodes(user, film, eps) {
  const settings = await getSettings();
  const vipOnly = await vipOnlyFilm(film);
  let unlocked = new Set();
  if (user) {
    const { data } = await db.from('unlocks').select('ep_no').eq('user_id', user.id).eq('film_id', film.id);
    unlocked = new Set((data || []).map(r => r.ep_no));
  }
  const vip = isVip(user) && film.vip_eligible;
  return eps.map(e => {
    const p = policyFor(film, e, settings, vipOnly);
    const open = p.free || vip || (!p.vipOnly && unlocked.has(e.ep_no));
    return { ep_no: e.ep_no, title: e.title, duration_sec: e.duration_sec, free: p.free, locked: !open, unlocked: unlocked.has(e.ep_no), price: p.price, vip_only: p.vipOnly };
  });
}

module.exports = { authorize, annotateEpisodes, policyFor };
