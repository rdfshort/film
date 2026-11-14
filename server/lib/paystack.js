const crypto = require('crypto');
const { config } = require('./core');

const BASE = 'https://api.paystack.co';

async function ps(method, path, body) {
  if (!config.paystackSecret) { const e = new Error('Paystack is not configured'); e.status = 503; throw e; }
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(BASE + path, {
      method, signal: ac.signal,
      headers: { Authorization: `Bearer ${config.paystackSecret}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === false) { const e = new Error(j.message || `Paystack ${r.status}`); e.status = r.status >= 500 ? 502 : 400; throw e; }
    return j.data;
  } finally { clearTimeout(t); }
}

// Paystack amounts are in the currency subunit (KES → cents).
const toSubunit = (kes) => Math.round(Number(kes) * 100);

const initialize = (p) => ps('POST', '/transaction/initialize', p);
const verify = (ref) => ps('GET', `/transaction/verify/${encodeURIComponent(ref)}`);
const charge = (p) => ps('POST', '/charge', p);                  // used for M-Pesa STK push
const submitOtp = (p) => ps('POST', '/charge/submit_otp', p);
const refund = (ref) => ps('POST', '/refund', { transaction: ref });

function validSignature(rawBody, signature) {
  if (!signature || !config.paystackSecret) return false;
  const h = crypto.createHmac('sha512', config.paystackSecret).update(rawBody).digest('hex');
  const a = Buffer.from(h), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initialize, verify, charge, submitOtp, refund, validSignature, toSubunit };
