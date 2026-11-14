const { db, cache } = require('./core');

async function resolveUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const ck = 'tok:' + token.slice(-40);
  let user = cache.get(ck);
  if (!user) {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: p } = await db.from('profiles').select('id,email,display_name,role,disabled,vip_until').eq('id', data.user.id).maybeSingle();
    user = { id: data.user.id, email: data.user.email, ...(p || {}), role: p?.role || 'user' };
    cache.set(ck, user, 15_000); // short: role/disabled changes take effect within seconds
  }
  return user;
}

const optionalAuth = async (req, _res, next) => { try { req.user = await resolveUser(req); } catch { req.user = null; } next(); };

const requireAuth = async (req, res, next) => {
  try {
    const u = await resolveUser(req);
    if (!u) return res.status(401).json({ error: 'auth_required' });
    if (u.disabled) return res.status(403).json({ error: 'account_disabled' });
    req.user = u; next();
  } catch (e) { next(e); }
};

const requireAdmin = (req, res, next) =>
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });

const isVip = (u) => !!(u && u.vip_until && new Date(u.vip_until) > new Date());

module.exports = { optionalAuth, requireAuth, requireAdmin, isVip };
