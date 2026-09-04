create table api_keys (
  id text primary key,
  secret_hash bytea not null unique,
  prefix text not null,
  last4 text not null,
  mode text not null check (mode in ('test', 'live')),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  rotated_to text references api_keys(id),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_idle_idx on api_keys (mode, last_used_at);
