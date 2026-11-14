-- VUTA short-drama platform: Supabase schema
-- Run once in Supabase SQL editor. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).

create extension if not exists pgcrypto;

-- ───────────── Profiles & wallets ─────────────
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user','admin')),
  disabled boolean not null default false,
  vip_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, email, display_name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
    on conflict do nothing;
  insert into wallets(user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ───────────── Settings ─────────────
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into settings(key, value) values
  ('free_episodes',     '3'),
  ('default_coin_price','20'),
  ('payment_methods',   '{"mpesa":true,"card":true,"apple_pay":true}'),
  ('site_name',         '"VUTA"'),
  ('ads_enabled',       'true')
on conflict (key) do nothing;

-- ───────────── Catalogue cache ─────────────
create table if not exists films (
  id text primary key,                 -- provider film id
  platform text,
  title text not null,
  description text,
  poster_url text,
  genres text[] not null default '{}',
  episode_count int not null default 0,
  free_episodes int,                   -- null = use global setting
  coin_price int,                      -- null = use global setting
  vip_eligible boolean not null default true,
  hidden boolean not null default false,
  featured boolean not null default false,
  collections text[] not null default '{}',
  views int not null default 0,
  raw jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists films_visible_idx on films (hidden, featured, fetched_at desc);
create index if not exists films_genres_idx on films using gin (genres);
create index if not exists films_collections_idx on films using gin (collections);
create index if not exists films_title_idx on films (lower(title));

create table if not exists episodes (
  film_id text not null references films(id) on delete cascade,
  ep_no int not null,
  provider_episode_id text,
  title text,
  duration_sec int,
  subtitles jsonb not null default '[]',
  is_free boolean,                     -- null = decided by free_episodes
  coin_price int,                      -- null = film/global price
  hidden boolean not null default false,
  primary key (film_id, ep_no)
);

create table if not exists collections (
  slug text primary key,
  title text not null,
  vip_only boolean not null default false,
  sort int not null default 0,
  active boolean not null default true
);

-- ───────────── Monetisation config ─────────────
create table if not exists coin_packages (
  id uuid primary key default gen_random_uuid(),
  coins int not null check (coins > 0),
  price_kes numeric(12,2) not null check (price_kes > 0),
  label text,
  sort int not null default 0,
  active boolean not null default true
);
insert into coin_packages(coins, price_kes, sort)
select * from (values (100,100,1),(500,450,2),(1000,850,3),(2500,2000,4)) v(c,p,s)
where not exists (select 1 from coin_packages);

create table if not exists vip_plans (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,           -- 'weekly' | 'monthly'
  name text not null,
  days int not null check (days > 0),
  price_kes numeric(12,2) not null check (price_kes > 0),
  benefits jsonb not null default '[]',
  paystack_plan_code text,             -- set for card auto-renew via Paystack plans
  active boolean not null default true,
  sort int not null default 0
);
insert into vip_plans(code, name, days, price_kes, benefits, sort)
select * from (values
  ('weekly','VIP Weekly',7,250,'["Eligible premium episodes","Exclusive collections","Fewer interruptions"]'::jsonb,1),
  ('monthly','VIP Monthly',30,800,'["Eligible premium episodes","Exclusive collections","Fewer interruptions"]'::jsonb,2)
) v(a,b,c,d,e,f)
where not exists (select 1 from vip_plans);

-- ───────────── Payments & ledger ─────────────
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text unique not null,
  kind text not null check (kind in ('coin_purchase','vip')),
  package_id uuid references coin_packages(id),
  plan_id uuid references vip_plans(id),
  amount_kes numeric(12,2) not null,
  coins int not null default 0,
  status text not null default 'pending' check (status in ('pending','success','failed','refunded')),
  channel text,
  gateway text not null default 'paystack',
  gateway_payload jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists transactions_user_idx on transactions (user_id, created_at desc);
create index if not exists transactions_status_idx on transactions (status, created_at desc);

create table if not exists coin_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta bigint not null,
  balance_after bigint not null,
  reason text not null check (reason in ('purchase','unlock','refund','admin_adjust','bonus')),
  ref text,
  created_at timestamptz not null default now(),
  unique (reason, ref)                 -- one purchase credit / one unlock charge per ref
);
create index if not exists ledger_user_idx on coin_ledger (user_id, created_at desc);

create table if not exists unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  film_id text not null references films(id) on delete cascade,
  ep_no int not null,
  price int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, film_id, ep_no)
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references vip_plans(id),
  status text not null default 'active' check (status in ('active','cancelled','expired')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reference text,
  paystack_sub_code text,
  auto_renew boolean not null default false
);
create index if not exists subs_user_idx on subscriptions (user_id, expires_at desc);

