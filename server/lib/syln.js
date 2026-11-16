// Syln API adapter. All provider specifics live here and in .env so that the rest of the app
// only ever sees normalised films / episodes / playback objects.
// The token is read from the environment and is only ever used in server-side requests.
const { db, cache, env, config: appConfig } = require('./core');

// Render can't always store empty values, so the word "none" also means empty.
const nz = v => (String(v).trim().toLowerCase() === 'none' ? '' : v);

const cfg = {
  base: env('SYLN_BASE_URL', 'https://api.syln.dev').replace(/\/$/, ''),
  token: env('SYLN_API_TOKEN'),
  header: env('SYLN_AUTH_HEADER', 'Authorization'),
  scheme: nz(env('SYLN_AUTH_SCHEME', 'Bearer')),
  rps: Math.max(1, Number(env('SYLN_REQUESTS_PER_SECOND', 4))),
  timeout: Number(env('SYLN_TIMEOUT_MS', 10000)),
  defaultPlatform: env('SYLN_DEFAULT_PLATFORM'),
  platforms: env('SYLN_PLATFORMS', '').split(',').map(x => x.trim()).filter(Boolean), // e.g. shortmax,blinkdrama
  lang: env('SYLN_LANG', ''),
  dailyBudget: Number(env('SYLN_DAILY_BUDGET', 0)), // 0 = unlimited; set 90 on a 100/day free plan
  paths: {
    ping: nz(env('SYLN_PATH_PING', '')),               // optional cheap health-check path
    // when SYLN_PLATFORMS is set the platform list is fixed, so no platforms endpoint is called
    platforms: nz(env('SYLN_PATH_PLATFORMS', env('SYLN_PLATFORMS', '') ? '' : '/platforms')),
    catalog: env('SYLN_PATH_CATALOG', '/platforms/{platform}/films'),
    search: env('SYLN_PATH_SEARCH', '/platforms/{platform}/search'),
    film: env('SYLN_PATH_FILM', '/platforms/{platform}/films/{id}'),
    episodes: env('SYLN_PATH_EPISODES', '/platforms/{platform}/films/{id}/episodes'),
    play: nz(env('SYLN_PATH_PLAY', '')),               // empty: stream links come from the episode list
  },
  params: { page: env('SYLN_PARAM_PAGE', 'page'), q: env('SYLN_PARAM_QUERY', 'q'), genre: env('SYLN_PARAM_GENRE', 'genre'), lang: env('SYLN_PARAM_LANG', 'lang') },
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
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String((k === 'lang' ? cfg.lang : vars[k]) ?? '')));

