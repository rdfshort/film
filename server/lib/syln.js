// Syln API adapter. All provider specifics live here and in .env so that the rest of the app
// only ever sees normalised films / episodes / playback objects.
// The token is read from the environment and is only ever used in server-side requests.
const { db, cache, env } = require('./core');

const cfg = {
  base: env('SYLN_BASE_URL', 'https://api.syln.dev').replace(/\/$/, ''),
  token: env('SYLN_API_TOKEN'),
  header: env('SYLN_AUTH_HEADER', 'Authorization'),
  scheme: env('SYLN_AUTH_SCHEME', 'Bearer'),
  rps: Math.max(1, Number(env('SYLN_REQUESTS_PER_SECOND', 4))),
  timeout: Number(env('SYLN_TIMEOUT_MS', 10000)),
  defaultPlatform: env('SYLN_DEFAULT_PLATFORM'),
  paths: {
    platforms: env('SYLN_PATH_PLATFORMS', '/platforms'),
    catalog: env('SYLN_PATH_CATALOG', '/platforms/{platform}/films'),
    search: env('SYLN_PATH_SEARCH', '/platforms/{platform}/search'),
    film: env('SYLN_PATH_FILM', '/platforms/{platform}/films/{id}'),
    episodes: env('SYLN_PATH_EPISODES', '/platforms/{platform}/films/{id}/episodes'),
    play: env('SYLN_PATH_PLAY', '/platforms/{platform}/films/{id}/episodes/{ep}/play'),
  },
  params: { page: env('SYLN_PARAM_PAGE', 'page'), q: env('SYLN_PARAM_QUERY', 'q'), genre: env('SYLN_PARAM_GENRE', 'genre') },
};

// Candidate response field names per value; first non-empty wins. Override with SYLN_FIELD_MAP.
const FIELD_MAP = {
  list: ['data', 'items', 'results', 'films', 'dramas', 'episodes', 'platforms', 'list'],
  platform: { id: ['id', 'slug', 'key', 'name', 'code'], name: ['name', 'title', 'label'] },
  film: {
    id: ['id', 'film_id', 'drama_id', 'series_id', 'book_id', '_id', 'slug'],
    title: ['title', 'name', 'drama_name', 'series_name'],
    description: ['description', 'synopsis', 'summary', 'intro', 'desc', 'overview'],
    poster: ['poster', 'poster_url', 'cover', 'cover_url', 'image', 'thumbnail', 'thumb'],
    genres: ['genres', 'categories', 'tags', 'genre', 'category'],
    episodeCount: ['episode_count', 'episodes_count', 'total_episodes', 'episodeCount', 'chapter_count', 'total'],
  },
  episode: {
    id: ['id', 'episode_id', 'chapter_id', '_id'],
    no: ['number', 'episode', 'episode_no', 'ep', 'index', 'order', 'chapter_index'],
    title: ['title', 'name'],
    duration: ['duration', 'duration_sec', 'length', 'seconds'],
    subtitles: ['subtitles', 'captions', 'subtitle', 'tracks'],
  },
  play: {
    url: ['url', 'play_url', 'playback_url', 'video_url', 'stream_url', 'hls', 'm3u8', 'mp4', 'src'],
    subtitles: ['subtitles', 'captions', 'tracks', 'subtitle'],
    expires: ['expires_in', 'expires', 'ttl'],
  },
};
try {
  const o = JSON.parse(env('SYLN_FIELD_MAP', '{}'));
  for (const k of Object.keys(o)) FIELD_MAP[k] = Array.isArray(o[k]) ? o[k] : { ...FIELD_MAP[k], ...o[k] };
} catch { console.warn('[syln] SYLN_FIELD_MAP is not valid JSON; ignoring'); }

const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const toList = (j) => {
  if (Array.isArray(j)) return j;
  const v = j && pick(j, FIELD_MAP.list);
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') { const inner = toList(v); if (inner.length) return inner; }
  return [];
};
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(vars[k] ?? '')));

