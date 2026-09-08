-- Security sweep, finding 2 (important): POST /v1/exchange/reset
-- (src/routes/exchange-wallet.ts) locks every market, cancels every open order the caller
-- owns and rebalances every one of its accounts, on every call, with nothing but the
-- standard signed budget in front of it: 5 weight out of 1,200 a minute, so one key could
-- run that whole sequence 240 times a minute. The faucet already carries a per key cooldown
-- (0012_exchange_wallet.sql), and this is the same thing at 60 seconds.
--
-- A table of its own rather than a last_reset_at column on api_keys, for two reasons.
-- api_keys is on the authentication path: every request reads it and touch_key writes to it
-- (src/db/keys.ts), so a reset holding that row under "for update" for the length of its own
-- cancel loop would sit in front of unrelated requests for the same key. And faucets already
-- set the shape for a one row per key cooldown, so the two read identically rather than each
-- being stored its own way. The row cascades away with the key, exactly as faucets does.
create table resets (
  key_id text primary key references api_keys(id) on delete cascade,
  last_at timestamptz not null
);

-- The cooldown check, built the same way exchange_faucet's own is: the row is seeded at the
-- epoch on first use and locked with "for update" before last_at is read, so two concurrent
-- resets for one key serialise on that row instead of both reading a last_at neither has
-- written yet. An epoch last_at always reads as long expired, so a first ever reset needs no
-- special case. Raised as reset_cooldown with the whole seconds remaining in the detail,
-- exactly as faucet_cooldown does, which is what lets src/db/errors.ts map both through one
-- branch into a 429 with a Retry-After header.
--
-- Deliberately not folded into exchange_reset itself. The route cancels every open order
-- through cancel_order before calling exchange_reset, so a cooldown raised in there would
-- only fire after that work had already been done and then rolled back; and exchange_reset
-- takes every market's lock as its own first statement, so the two would take the market
-- locks and this row in one order through the route and the opposite order through a direct
-- call. Called first, before any lock, this is the one order every caller takes.
create or replace function exchange_reset_cooldown(p_key_id text, p_now timestamptz)
returns void language plpgsql as $$
declare
  v_last timestamptz;
begin
  insert into resets (key_id, last_at) values (p_key_id, 'epoch'::timestamptz) on conflict (key_id) do nothing;
  select last_at into v_last from resets where key_id = p_key_id for update;

  if p_now < v_last + interval '60 seconds' then
    raise exception 'reset_cooldown' using detail = ceil(extract(epoch from (v_last + interval '60 seconds' - p_now)))::bigint::text;
  end if;

  update resets set last_at = p_now where key_id = p_key_id;
end $$;
