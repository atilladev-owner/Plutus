create table idempotency_keys (
  key_id text not null references api_keys(id) on delete cascade,
  idem_key text not null,
  fingerprint bytea not null,
  status text not null check (status in ('pending', 'done')),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (key_id, idem_key)
);
create index idempotency_expires_idx on idempotency_keys (expires_at);
