-- Notifications: in-app inbox + push device tokens. Safe to re-run. Run once in the Supabase SQL editor.
create table if not exists notifications (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,        -- null = broadcast
  audience text not null default 'user' check (audience in ('user','all','vip')),
  kind text not null default 'info',
  title text not null,
  body text not null default '',
  url text,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_aud_idx on notifications (audience, created_at desc);

create table if not exists device_tokens (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null default 'android',
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user_idx on device_tokens (user_id);

create table if not exists notif_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now()
);

-- Only the server (service role) touches these tables.
alter table notifications enable row level security;
alter table device_tokens enable row level security;
alter table notif_state enable row level security;