// ── daily request budget (protects a free plan such as 100 requests/day) ──
let budgetDay = '', budgetUsed = 0, budgetLoaded = false;
async function takeBudget() {
  if (!cfg.dailyBudget) return;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== budgetDay) { budgetDay = day; budgetUsed = 0; budgetLoaded = false; }
  if (!budgetLoaded) {
    budgetLoaded = true; // count what this process doesn't know about (restarts, other instances)
    const { count } = await db.from('api_logs').select('id', { count: 'exact', head: true }).gte('ts', day + 'T00:00:00Z').gt('status', 0);
    budgetUsed = Math.max(budgetUsed, count || 0);
  }
  if (budgetUsed >= cfg.dailyBudget) throw new SylnError('Daily Syln request budget used up', 503, 'quota');
  budgetUsed++;
}

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
  if (cfg.lang && cfg.params.lang && !url.searchParams.has(cfg.params.lang)) url.searchParams.set(cfg.params.lang, cfg.lang);
  Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const headers = { Accept: 'application/json', [cfg.header]: cfg.scheme ? `${cfg.scheme} ${cfg.token}` : cfg.token };

  for (let attempt = 0; ; attempt++) {
    await takeBudget();
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
const clean = v => String(v).replace(/\u0000/g, '');
function normFilm(raw, platform) {
  const F = FIELD_MAP.film;
  const id = pick(raw, F.id);
  if (id === undefined) return null;
  let genres = pick(raw, F.genres) ?? [];
  if (typeof genres === 'string') genres = genres.split(/[,|/]/);
  genres = (Array.isArray(genres) ? genres : []).map(g => (typeof g === 'string' ? g : g?.labelName || g?.name || g?.title || '')).map(s => s.trim()).filter(Boolean).slice(0, 8);
  return {
    id: platform ? `${platform}:${id}` : String(id), platform: platform || null,
    title: clean(pick(raw, F.title) || 'Untitled').slice(0, 200),
    description: clean(pick(raw, F.description) || '').slice(0, 2000),
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
// Some providers return {video_1080, video_720, video_480}; choose the one closest to SYLN_QUALITY (default 720p,
// a good balance for slower mobile networks).
function pickQuality(obj) {
  const target = Number(env('SYLN_QUALITY', 720)) || 720;
  const opts = Object.entries(obj).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [parseInt(k.replace(/\D/g, ''), 10) || 0, v]);
  if (!opts.length) return undefined;
  opts.sort((a, b) => Math.abs(a[0] - target) - Math.abs(b[0] - target));
  return opts[0][1];
}
function normPlay(raw) {
  const P = FIELD_MAP.play;
  const root = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  let url = pick(root, P.url);
  if (!url) { const vid = root && (root.video || root.videos || root.qualities); if (vid && typeof vid === 'object') url = pickQuality(vid); }
  const subs = (pick(root, P.subtitles) || []).map(s => ({
    lang: s.lang || s.language || s.code || 'en', label: s.label || s.name || s.lang || 'Subtitles', url: s.url || s.src || s.file,
  })).filter(s => s.url);
  const u = typeof url === 'string' ? url : null;
  let expiresAt = Number(root && root.expires) > 1e9 ? Number(root.expires) : 0;
  if (!expiresAt && u) { const m = /[?&]auth_key=(\d{9,11})-/.exec(u); if (m) expiresAt = Number(m[1]); }
  return { url: u, subtitles: Array.isArray(subs) ? subs : [], expires_in: Number(pick(root, P.expires)) || null, expires_at: expiresAt || null };
}

// Film ids are stored as "platform:code" so ids from different platforms never clash.
const splitId = (id, platform) => { const s = String(id), i = s.indexOf(':'); return i > 0 ? { platform: s.slice(0, i), code: s.slice(i + 1) } : { platform, code: s }; };

// ── public API ──
async function listPlatforms() {
  // Providers whose platform is part of the URL (e.g. apishort: /v1/shortmax/...) have no platforms endpoint.
  if (!cfg.paths.platforms) { const l = cfg.platforms.length ? cfg.platforms : [cfg.defaultPlatform || 'default']; return l.map(x => ({ id: x, name: x })); }
  return cachedFresh('syln:platforms', 10 * 60_000, async () => {
    const j = await call(cfg.paths.platforms);
    return toList(j).map(p => typeof p === 'string' ? { id: p, name: p } : { id: String(pick(p, FIELD_MAP.platform.id)), name: String(pick(p, FIELD_MAP.platform.name) || pick(p, FIELD_MAP.platform.id)) });
  });
}
async function defaultPlatform() {
  if (cfg.defaultPlatform) return cfg.defaultPlatform;
  if (cfg.platforms.length) return cfg.platforms[0];
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
async function searchAll(q) {
  const out = [];
  for (const pl of (await listPlatforms()).map(x => x.id)) { try { out.push(...await search(q, { platform: pl })); } catch { /* one platform down: keep the rest */ } }
  return out;
}
async function search(q, { platform, page = 1 } = {}) {
  platform = platform || await defaultPlatform();
  return cachedFresh(`syln:s:${platform}:${q.toLowerCase()}:${page}`, 5 * 60_000, async () => {
    const j = await call(fill(cfg.paths.search, { platform }), { [cfg.params.q]: q, [cfg.params.page]: page });
    return toList(j).map(r => normFilm(r, platform)).filter(Boolean);
  });
}
async function getFilm(fullId, platform) {
  const sp = splitId(fullId, platform); platform = sp.platform || await defaultPlatform(); const id = sp.code;
  return cachedFresh(`syln:film:${platform}:${id}`, 30 * 60_000, async () => {
    const j = await call(fill(cfg.paths.film, { platform, id }));
    const raw = j && j.data && !Array.isArray(j.data) && typeof j.data === 'object' ? j.data : j;
    return normFilm(raw, platform);
  });
}
// One cached provider call feeds both the episode list and playback (the list carries the stream links).
// Held in memory only, never stored in the database and never sent to browsers except per authorised episode.
const episodesRaw = (platform, id) => cachedFresh(`syln:eps-raw:${platform}:${id}`, 30 * 60_000, async () => toList(await call(fill(cfg.paths.episodes, { platform, id }))));
async function getEpisodes(fullId, platform) {
  const sp = splitId(fullId, platform); platform = sp.platform || await defaultPlatform(); const id = sp.code;
  return (await episodesRaw(platform, id)).map(normEpisode).sort((a, b) => a.ep_no - b.ep_no);
}
// Playback URLs are signed and expire: never cached, always requested fresh when an episode opens.
async function getPlayback(fullId, epRef, platform) {
  const sp = splitId(fullId, platform); platform = sp.platform || await defaultPlatform(); const id = sp.code;
  const ref = typeof epRef === 'object' ? epRef : { no: Number(epRef), id: null };
  let p;
  if (cfg.paths.play) {
    const j = await call(fill(cfg.paths.play, { platform, id, ep: ref.id || ref.no }), {}, { retries: 1 });
    p = normPlay(j);
  } else {
    // No dedicated playback endpoint: the episode list carries the stream links. One call serves every
    // episode of that drama for 30 minutes (saves quota); links last hours, are never stored and never sent to the browser
    // except for the one episode the viewer is authorised to watch.
    const find = async () => {
      const list = (await episodesRaw(platform, id)).map((r, i) => ({ no: normEpisode(r, i).ep_no, id: pick(r, FIELD_MAP.episode.id), play: normPlay(r) }));
      return (list.find(e => e.no === ref.no) || (ref.id != null ? list.find(e => String(e.id) === String(ref.id)) : null))?.play || { url: null };
    };
    const dead = x => x.url && x.expires_at && x.expires_at * 1000 < Date.now() + 60_000; // expired, or about to
    p = await find();
    if (dead(p)) { // our cache, or the provider's own cache, held an old link: fetch once more
      cache.del(`syln:eps-raw:${platform}:${id}`); cache.del(`syln:eps-raw:${platform}:${id}:stale`);
      p = await find();
      if (dead(p)) { logCall('playback', 0, 0, `provider returned an expired link (expired ${new Date(p.expires_at * 1000).toISOString()})`); throw new SylnError('Provider returned an expired stream link', 503, 'stale_link'); }
    }
  }
  if (!p.url) throw new SylnError('Episode unavailable', 404, 'unavailable');
  return p;
}
async function ping() {
  const t0 = Date.now();
  try {
    if (cfg.paths.ping) { const pl = await defaultPlatform(); await call(fill(cfg.paths.ping, { platform: pl }), {}, { retries: 0 }); return { ok: true, ms: Date.now() - t0, platforms: 1, tokenConfigured: !!cfg.token }; }
    const p = await listPlatforms(); return { ok: true, ms: Date.now() - t0, platforms: p.length, tokenConfigured: !!cfg.token };
  }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message, tokenConfigured: !!cfg.token }; }
}


// ── poster mirroring ─────────────────────────────────────────────────────────────────────────────
// The provider's cover links are signed and stop working after ~8 hours. We copy each cover once, while its link is
// still valid, into a public Supabase Storage bucket ("posters") and keep that permanent link instead.
const MIRROR = `${appConfig.supabaseUrl}/storage/v1/object/public/posters/`;
const isMirrored = u => !!u && String(u).startsWith(MIRROR);
const posterExpiry = u => { const m = /auth_key=(\d+)-/.exec(String(u || '')); return m ? Number(m[1]) * 1000 : 0; };
const posterDead = u => { const e = posterExpiry(u); return !!e && e < Date.now() + 30_000; };
let bucketReady = false, lastMirrorError = '';
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await db.storage.createBucket('posters', { public: true });
  if (error && !/exist|duplicate/i.test(error.message)) throw error;
  bucketReady = true;
}
async function mirrorOne(film) {
  const u = film.poster_url;
  if (!u || isMirrored(u)) return u;
  if (posterDead(u)) throw new Error('cover link already expired');
  await ensureBucket();
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error('cover HTTP ' + r.status);
  const ct = r.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(ct)) throw new Error('cover is not an image');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 500 || buf.length > 3_000_000) throw new Error('cover has a strange size');
  const name = String(film.id).replace(/[^a-z0-9_-]/gi, '_') + '.jpg';
  const { error } = await db.storage.from('posters').upload(name, buf, { contentType: ct, upsert: true, cacheControl: '31536000' });
  if (error) throw error;
  return MIRROR + name;
}
async function mirrorMany(films, n = 5) {
  let i = 0, ok = 0, bad = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < films.length) {
      const f = films[i++];
      try { const u = await mirrorOne(f); if (u && u !== f.poster_url) { f.poster_url = u; ok++; } }
      catch (e) { bad++; lastMirrorError = e.message; }
    }
  }));
  return { ok, bad };
}
async function posterReport() {
  const { data } = await db.from('films').select('poster_url').limit(5000);
  const r = { total: 0, mirrored: 0, live: 0, expired: 0, none: 0, lastError: lastMirrorError };
  for (const f of data || []) {
    r.total++;
    if (!f.poster_url) r.none++; else if (isMirrored(f.poster_url)) r.mirrored++; else if (posterDead(f.poster_url)) r.expired++; else r.live++;
  }
  return r;
}
// Copy every cover whose link is still valid into permanent storage.
async function fixPosters(limit = 300) {
  const { data } = await db.from('films').select('id,poster_url').not('poster_url', 'is', null).not('poster_url', 'like', MIRROR + '%').limit(2000);
  const todo = (data || []).filter(f => !posterDead(f.poster_url)).slice(0, limit);
  const res = await mirrorMany(todo);
  for (const f of todo) if (isMirrored(f.poster_url)) await db.from('films').update({ poster_url: f.poster_url }).eq('id', f.id);
  return { ...res, ...(await posterReport()) };
}

