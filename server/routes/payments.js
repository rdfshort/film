const crypto = require('crypto');
const router = require('express').Router();
const { db, config, getSettings, wrap, isUuid } = require('../lib/core');
const { requireAuth } = require('../lib/auth');
const ps = require('../lib/paystack');

const CHANNELS = ['mpesa', 'card', 'apple_pay'];

function normPhone(p) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  let m = d.replace(/^\+/, '');
  if (/^0[17]\d{8}$/.test(m)) m = '254' + m.slice(1);
  else if (/^[17]\d{8}$/.test(m)) m = '254' + m;
  return /^254[17]\d{8}$/.test(m) ? '+' + m : null;
}

// Verify with Paystack (server → server) and credit atomically. Safe to call many times.
async function verifyAndCredit(reference) {
  const d = await ps.verify(reference);
  if (!d || d.reference !== reference) return { status: 'pending' };
  if (d.status === 'success') {
    if (d.currency && d.currency !== config.currency) return { status: 'failed', error: 'currency_mismatch' };
    const { data, error } = await db.rpc('credit_purchase', { p_reference: reference, p_paid_kes: Number(d.amount) / 100, p_channel: d.channel || null, p_gateway: d });
    if (error) throw error;
    return { status: data.ok ? 'success' : 'failed', error: data.error, already: data.already };
  }
  if (d.status === 'failed') {
    await db.from('transactions').update({ status: 'failed', gateway_payload: d }).eq('reference', reference).eq('status', 'pending');
    return { status: 'failed', message: d.gateway_response };
  }
  return { status: 'pending' };
}

async function createCheckout(req, res, kind) {
  if (req.headers['x-client'] === 'native') {
    // App Store / Google Play rules: digital goods in native apps must use store billing.
    return res.status(409).json({ error: 'use_store_billing', message: 'Purchases in the mobile app use the app store. Use the website to pay with M-Pesa or card.' });
  }
  const channel = String(req.body.channel || '');
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'bad_channel' });
  const settings = await getSettings();
  const enabled = settings.payment_methods || {};
  if (!enabled[channel]) return res.status(400).json({ error: 'method_disabled' });

  const itemId = String(req.body[kind === 'vip' ? 'planId' : 'packageId'] || '');
  if (!isUuid(itemId)) return res.status(400).json({ error: 'bad_item' });
  const table = kind === 'vip' ? 'vip_plans' : 'coin_packages';
  const { data: item } = await db.from(table).select('*').eq('id', itemId).eq('active', true).maybeSingle();
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  let phone = null;
  if (channel === 'mpesa') {
    phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'bad_phone', message: 'Enter a valid Safaricom number, e.g. 0712345678' });
  }

  const reference = `VUTA-${kind === 'vip' ? 'V' : 'C'}-${crypto.randomBytes(9).toString('hex')}`;
  const amount = Number(item.price_kes);
  const { error: insErr } = await db.from('transactions').insert({
    user_id: req.user.id, reference, kind, amount_kes: amount, coins: kind === 'vip' ? 0 : item.coins,
    package_id: kind === 'vip' ? null : item.id, plan_id: kind === 'vip' ? item.id : null, channel, status: 'pending',
  });
  if (insErr) throw insErr;

  const metadata = { user_id: req.user.id, kind, item_id: item.id };
  try {
    if (channel === 'mpesa') {
      const d = await ps.charge({
        email: req.user.email, amount: ps.toSubunit(amount), currency: config.currency, reference,
        mobile_money: { phone, provider: 'mpesa' }, metadata,
      });
      if (d.status === 'failed') {
        await db.from('transactions').update({ status: 'failed', gateway_payload: d }).eq('reference', reference);
        return res.status(402).json({ error: 'charge_failed', message: d.gateway_response || 'Could not start M-Pesa payment' });
      }
      return res.json({ reference, mode: 'stk', message: d.display_text || 'Check your phone and enter your M-Pesa PIN.' });
    }
    const body = {
      email: req.user.email, amount: ps.toSubunit(amount), currency: config.currency, reference, metadata,
      channels: channel === 'card' ? ['card'] : ['apple_pay', 'card'],
      callback_url: `${config.webUrl.replace(/\/$/, '')}/?pay=${reference}`,
    };
    if (kind === 'vip' && item.paystack_plan_code && channel === 'card') body.plan = item.paystack_plan_code; // card auto-renew
    const d = await ps.initialize(body);
    return res.json({ reference, mode: 'redirect', url: d.authorization_url });
  } catch (e) {
    await db.from('transactions').update({ status: 'failed' }).eq('reference', reference).eq('status', 'pending');
    return res.status(e.status === 503 ? 503 : 502).json({ error: 'gateway_error', message: e.status === 503 ? 'Payments are not configured yet.' : 'Payment provider error. Please try again.' });
  }
}

