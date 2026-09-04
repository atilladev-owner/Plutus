create table ledgers (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  name text not null,
  next_seq bigint not null default 1,
  head_hash bytea not null default decode(repeat('00', 32), 'hex'),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index ledgers_key_idx on ledgers (key_id, created_at desc, id);

create table accounts (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  asset text not null references assets(code),
  name text not null,
  kind text not null check (kind in ('normal', 'world')),
  balance bigint not null default 0,
  held bigint not null default 0 check (held >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Defence in depth. The functions check this too; the constraint makes a bug loud instead of silent.
  check (kind = 'world' or balance - held >= 0)
);
create unique index accounts_world_idx on accounts (ledger_id, asset) where kind = 'world';
create index accounts_ledger_idx on accounts (ledger_id, created_at desc, id);

create table transfers (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  seq bigint not null default 0,
  memo text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index transfers_ledger_idx on transfers (ledger_id, created_at desc, id);

create table holds (
  id text primary key,
  ledger_id text not null references ledgers(id) on delete cascade,
  account_id text not null references accounts(id),
  asset text not null references assets(code),
  amount bigint not null check (amount > 0),
  remaining bigint not null check (remaining >= 0),
  status text not null check (status in ('open', 'captured', 'released', 'expired')),
  expires_at timestamptz not null,
  memo text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index holds_open_account_idx on holds (account_id) where status = 'open';
create index holds_open_expiry_idx on holds (expires_at) where status = 'open';
create index holds_ledger_idx on holds (ledger_id, created_at desc, id);

create table transfer_legs (
  transfer_id text not null references transfers(id) on delete cascade,
  position int not null,
  from_account text not null references accounts(id),
  from_hold text references holds(id),
  to_account text not null references accounts(id),
  asset text not null references assets(code),
  amount bigint not null check (amount > 0),
  primary key (transfer_id, position)
);
create index transfer_legs_from_idx on transfer_legs (from_account);
create index transfer_legs_to_idx on transfer_legs (to_account);

create table journal (
  ledger_id text not null references ledgers(id) on delete cascade,
  seq bigint not null,
  kind text not null,
  entity_id text not null,
  payload jsonb not null,
  prev_hash bytea not null,
  hash bytea not null,
  created_at timestamptz not null,
  primary key (ledger_id, seq)
);

create table events (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  ledger_id text not null references ledgers(id) on delete cascade,
  type text not null,
  entity_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index events_key_idx on events (key_id, created_at desc, id);
create index events_created_idx on events (created_at);