// ── rate limiting: serialise requests with a minimum gap (default 4 req/s) ──
let last = 0, chain = Promise.resolve();
function slot() {
  const next = chain.then(async () => {
    const gap = 1000 / cfg.rps, wait = Math.max(0, last + gap - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  });
  chain = next.catch(() => {});
  return next;
}

function logCall(endpoint, status, ms, error) {
  db.from('api_logs').insert({ endpoint: String(endpoint).slice(0, 200), status, ms, error: error ? String(error).slice(0, 300) : null })
    .then(() => {}, () => {});
}

class SylnError extends Error {
  constructor(msg, status, code) { super(msg); this.status = status; this.code = code; }
}

async function call(path, query = {}, { retries = 2 } = {}) {
  if (!cfg.token) throw new SylnError('Syln API token is not configured', 503, 'no_token');
  const url = new URL(cfg.base + path);
  Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const headers = { Accept: 'application/json', [cfg.header]: cfg.scheme ? `${cfg.scheme} ${cfg.token}` : cfg.token };

  for (let attempt = 0; ; attempt++) {
    await slot();
    const t0 = Date.now(), ac = new AbortController(), timer = setTimeout(() => ac.abort(), cfg.timeout);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (r.status === 429 && attempt < retries) {
        const ra = Number(r.headers.get('retry-after')) || 1 + attempt;
        logCall(path, 429, ms, 'rate limited, retrying');
        await new Promise(res => setTimeout(res, Math.min(ra, 10) * 1000));
        continue;
      }
      if (!r.ok) {
        logCall(path, r.status, ms, `HTTP ${r.status}`);
        throw new SylnError(`Syln responded ${r.status}`, r.status === 404 ? 404 : 502, r.status === 404 ? 'not_found' : 'upstream_error');
      }
      logCall(path, r.status, ms, null);
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SylnError) throw e;
      const timedOut = e.name === 'AbortError';
      logCall(path, 0, Date.now() - t0, timedOut ? 'timeout' : e.message);
      if (attempt < retries) { await new Promise(res => setTimeout(res, 500 * (attempt + 1))); continue; }
      throw new SylnError(timedOut ? 'Syln timed out' : 'Syln unreachable', 503, 'unreachable');
    }
  }
}

// cached GET: fresh TTL, and serve stale copy if the API is down
async function cachedFresh(key, ttlMs, loader) {
  const hit = cache.get(key);                 // still within TTL
  if (hit !== undefined) return hit;
  try {
    const v = await loader();
    cache.set(key, v, ttlMs);
    cache.set(key + ':stale', v, ttlMs * 48); // long-lived copy used only if the API fails
    return v;
  } catch (e) {
    const stale = cache.get(key + ':stale');
    if (stale !== undefined) return stale;
    throw e;
  }
}

// ── normalisers ──
function normFilm(raw, platform) {
  const F = FIELD_MAP.film;
  const id = pick(raw, F.id);
  if (id === undefined) return null;
  let genres = pick(raw, F.genres) ?? [];
  if (typeof genres === 'string') genres = genres.split(/[,|/]/);
  genres = (Array.isArray(genres) ? genres : []).map(g => (typeof g === 'string' ? g : g?.name || g?.title || '')).map(s => s.trim()).filter(Boolean).slice(0, 8);
  return {
    id: String(id), platform: platform || null,
    title: String(pick(raw, F.title) || 'Untitled').slice(0, 200),
    description: String(pick(raw, F.description) || '').slice(0, 2000),
    poster_url: pick(raw, F.poster) || null,
    genres,
    episode_count: Number(pick(raw, F.episodeCount)) || 0,
  };
}
function normEpisode(raw, idx) {
  const E = FIELD_MAP.episode;
  let subs = pick(raw, E.subtitles) || [];
  if (!Array.isArray(subs)) subs = [];
  return {
    ep_no: Number(pick(raw, E.no)) || idx + 1,
    provider_episode_id: pick(raw, E.id) !== undefined ? String(pick(raw, E.id)) : null,
    title: pick(raw, E.title) || `Episode ${idx + 1}`,
    duration_sec: Number(pick(raw, E.duration)) || null,
    subtitles: subs,
  };
}
function normPlay(raw) {
  const P = FIELD_MAP.play;
  const root = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const url = pick(root, P.url);
  const subs = (pick(root, P.subtitles) || []).map(s => ({
    lang: s.lang || s.language || s.code || 'en', label: s.label || s.name || s.lang || 'Subtitles', url: s.url || s.src || s.file,
  })).filter(s => s.url);
  return { url: typeof url === 'string' ? url : null, subtitles: Array.isArray(subs) ? subs : [], expires_in: Number(pick(root, P.expires)) || null };
}