create table if not exists webhook_events (
  id text primary key,                 -- gateway event key; duplicates are ignored (replay protection)
  received_at timestamptz not null default now()
);

-- ───────────── Viewing data ─────────────
create table if not exists watch_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  film_id text not null references films(id) on delete cascade,
  ep_no int not null,
  position_sec int not null default 0,
  duration_sec int,
  updated_at timestamptz not null default now(),
  primary key (user_id, film_id, ep_no)
);
create index if not exists watch_user_idx on watch_history (user_id, updated_at desc);

create table if not exists my_list (
  user_id uuid not null references auth.users(id) on delete cascade,
  film_id text not null references films(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, film_id)
);

create table if not exists api_logs (
  id bigserial primary key,
  ts timestamptz not null default now(),
  endpoint text,
  status int,
  ms int,
  error text
);
create index if not exists api_logs_ts_idx on api_logs (ts desc);

-- ───────────── Atomic money functions (service role only) ─────────────
create or replace function credit_purchase(p_reference text, p_paid_kes numeric, p_channel text, p_gateway jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t transactions%rowtype; bal bigint; plan vip_plans%rowtype; base timestamptz; new_exp timestamptz;
begin
  select * into t from transactions where reference = p_reference for update;
  if not found then return jsonb_build_object('ok',false,'error','unknown_reference'); end if;
  if t.status = 'success' then return jsonb_build_object('ok',true,'already',true); end if;
  if t.status = 'refunded' then return jsonb_build_object('ok',false,'error','refunded'); end if;
  if p_paid_kes < t.amount_kes then
    update transactions set status='failed', gateway_payload=p_gateway where id=t.id;
    return jsonb_build_object('ok',false,'error','amount_mismatch');
  end if;

  update transactions set status='success', paid_at=now(), channel=p_channel, gateway_payload=p_gateway where id=t.id;

  if t.kind = 'coin_purchase' then
    update wallets set balance = balance + t.coins, updated_at = now() where user_id = t.user_id returning balance into bal;
    insert into coin_ledger(user_id, delta, balance_after, reason, ref) values (t.user_id, t.coins, bal, 'purchase', t.reference);
  else
    select * into plan from vip_plans where id = t.plan_id;
    select greatest(coalesce(max(expires_at), now()), now()) into base from subscriptions where user_id = t.user_id and status='active';
    new_exp := base + make_interval(days => plan.days);
    insert into subscriptions(user_id, plan_id, expires_at, reference) values (t.user_id, plan.id, new_exp, t.reference);
    update profiles set vip_until = new_exp where id = t.user_id;
  end if;
  return jsonb_build_object('ok',true,'kind',t.kind);
end $$;

create or replace function unlock_episode(p_user uuid, p_film text, p_ep int, p_price int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bal bigint; ref text := p_user::text || ':' || p_film || ':' || p_ep;
begin
  if exists (select 1 from unlocks where user_id=p_user and film_id=p_film and ep_no=p_ep) then
    return jsonb_build_object('ok',true,'already',true);
  end if;
  select balance into bal from wallets where user_id = p_user for update;
  if bal is null then return jsonb_build_object('ok',false,'error','no_wallet'); end if;
  -- re-check under the lock (concurrent double-tap)
  if exists (select 1 from unlocks where user_id=p_user and film_id=p_film and ep_no=p_ep) then
    return jsonb_build_object('ok',true,'already',true,'balance',bal);
  end if;
  if bal < p_price then return jsonb_build_object('ok',false,'error','insufficient_coins','balance',bal); end if;
  update wallets set balance = balance - p_price, updated_at = now() where user_id = p_user returning balance into bal;
  insert into coin_ledger(user_id, delta, balance_after, reason, ref) values (p_user, -p_price, bal, 'unlock', ref);
  insert into unlocks(user_id, film_id, ep_no, price) values (p_user, p_film, p_ep, p_price);
  return jsonb_build_object('ok',true,'balance',bal);
end $$;

create or replace function refund_transaction(p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t transactions%rowtype; bal bigint; take bigint;
begin
  select * into t from transactions where reference = p_reference for update;
  if not found or t.status <> 'success' then return jsonb_build_object('ok',false,'error','not_refundable'); end if;
  update transactions set status='refunded' where id = t.id;
  if t.kind = 'coin_purchase' then
    select balance into bal from wallets where user_id = t.user_id for update;
    take := least(bal, t.coins);
    update wallets set balance = balance - take where user_id = t.user_id returning balance into bal;
    insert into coin_ledger(user_id, delta, balance_after, reason, ref) values (t.user_id, -take, bal, 'refund', t.reference);
  else
    update subscriptions set status='cancelled', expires_at = now() where reference = t.reference;
    update profiles set vip_until = (select max(expires_at) from subscriptions where user_id=t.user_id and status='active') where id = t.user_id;
  end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function admin_adjust_coins(p_user uuid, p_delta bigint, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  select balance into bal from wallets where user_id = p_user for update;
  if bal is null or bal + p_delta < 0 then return jsonb_build_object('ok',false,'error','invalid'); end if;
  update wallets set balance = balance + p_delta where user_id = p_user returning balance into bal;
  insert into coin_ledger(user_id, delta, balance_after, reason, ref)
    values (p_user, p_delta, bal, 'admin_adjust', coalesce(p_note,'') || ':' || gen_random_uuid()::text);
  return jsonb_build_object('ok',true,'balance',bal);
end $$;

create or replace function admin_stats()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'users',        (select count(*) from profiles),
    'active_vip',   (select count(distinct user_id) from subscriptions where status='active' and expires_at > now()),
    'revenue_kes',  (select coalesce(sum(amount_kes),0) from transactions where status='success'),
    'coin_sales_kes',(select coalesce(sum(amount_kes),0) from transactions where status='success' and kind='coin_purchase'),
    'coins_sold',   (select coalesce(sum(coins),0) from transactions where status='success' and kind='coin_purchase'),
    'tx_pending',   (select count(*) from transactions where status='pending'),
    'tx_failed',    (select count(*) from transactions where status='failed'),
    'films',        (select count(*) from films),
    'unlocks',      (select count(*) from unlocks)
  );
$$;

revoke all on function credit_purchase(text,numeric,text,jsonb) from public, anon, authenticated;
revoke all on function unlock_episode(uuid,text,int,int)        from public, anon, authenticated;
revoke all on function refund_transaction(text)                  from public, anon, authenticated;
revoke all on function admin_adjust_coins(uuid,bigint,text)      from public, anon, authenticated;
revoke all on function admin_stats()                             from public, anon, authenticated;
grant execute on function credit_purchase(text,numeric,text,jsonb) to service_role;
grant execute on function unlock_episode(uuid,text,int,int)        to service_role;
grant execute on function refund_transaction(text)                  to service_role;
grant execute on function admin_adjust_coins(uuid,bigint,text)      to service_role;
grant execute on function admin_stats()                             to service_role;

-- ───────────── Row-level security ─────────────
-- The backend uses the service-role key (bypasses RLS). Browser clients only use the anon key
-- for Supabase Auth and may only READ their own rows. No client can write money-related tables.
alter table profiles        enable row level security;
alter table wallets         enable row level security;
alter table settings        enable row level security;
alter table films           enable row level security;
alter table episodes        enable row level security;
alter table collections     enable row level security;
alter table coin_packages   enable row level security;
alter table vip_plans       enable row level security;
alter table transactions    enable row level security;
alter table coin_ledger     enable row level security;
alter table unlocks         enable row level security;
alter table subscriptions   enable row level security;
alter table webhook_events  enable row level security;
alter table watch_history   enable row level security;
alter table my_list         enable row level security;
alter table api_logs        enable row level security;

drop policy if exists own_profile_read   on profiles;
create policy own_profile_read   on profiles      for select using (id = auth.uid());
drop policy if exists own_wallet_read    on wallets;
create policy own_wallet_read    on wallets       for select using (user_id = auth.uid());
drop policy if exists own_tx_read        on transactions;
create policy own_tx_read        on transactions  for select using (user_id = auth.uid());
drop policy if exists own_ledger_read    on coin_ledger;
create policy own_ledger_read    on coin_ledger   for select using (user_id = auth.uid());
drop policy if exists own_unlocks_read   on unlocks;
create policy own_unlocks_read   on unlocks       for select using (user_id = auth.uid());
drop policy if exists own_subs_read      on subscriptions;
create policy own_subs_read      on subscriptions for select using (user_id = auth.uid());
drop policy if exists own_history_read   on watch_history;
create policy own_history_read   on watch_history for select using (user_id = auth.uid());
drop policy if exists own_list_read      on my_list;
create policy own_list_read      on my_list       for select using (user_id = auth.uid());
-- Public, non-sensitive catalogue/config (visible titles only). Playback URLs are never stored here.
drop policy if exists public_films_read  on films;
create policy public_films_read  on films         for select using (hidden = false);
drop policy if exists public_eps_read    on episodes;
create policy public_eps_read    on episodes      for select using (hidden = false);
drop policy if exists public_coll_read   on collections;
create policy public_coll_read   on collections   for select using (active = true);
drop policy if exists public_pkg_read    on coin_packages;
create policy public_pkg_read    on coin_packages for select using (active = true);
drop policy if exists public_plans_read  on vip_plans;
create policy public_plans_read  on vip_plans     for select using (active = true);
-- settings, webhook_events, api_logs: no policies = no client access.

-- To make yourself admin after signing up:
--   update profiles set role='admin' where email='YOUR_EMAIL';
