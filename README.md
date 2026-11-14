# VUTA – short-drama streaming platform

Vertical (9:16) short-drama site: browse, watch free episodes, unlock premium ones with coins, or go VIP.
Plain HTML/JS frontend (no build step), Node/Express backend, Supabase (auth + database), Paystack payments, Syln API for catalogue and playback.

```
supabase/schema.sql   tables, indexes, RLS, atomic money functions
server/               Express API (Syln proxy, wallet, unlocks, payments, admin)
web/                  site (index.html) and admin dashboard (admin.html)
```

## 1. Supabase
1. Create a project at supabase.com.
2. SQL editor → paste and run `supabase/schema.sql`.
3. Authentication → Providers → Email: enabled. (Optional: turn off "Confirm email" while testing.)
4. Authentication → URL configuration: add your site URL (needed for password-reset links).
5. Settings → API: copy the project URL, `anon` key and `service_role` key.

## 2. Configure the server
```
cd server
cp .env.example .env     # then fill it in
npm install
npm start                # http://localhost:3000 (also serves ../web)
```
Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, `SYLN_API_TOKEN`.
The service-role key, Paystack secret and Syln token live only in the server environment. The browser only ever receives the Supabase URL and anon key.

### Make yourself admin
Sign up on the site, then in the Supabase SQL editor:
```sql
update profiles set role = 'admin' where email = 'you@example.com';
```
Open `/admin.html` (also linked from Profile).

## 3. Syln API: one thing you must check
syln.dev blocks automated readers, so the exact endpoint paths and response fields could not be confirmed while this was built.
The adapter (`server/lib/syln.js`) is therefore driven by `.env`:
- `SYLN_AUTH_HEADER` / `SYLN_AUTH_SCHEME`: how the token is sent (Bearer or a custom header).
- `SYLN_PATH_*`: the six endpoint paths (platforms, catalogue, search, film, episodes, playback). Defaults are placeholders.
- `SYLN_FIELD_MAP`: only needed if the response field names differ. The adapter already tries many common names (`title`/`name`, `poster`/`cover`, …).

Open the docs shown with your token, set the paths, then check **Admin → Syln API** (shows connection state, latency and every request/error). Click **Sync from Syln** in **Admin → Catalogue** to import titles.

How it behaves: requests are rate-limited to `SYLN_REQUESTS_PER_SECOND` with retry on 429, catalogue metadata is cached in memory and in Supabase (served stale if Syln is down), playback URLs are never cached and are fetched fresh each time an episode opens, and expired URLs trigger an automatic refresh that resumes at the same second. Videos are streamed from the provider and never downloaded or re-hosted. Titles are third-party content: hide anything you aren't licensed to show (Admin → Catalogue → Hidden).

## 4. Paystack (test mode first)
1. Use your `sk_test_…` key in `.env`.
2. Paystack dashboard → Settings → API Keys & Webhooks → webhook URL: `https://YOUR-API-HOST/api/pay/webhook`.
3. Test cards: Paystack docs list test card numbers. For M-Pesa use the test numbers Paystack provides for Kenya.
4. Enable the channels (M-Pesa, Cards, Apple Pay) on your Paystack account; Apple Pay also needs domain verification in the dashboard. A method only appears at checkout if both Paystack and **Admin → Pricing & VIP** have it enabled.
5. Go live by swapping to `sk_live_…`.

Flow: server creates a pending transaction with a unique reference → Paystack charge (M-Pesa STK push) or hosted checkout (card / Apple Pay) → coins or VIP are credited only after the server verifies the payment with Paystack (webhook signature check + a server-to-server verify call), inside one database transaction. Webhooks are de-duplicated, amounts are checked against the price stored at checkout, and nothing the browser reports is trusted.

VIP: M-Pesa purchases cover one period. For automatic card renewal, create weekly/monthly **Plans** in Paystack and paste each plan code into Admin → Pricing & VIP.

## 5. Deploy (matches your usual stack)
- **API on Render**: root `server/`, build `npm install`, start `npm start`, set the env vars. Set `SERVE_WEB=false`, `CORS_ORIGINS=https://YOURNAME.github.io`, `PUBLIC_WEB_URL=https://YOURNAME.github.io/REPO`.
- **Frontend on GitHub Pages**: publish the `web/` folder and set `window.VUTA_API` in `web/config.js` to your Render URL.
- Render's free tier sleeps; the first request after idle is slow.

## 6. What is configurable by admins (no code)
Free episodes per drama (global and per drama), coin price per episode (global, per drama, per episode via API), coin packages, VIP plans and benefits, payment methods, featured dramas, hidden dramas, collections (including VIP-only), user coin adjustments, disabling or promoting users, refunds.

## 7. Security summary
- Playback URLs are issued only by `POST /api/play`, after the server checks free / unlocked / VIP, and are sent with `Cache-Control: no-store`.
- Unlock price comes from server policy, never from the client. `unlock_episode` locks the wallet row, so double-taps cannot double-charge, and an existing unlock is never charged again.
- All coin and subscription changes run in SQL functions callable only by the service role. Row-level security lets clients read only their own rows and write nothing money-related.
- Admin routes check the role on the server on every call. Rate limits on all API routes (tighter on payments and unlocks), input validation on IDs and amounts, Helmet security headers, CORS allow-list.

## 8. Not done / needs your attention
- **Native iOS/Android apps are not built.** This is a responsive web app/PWA. Wrapping it (e.g. Capacitor) is straightforward, and the server already refuses Paystack checkout for requests marked `X-Client: native` (returns `use_store_billing`). Apple and Google require their own billing for coins and subscriptions in native apps, so you would add App Store / Play billing (e.g. via RevenueCat) and a server endpoint that validates receipts and credits through the same `credit_purchase` function.
- Not tested against live Supabase, Paystack or Syln (no credentials here). The server boots, serves the site, rejects unauthenticated calls and bad webhook signatures; the rest needs your keys to exercise.
- No app icons in `manifest.webmanifest` yet.
- Subtitles use `<track>` elements, so they only show if the provider's subtitle files allow cross-origin loading.
