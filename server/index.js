const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { config, wrap } = require('./lib/core');
const payments = require('./routes/payments');

const app = express();
app.set('trust proxy', 1); // Render / reverse proxy
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      'img-src': ["'self'", 'data:', 'https:', 'blob:'],
      'media-src': ["'self'", 'https:', 'blob:'],
      'worker-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'https:', 'wss:', 'blob:'],
      'frame-ancestors': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client'],
}));

// Webhook needs the raw body for signature verification → registered BEFORE express.json()
app.post('/api/pay/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(payments.webhook));

app.use(express.json({ limit: '100kb' }));

const limit = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } });
app.use('/api', limit(60_000, 240));
app.use('/api/pay/coins', limit(60_000, 8));
app.use('/api/pay/vip', limit(60_000, 8));
app.use('/api/unlock', limit(60_000, 30));
app.use('/api/play', limit(60_000, 90));
app.use('/api/admin', limit(60_000, 120));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', require('./routes/catalog'));
app.use('/api', require('./routes/watch'));
app.use('/api/me', require('./routes/me'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/pay', payments.router);
app.use('/api/admin', require('./routes/admin'));

if (config.serveWeb) {
  const web = path.join(__dirname, '..', 'web');
  app.use(express.static(web, { maxAge: '1h', extensions: ['html'] }));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  // never leak internals (DB errors, tokens) to clients
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
});

app.listen(config.port, () => console.log(`VUTA server listening on :${config.port}`));