router.post('/coins', requireAuth, wrap((req, res) => createCheckout(req, res, 'coin_purchase')));
router.post('/vip', requireAuth, wrap((req, res) => createCheckout(req, res, 'vip')));

// Frontend polls this. The status shown is always the SERVER's verified status, never a client claim.
router.get('/status/:ref', requireAuth, wrap(async (req, res) => {
  const ref = req.params.ref;
  if (!/^VUTA-[CV]-[a-f0-9]{18}$/.test(ref)) return res.status(400).json({ error: 'bad_ref' });
  let { data: t } = await db.from('transactions').select('reference,status,kind,coins,amount_kes').eq('reference', ref).eq('user_id', req.user.id).maybeSingle();
  if (!t) return res.status(404).json({ error: 'not_found' });
  let message;
  if (t.status === 'pending') {
    try { const r = await verifyAndCredit(ref); message = r.message; } catch { /* gateway hiccup: keep pending */ }
    ({ data: t } = await db.from('transactions').select('reference,status,kind,coins,amount_kes').eq('reference', ref).maybeSingle());
  }
  const { data: w } = await db.from('wallets').select('balance').eq('user_id', req.user.id).maybeSingle();
  res.json({ ...t, balance: w?.balance || 0, message });
}));

// ── Paystack webhook (mounted with express.raw in index.js so the signature covers the exact bytes) ──
async function webhook(req, res) {
  const raw = req.body; // Buffer
  if (!Buffer.isBuffer(raw) || !ps.validSignature(raw, req.headers['x-paystack-signature'])) return res.sendStatus(401);
  let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  const d = evt.data || {};
  const key = `${evt.event}:${d.id || d.reference || d.subscription_code || crypto.createHash('sha1').update(raw).digest('hex')}`;
  const { error: dupErr } = await db.from('webhook_events').insert({ id: key });
  if (dupErr) {
    if (dupErr.code === '23505') return res.sendStatus(200); // unique violation → already processed, replay ignored
    console.error('[webhook] dedupe insert failed:', dupErr.message);
    return res.sendStatus(500);                               // DB trouble: make Paystack retry later
  }
  try {
    if (evt.event === 'charge.success') {
      let { data: t } = await db.from('transactions').select('reference').eq('reference', d.reference).maybeSingle();
      if (!t && d.plan?.plan_code) { // recurring card renewal created by Paystack, not by us
        const [{ data: u }, { data: plan }] = await Promise.all([
          db.from('profiles').select('id').eq('email', d.customer?.email).maybeSingle(),
          db.from('vip_plans').select('id,price_kes').eq('paystack_plan_code', d.plan.plan_code).maybeSingle(),
        ]);
        if (u && plan) {
          await db.from('transactions').insert({ user_id: u.id, reference: d.reference, kind: 'vip', plan_id: plan.id, amount_kes: plan.price_kes, channel: d.channel, status: 'pending' });
          t = { reference: d.reference };
        }
      }
      if (t) await verifyAndCredit(d.reference); // re-verify with Paystack; never trust the payload alone
    } else if (evt.event === 'charge.failed' || evt.event === 'paymentrequest.failed') {
      if (d.reference) await db.from('transactions').update({ status: 'failed', gateway_payload: d }).eq('reference', d.reference).eq('status', 'pending');
    } else if (evt.event === 'refund.processed') {
      const ref = d.transaction_reference || d.transaction?.reference;
      if (ref) await db.rpc('refund_transaction', { p_reference: ref });
    } else if (evt.event === 'subscription.create' && d.customer?.email) {
      const { data: u } = await db.from('profiles').select('id').eq('email', d.customer.email).maybeSingle();
      if (u) await db.from('subscriptions').update({ paystack_sub_code: d.subscription_code, auto_renew: true }).eq('user_id', u.id).eq('status', 'active');
    } else if (evt.event === 'subscription.disable' || evt.event === 'subscription.not_renew') {
      await db.from('subscriptions').update({ auto_renew: false }).eq('paystack_sub_code', d.subscription_code);
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('[webhook]', evt.event, e.message);
    await db.from('webhook_events').delete().eq('id', key); // free the key so Paystack's retry reprocesses it
    return res.sendStatus(500);
  }
}

module.exports = { router, webhook, verifyAndCredit };
