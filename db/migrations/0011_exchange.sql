-- Markets: the two tradable books, BTC-USDT and ETH-USDT. A price is quote minor units
-- per one whole unit of base. tick_size times lot_size must be a multiple of ten to the
-- power of the base asset's exponent, so notional is always an exact integer and matching
-- never rounds. A plain check constraint cannot read another table, so the invariant is
-- enforced by a trigger against assets.exponent instead of a table level check.
create table markets (
  symbol text primary key,
  base text not null references assets(code),
  quote text not null references assets(code),
  tick_size bigint not null check (tick_size > 0),
  lot_size bigint not null check (lot_size > 0),
  min_notional bigint not null check (min_notional > 0),
  maker_fee_bps int not null check (maker_fee_bps >= 0),
  taker_fee_bps int not null check (taker_fee_bps >= 0),
  status text not null check (status in ('open', 'halted')),
  house_quoted_at timestamptz,
  reference_price bigint,
  next_seq bigint not null default 1
);

create or replace function enforce_market_tick_lot() returns trigger
language plpgsql as $$
declare
  v_exponent int;
  v_divisor bigint;
begin
  select exponent into v_exponent from assets where code = new.base;
  if v_exponent is null then
    raise exception 'validation_failed' using detail = 'unknown base asset';
  end if;
  v_divisor := ('1' || repeat('0', v_exponent))::bigint;
  if (new.tick_size * new.lot_size) % v_divisor <> 0 then
    raise exception 'validation_failed' using detail = 'tick_size times lot_size must be a multiple of ten to the base exponent';
  end if;
  return new;
end $$;

create trigger markets_tick_lot_trigger before insert or update on markets
  for each row execute function enforce_market_tick_lot();

insert into markets (symbol, base, quote, tick_size, lot_size, min_notional, maker_fee_bps, taker_fee_bps, status, next_seq) values
  ('BTC-USDT', 'BTC', 'USDT', 10000, 100000, 5000000, 10, 10, 'open', 1),
  ('ETH-USDT', 'ETH', 'USDT', 10000, 1000000, 5000000, 10, 10, 'open', 1);

create table orders (
  id text primary key,
  key_id text not null references api_keys(id) on delete cascade,
  market text not null references markets(symbol),
  client_order_id text,
  side text not null check (side in ('buy', 'sell')),
  type text not null check (type in ('limit', 'market')),
  time_in_force text not null check (time_in_force in ('GTC', 'IOC', 'FOK')),
  post_only boolean not null default false,
  price bigint,
  quantity bigint,
  quote_amount bigint,
  filled_quantity bigint not null default 0,
  filled_quote bigint not null default 0,
  status text not null check (status in ('open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  hold_id text references holds(id),
  accepted_seq bigint,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index orders_client_order_idx on orders (key_id, client_order_id) where client_order_id is not null;
-- The book walk reads open and partially filled orders for a market and side in price
-- time priority.
create index orders_book_idx on orders (market, side, price, created_at) where status in ('open', 'partially_filled');

create table trades (
  id text primary key,
  market text not null references markets(symbol),
  seq bigint not null,
  buy_order_id text not null references orders(id),
  sell_order_id text not null references orders(id),
  price bigint not null,
  quantity bigint not null,
  notional bigint not null,
  buyer_fee bigint not null,
  seller_fee bigint not null,
  transfer_id text not null references transfers(id),
  created_at timestamptz not null default now()
);

create table market_events (
  market text not null references markets(symbol),
  seq bigint not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (market, seq)
);

create table faucets (
  key_id text primary key references api_keys(id) on delete cascade,
  last_at timestamptz not null
);

-- The house: a live mode key that never signs a request, so the ledger and sandbox
-- sweep exemptions in ledger_is_sandbox and deleteIdleSandbox apply to it automatically
-- by key mode, with nothing extra to carve out here. Its secret hash is a random value
-- nobody holds.
insert into api_keys (id, secret_hash, prefix, last4, mode, scopes) values (
  'key_house',
  sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')),
  'pl_live',
  right(md5(random()::text), 4),
  'live',
  '{}'
);

insert into ledgers (id, key_id, name) values ('ldg_exchange', 'key_house', 'Exchange house ledger');

-- World accounts, one per traded asset, created explicitly here with the same name and
-- kind resolve_account itself would give them, so post_transfer below finds them rather
-- than creating a second one.
insert into accounts (id, ledger_id, asset, name, kind, created_at)
select new_id('acct'), 'ldg_exchange', a.code, 'world', 'world', now()
from (values ('BTC'), ('ETH'), ('USDT')) as a(code);

-- House inventory, one normal account per traded asset, plus the fee account that
-- collects both sides of every trade in the quote asset.
insert into accounts (id, ledger_id, asset, name, kind, created_at) values
  (new_id('acct'), 'ldg_exchange', 'BTC', 'BTC', 'normal', now()),
  (new_id('acct'), 'ldg_exchange', 'ETH', 'ETH', 'normal', now()),
  (new_id('acct'), 'ldg_exchange', 'USDT', 'USDT', 'normal', now()),
  (new_id('acct'), 'ldg_exchange', 'USDT', 'fee:USDT', 'normal', now());

-- Fund the house from the world through post_transfer, one call per asset, so the
-- journal and the hash chain record the seed exactly like any other transfer would.
-- 10,000 BTC, 100,000 ETH and 1,000,000,000 USDT in minor units.
select post_transfer('ldg_exchange', new_id('tr'),
  jsonb_build_array(jsonb_build_object(
    'from', 'world:BTC',
    'to', (select id from accounts where ledger_id = 'ldg_exchange' and asset = 'BTC' and kind = 'normal' and name = 'BTC'),
    'asset', 'BTC', 'amount', '1000000000000')),
  'house seed funding', '{}'::jsonb, now());

select post_transfer('ldg_exchange', new_id('tr'),
  jsonb_build_array(jsonb_build_object(
    'from', 'world:ETH',
    'to', (select id from accounts where ledger_id = 'ldg_exchange' and asset = 'ETH' and kind = 'normal' and name = 'ETH'),
    'asset', 'ETH', 'amount', '10000000000000')),
  'house seed funding', '{}'::jsonb, now());

select post_transfer('ldg_exchange', new_id('tr'),
  jsonb_build_array(jsonb_build_object(
    'from', 'world:USDT',
    'to', (select id from accounts where ledger_id = 'ldg_exchange' and asset = 'USDT' and kind = 'normal' and name = 'USDT'),
    'asset', 'USDT', 'amount', '1000000000000000')),
  'house seed funding', '{}'::jsonb, now());
