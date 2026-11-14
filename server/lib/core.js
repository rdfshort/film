require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const env = (k, d = '') => (process.env[k] === undefined ? d : process.env[k]);

const config = {
  port: Number(env('PORT', 3000)),
  corsOrigins: env('CORS_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
  webUrl: env('PUBLIC_WEB_URL', 'http://localhost:3000'),
  serveWeb: env('SERVE_WEB', 'true') === 'true',
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnon: env('SUPABASE_ANON_KEY'),
  supabaseService: env('SUPABASE_SERVICE_ROLE_KEY'),
  paystackSecret: env('PAYSTACK_SECRET_KEY'),
  currency: env('PAYSTACK_CURRENCY', 'KES'),
};

for (const k of ['supabaseUrl', 'supabaseService']) {
  if (!config[k]) console.warn(`[config] Missing ${k}; set it in server/.env`);
}

const db = createClient(config.supabaseUrl || 'http://localhost', config.supabaseService || 'x', {
  auth: { persistSession: false, autoRefreshToken: false },
});

// tiny TTL cache with stale-if-error support
class TTL {
  constructor() { this.m = new Map(); }
  get(k, allowStale = false) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp > Date.now() || allowStale) return e.v;
    return undefined;
  }
  set(k, v, ms) { this.m.set(k, { v, exp: Date.now() + ms }); if (this.m.size > 2000) this.m.delete(this.m.keys().next().value); }
  del(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const cache = new TTL();

// settings (admin-configurable), cached briefly
async function getSettings() {
  const hit = cache.get('settings');
  if (hit) return hit;
  const { data } = await db.from('settings').select('key,value');
  const s = {};
  (data || []).forEach(r => { s[r.key] = r.value; });
  cache.set('settings', s, 20_000);
  return s;
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clampInt = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const isUuid = s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const safeId = s => typeof s === 'string' && /^[\w.\-:]{1,120}$/.test(s);

module.exports = { config, db, cache, getSettings, wrap, clampInt, isUuid, safeId, env };
