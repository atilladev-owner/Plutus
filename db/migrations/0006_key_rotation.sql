create table api_key_old_secrets (
  secret_hash bytea primary key,
  key_id text not null references api_keys(id) on delete cascade,
  expires_at timestamptz not null
);