// ── persist metadata into Supabase cache (never overwrites admin settings) ──
async function upsertFilms(films) {
  const uniq = [...new Map(films.map(f => [f.id, f])).values()]; // duplicates in one batch make Postgres reject the whole upsert
  const now = new Date().toISOString();
  let saved = 0;
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    try { // keep covers we already copied; copy new ones while their signed link is fresh
      const { data: ex } = await db.from('films').select('id,poster_url').in('id', chunk.map(f => f.id));
      const have = new Map((ex || []).filter(r => isMirrored(r.poster_url)).map(r => [r.id, r.poster_url]));
      const fresh = [];
      for (const f of chunk) { if (have.has(f.id)) f.poster_url = have.get(f.id); else fresh.push(f); }
      await mirrorMany(fresh);
    } catch (e) { lastMirrorError = e.message; }
    const rows = chunk.map(f => ({ id: f.id, platform: f.platform, title: f.title, description: f.description, poster_url: f.poster_url, genres: f.genres, episode_count: f.episode_count, fetched_at: now }));
    const { error } = await db.from('films').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error('database: ' + error.message);
    saved += rows.length;
  }
  return saved;
}
async function upsertEpisodes(filmId, eps) {
  const uniq = [...new Map(eps.map(e => [e.ep_no, e])).values()];
  if (!uniq.length) return;
  const rows = uniq.map(e => ({ film_id: filmId, ep_no: e.ep_no, provider_episode_id: e.provider_episode_id, title: e.title, duration_sec: e.duration_sec, subtitles: e.subtitles }));
  const { error } = await db.from('episodes').upsert(rows, { onConflict: 'film_id,ep_no' });
  if (error) throw new Error('database: ' + error.message);
  await db.from('films').update({ episode_count: Math.max(...uniq.map(e => e.ep_no)) }).eq('id', filmId);
}

