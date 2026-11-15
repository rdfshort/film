const router = require('express').Router();
const { db, wrap } = require('../lib/core');
const { requireAuth, isVip } = require('../lib/auth');

router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const aud = isVip(req.user) ? 'all,vip' : 'all';
  const [{ data: items }, { data: st }] = await Promise.all([
    db.from('notifications').select('id,kind,title,body,url,created_at')
      .or(`user_id.eq.${req.user.id},and(user_id.is.null,audience.in.(${aud}))`).order('created_at', { ascending: false }).limit(50),
    db.from('notif_state').select('seen_at').eq('user_id', req.user.id).maybeSingle(),
  ]);
  const floor = Date.now() - 7 * 864e5; // never count anything older than a week as "new"
  const seen = Math.max(st && st.seen_at ? new Date(st.seen_at).getTime() : 0, floor);
  const list = (items || []).map(n => ({ ...n, unread: new Date(n.created_at).getTime() > seen }));
  res.json({ items: list, unread: list.filter(n => n.unread).length });
}));

router.post('/seen', wrap(async (req, res) => {
  const { error } = await db.from('notif_state').upsert({ user_id: req.user.id, seen_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
  res.json({ ok: true });
}));

router.post('/token', wrap(async (req, res) => {
  const token = String(req.body.token || '');
  if (token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'bad_token' });
  const { error } = await db.from('device_tokens').upsert({ user_id: req.user.id, token, platform: 'android', updated_at: new Date().toISOString() }, { onConflict: 'token' });
  if (error) throw error;
  res.json({ ok: true });
}));

router.post('/token/remove', wrap(async (req, res) => {
  const token = String(req.body.token || '');
  if (token) await db.from('device_tokens').delete().eq('user_id', req.user.id).eq('token', token);
  res.json({ ok: true });
}));

module.exports = router;
