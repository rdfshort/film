// In-app notifications (inbox) + Android push through Firebase Cloud Messaging (free).
// Push is optional: without FIREBASE_SERVICE_ACCOUNT_B64 the inbox still works.
const { db } = require('./core');

let admin = null, ready = false;
(function init() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.log('[push] off: set FIREBASE_SERVICE_ACCOUNT_B64 to enable phone notifications'); return; }
  try {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))) });
    ready = true; console.log('[push] Firebase ready');
  } catch (e) { console.warn('[push] disabled:', e.message); }
})();

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);
const safeUrl = u => (typeof u === 'string' && /^#\/[A-Za-z0-9/_?=&:%.-]{0,120}$/.test(u) ? u : '');

async function sendToTokens(tokens, { title, body, url }) {
  if (!ready || !tokens.length) return 0;
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    try {
      const r = await admin.messaging().sendEachForMulticast({
        tokens: chunk, notification: { title, body }, data: url ? { url } : {},
        android: { priority: 'high' },
      });
      sent += r.successCount;
      const dead = chunk.filter((_t, k) => r.responses[k] && !r.responses[k].success && DEAD.has(r.responses[k].error && r.responses[k].error.code));
      if (dead.length) await db.from('device_tokens').delete().in('token', dead);
    } catch (e) { console.warn('[push] send failed:', e.message); }
  }
  return sent;
}

async function tokensFor({ audience, userIds }) {
  let q = db.from('device_tokens').select('token');
  if (audience === 'user') q = q.in('user_id', userIds && userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']);
  else if (audience === 'vip') {
    const { data: v } = await db.from('profiles').select('id').gt('vip_until', new Date().toISOString()).limit(20000);
    q = q.in('user_id', (v || []).map(x => x.id).concat(['00000000-0000-0000-0000-000000000000']));
  }
  const { data } = await q.limit(20000);
  return (data || []).map(x => x.token);
}

// audience: 'user' (needs userIds) | 'all' | 'vip'.  Always stored in the inbox; pushed to phones when Firebase is set up.
async function notify({ audience = 'user', userIds = [], title, body = '', url = '', kind = 'info' }) {
  title = String(title || '').trim().slice(0, 80); body = String(body || '').trim().slice(0, 200); url = safeUrl(url);
  if (!title) throw new Error('title required');
  if (audience === 'user') {
    if (!userIds.length) return { inbox: 0, pushed: 0 };
    const { error } = await db.from('notifications').insert(userIds.map(id => ({ user_id: id, audience: 'user', kind, title, body, url: url || null })));
    if (error) throw error;
  } else {
    const { error } = await db.from('notifications').insert({ user_id: null, audience, kind, title, body, url: url || null });
    if (error) throw error;
  }
  const pushed = await sendToTokens(await tokensFor({ audience, userIds }), { title, body, url });
  return { inbox: audience === 'user' ? userIds.length : 1, pushed };
}

module.exports = { notify, isReady: () => ready };