let syncing = null;
async function syncCatalogue({ platform, pages = 3 } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const targets = platform ? [platform] : (await listPlatforms()).map(x => x.id);
    let total = 0; const failed = [];
    for (const pl of targets) {
      try {
        const seen = new Set();
        for (let p = 1; p <= pages; p++) {
          const fresh = (await listCatalog({ platform: pl, page: p })).filter(f => !seen.has(f.id));
          if (!fresh.length) break;               // empty page, or the API repeats the same page: stop spending requests
          fresh.forEach(f => seen.add(f.id));
          total += await upsertFilms(fresh);
        }
      } catch (e) { failed.push(`${pl}: ${e.message}`); console.warn('[sync]', pl, e.message); }
    }
    if (!total && failed.length) throw new SylnError(failed.join('; '), 503, 'sync_failed');
    return { platform: targets.join(','), synced: total, failed };
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
    // The catalogue list already gave us the metadata; only fetch details for unknown films (saves quota).
    const film = row ? null : await getFilm(id);
    if (film) await upsertFilms([film]);
    const eps = await getEpisodes(id, film?.platform || row?.platform);
    await upsertEpisodes(id, eps);
    return true;
  } catch (e) {
    console.warn('[ensureFilm]', id, e.message);
    return !!row; // API down: fall back to whatever we already cached
  }
}

// Fire-and-forget: put a drama's episode list (which carries the stream links) in cache before the viewer taps play.
function warmEpisodes(fullId, platform) {
  if (cfg.paths.play) return;
  try { const sp = splitId(fullId, platform); if (sp.platform) episodesRaw(sp.platform, sp.code).catch(() => {}); } catch { /* ignore */ }
}

module.exports = { posterReport, fixPosters, warmEpisodes, cfg, SylnError, listPlatforms, defaultPlatform, listCatalog, search, searchAll, getFilm, getEpisodes, getPlayback, ping, upsertFilms, upsertEpisodes, syncCatalogue, ensureFilm };
