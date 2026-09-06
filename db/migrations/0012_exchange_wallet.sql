-- Exchange wallets: the faucet, the sandbox reset, and the lookup a balance read and both
-- of those need. A trader's accounts in ldg_exchange are named after the trader's key id
-- (spec 10.2), one account per asset, found by (ledger_id, name, asset). This index backs
-- that lookup; accounts_ledger_idx already exists but is ordered by created_at, not name.
create index accounts_ledger_name_idx on accounts (ledger_id, name);

-- Fixed lock order everywhere (spec 10.4 step 7): market advisory locks in symbol order,
-- then the ledger row, then accounts in ascending id order. post_transfer, create_hold and
-- release_hold already take the ledger row and then account locks; this is the market half
-- of that order, taken first and always in the same sorted sequence regardless of how many
-- symbols are passed in, whether that is the one market an order touches or every market a
-- reset touches. Task 5's place_order calls this with its own single market; exchange_reset
-- below calls it with every market there is, so the order in which a market lock is ever
-- taken never depends on which caller took it.
create or replace function lock_markets(p_symbols text[]) returns void
language plpgsql as $$
declare
  v_symbol text;
begin
  for v_symbol in select distinct s from unnest(p_symbols) as s order by s loop
    perform pg_advisory_xact_lock(hashtext(v_symbol));
  end loop;
end $$;

-- Finds the trader's account for one asset in ldg_exchange, creating it the first time,
-- named after the key the same way resolve_account names a world account after its asset.
create or replace function ensure_exchange_account(p_key_id text, p_asset text, p_now timestamptz)
returns text language plpgsql as $$
declare
  v_id text;
begin
  select id into v_id from accounts where ledger_id = 'ldg_exchange' and name = p_key_id and asset = p_asset and kind = 'normal';
  if v_id is null then
    v_id := new_id('acct');
    insert into accounts (id, ledger_id, asset, name, kind, created_at) values (v_id, 'ldg_exchange', p_asset, p_key_id, 'normal', p_now);
  end if;
  return v_id;
end $$;

-- Funds the caller from the world with 100,000 USDT, 1 BTC and 10 ETH (spec 10.2), once
-- per 24 hours per key. The faucets row for the key is seeded at the epoch on first use and
-- locked with "for update" before the cooldown is checked, so two concurrent calls for the
-- same key serialise on that row instead of both reading a cooldown that has not been
-- written yet: the second call blocks until the first commits, then sees the fresh last_at.
-- An epoch last_at always reads as long expired, so a first ever call never needs a special
-- case to skip the cooldown check.
create or replace function exchange_faucet(p_key_id text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_last timestamptz;
  v_acct_usdt text;
  v_acct_btc text;
  v_acct_eth text;
  v_legs jsonb;
  r jsonb;
begin
  insert into faucets (key_id, last_at) values (p_key_id, 'epoch'::timestamptz) on conflict (key_id) do nothing;
  select last_at into v_last from faucets where key_id = p_key_id for update;

  if p_now < v_last + interval '24 hours' then
    raise exception 'faucet_cooldown' using detail = ceil(extract(epoch from (v_last + interval '24 hours' - p_now)))::bigint::text;
  end if;

  update faucets set last_at = p_now where key_id = p_key_id;

  v_acct_usdt := ensure_exchange_account(p_key_id, 'USDT', p_now);
  v_acct_btc := ensure_exchange_account(p_key_id, 'BTC', p_now);
  v_acct_eth := ensure_exchange_account(p_key_id, 'ETH', p_now);

  v_legs := jsonb_build_array(
    jsonb_build_object('from', 'world:USDT', 'to', v_acct_usdt, 'asset', 'USDT', 'amount', '100000000000'),
    jsonb_build_object('from', 'world:BTC', 'to', v_acct_btc, 'asset', 'BTC', 'amount', '100000000'),
    jsonb_build_object('from', 'world:ETH', 'to', v_acct_eth, 'asset', 'ETH', 'amount', '1000000000'));
  r := post_transfer('ldg_exchange', new_id('tr'), v_legs, 'exchange faucet', '{}'::jsonb, p_now);

  return jsonb_build_object('event_ids', r -> 'event_ids');
end $$;

-- Cancelling every open order is Task 5's cancel_order, which does not exist yet; until
-- then this releases every hold the key owns in ldg_exchange and moves each asset balance
-- back to its faucet amount through a transfer to or from the world, so verify still finds
-- the ledger balanced. Every market is locked first, in symbol order, even though reset
-- itself never matches an order, so the lock order this function takes is exactly the one
-- Task 5's cancel path will also take and neither can ever deadlock against the other.
create or replace function exchange_reset(p_key_id text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_hold_id text;
  v_acct record;
  v_target bigint;
  v_diff bigint;
  v_legs jsonb := '[]'::jsonb;
  v_event_ids jsonb := '[]'::jsonb;
  r jsonb;
begin
  perform lock_markets(array(select symbol from markets));

  for v_hold_id in
    select h.id from holds h join accounts a on a.id = h.account_id
    where a.ledger_id = 'ldg_exchange' and a.name = p_key_id and h.status = 'open'
    order by h.created_at, h.id
  loop
    r := release_hold('ldg_exchange', v_hold_id, 'hold.released', p_now);
    v_event_ids := v_event_ids || (r -> 'event_ids');
  end loop;

  for v_acct in
    select id, asset, balance from accounts
    where ledger_id = 'ldg_exchange' and name = p_key_id and kind = 'normal'
    order by asset
  loop
    v_target := case v_acct.asset
      when 'USDT' then 100000000000::bigint
      when 'BTC' then 100000000::bigint
      when 'ETH' then 1000000000::bigint
      else null
    end;
    if v_target is null then
      continue;
    end if;
    v_diff := v_target - v_acct.balance;
    if v_diff > 0 then
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('from', 'world:' || v_acct.asset, 'to', v_acct.id, 'asset', v_acct.asset, 'amount', v_diff::text));
    elsif v_diff < 0 then
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('from', v_acct.id, 'to', 'world:' || v_acct.asset, 'asset', v_acct.asset, 'amount', (-v_diff)::text));
    end if;
  end loop;

  if jsonb_array_length(v_legs) > 0 then
    r := post_transfer('ldg_exchange', new_id('tr'), v_legs, 'exchange reset', '{}'::jsonb, p_now);
    v_event_ids := v_event_ids || (r -> 'event_ids');
  end if;

  return jsonb_build_object('event_ids', v_event_ids);
end $$;