// ── public API ──
async function listPlatforms() {
  return cachedFresh('syln:platforms', 10 * 60_000, async () => {
    const j = await call(cfg.paths.platforms);
    return toList(j).map(p => typeof p === 'string' ? { id: p, name: p } : { id: String(pick(p, FIELD_MAP.platform.id)), name: String(pick(p, FIELD_MAP.platform.name) || pick(p, FIELD_MAP.platform.id)) });
  });
}
async function defaultPlatform() {
  if (cfg.defaultPlatform) return cfg.defaultPlatform;
  const p = await listPlatforms();
  if (!p.length) throw new SylnError('No Syln platforms available', 503, 'no_platform');
  return p[0].id;
}
async function listCatalog({ platform, page = 1, genre } = {}) {
  platform = platform || await defaultPlatform();
  const key = `syln:cat:${platform}:${page}:${genre || ''}`;
  return cachedFresh(key, 10 * 60_000, async () => {
    const j = await call(fill(cfg.paths.catalog, { platform }), { [cfg.params.page]: page, [cfg.params.genre]: genre });
    return toList(j).map(r => normFilm(r, platform)).filter(Boolean);
  });
}
async function search(q, { platform, page = 1 } = {}) {
  platform = platform || await defaultPlatform();
  return cachedFresh(`syln:s:${platform}:${q.toLowerCase()}:${page}`, 5 * 60_000, async () => {
    const j = await call(fill(cfg.paths.search, { platform }), { [cfg.params.q]: q, [cfg.params.page]: page });
    return toList(j).map(r => normFilm(r, platform)).filter(Boolean);
  });
}
async function getFilm(id, platform) {
  platform = platform || await defaultPlatform();
  return cachedFresh(`syln:film:${platform}:${id}`, 30 * 60_000, async () => {
    const j = await call(fill(cfg.paths.film, { platform, id }));
    const raw = j && j.data && !Array.isArray(j.data) && typeof j.data === 'object' ? j.data : j;
    return normFilm(raw, platform);
  });
}
async function getEpisodes(id, platform) {
  platform = platform || await defaultPlatform();
  return cachedFresh(`syln:eps:${platform}:${id}`, 30 * 60_000, async () => {
    const j = await call(fill(cfg.paths.episodes, { platform, id }));
    return toList(j).map(normEpisode).sort((a, b) => a.ep_no - b.ep_no);
  });
}
// Playback URLs are signed and expire: never cached, always requested fresh when an episode opens.
async function getPlayback(id, ep, platform) {
  platform = platform || await defaultPlatform();
  const j = await call(fill(cfg.paths.play, { platform, id, ep }), {}, { retries: 1 });
  const p = normPlay(j);
  if (!p.url) throw new SylnError('Episode unavailable', 404, 'unavailable');
  return p;
}
async function ping() {
  const t0 = Date.now();
  try { const p = await listPlatforms(); return { ok: true, ms: Date.now() - t0, platforms: p.length, tokenConfigured: !!cfg.token }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message, tokenConfigured: !!cfg.token }; }
}

// ── persist metadata into Supabase cache (never overwrites admin settings) ──
async function upsertFilms(films) {
  if (!films.length) return;
  const rows = films.map(f => ({ id: f.id, platform: f.platform, title: f.title, description: f.description, poster_url: f.poster_url, genres: f.genres, episode_count: f.episode_count, fetched_at: new Date().toISOString() }));
  const { error } = await db.from('films').upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  if (error) console.warn('[syln] upsertFilms', error.message);
}
async function upsertEpisodes(filmId, eps) {
  if (!eps.length) return;
  const rows = eps.map(e => ({ film_id: filmId, ep_no: e.ep_no, provider_episode_id: e.provider_episode_id, title: e.title, duration_sec: e.duration_sec, subtitles: e.subtitles }));
  const { error } = await db.from('episodes').upsert(rows, { onConflict: 'film_id,ep_no', ignoreDuplicates: false });
  if (error) console.warn('[syln] upsertEpisodes', error.message);
  await db.from('films').update({ episode_count: Math.max(...eps.map(e => e.ep_no)) }).eq('id', filmId);
}

let syncing = null;
async function syncCatalogue({ platform, pages = 3 } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    let total = 0;
    platform = platform || await defaultPlatform();
    for (let p = 1; p <= pages; p++) {
      const films = await listCatalog({ platform, page: p });
      if (!films.length) break;
      await upsertFilms(films); total += films.length;
    }
    return { platform, synced: total };
  })().finally(() => { syncing = null; });
  return syncing;
}

// Make sure a film (and its episode list) is in our DB cache; refresh if older than maxAgeMs.
async function ensureFilm(id, maxAgeMs = 6 * 3600_000) {
  const { data: row } = await db.from('films').select('id,platform,fetched_at,episode_count').eq('id', id).maybeSingle();
  const { count } = await db.from('episodes').select('film_id', { count: 'exact', head: true }).eq('film_id', id);
  const stale = !row || !count || Date.now() - new Date(row.fetched_at).getTime() > maxAgeMs;
  if (!stale) return true;
  try {
    const film = await getFilm(id, row?.platform);
    if (film) await upsertFilms([film]);
    const eps = await getEpisodes(id, film?.platform || row?.platform);
    await upsertEpisodes(id, eps);
    return true;
  } catch (e) {
    return !!row; // API down: fall back to whatever we already cached
  }
}

module.exports = { cfg, SylnError, listPlatforms, defaultPlatform, listCatalog, search, getFilm, getEpisodes, getPlayback, ping, upsertFilms, upsertEpisodes, syncCatalogue, ensureFilm };
