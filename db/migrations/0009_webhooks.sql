create table webhook_endpoints (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null,
  status text not null check (status in ('active', 'disabled')),
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now()
);
create index webhook_endpoints_key_idx on webhook_endpoints (key_id, created_at desc, id);

create table webhook_deliveries (
  id text primary key,
  endpoint_id text not null references webhook_endpoints(id) on delete cascade,
  event_id text not null references events(id) on delete cascade,
  attempt int not null default 0,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'dead')),
  response_status int,
  response_excerpt text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc, id);
create index webhook_deliveries_pending_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
