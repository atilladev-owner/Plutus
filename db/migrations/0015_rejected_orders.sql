-- Task 5 review round 1, finding 1: spec 10.3 gives orders a status of "rejected" and a
-- reject_reason, so a rejected attempt is a real row after all, not only a market_events
-- and trader event pair the way 0013_place_order.sql's own header comment describes and
-- 0013's record_rejection implemented. That comment is now superseded by this file, left
-- unedited there rather than rewritten, since a migration already applied is not the place
-- to revise history; this note is the correction.
--
-- record_rejection is dropped and recreated with every field the caller sent, so the row it
-- inserts carries the same input a client_order_id retry would otherwise have to remember
-- itself: market, side, type, time_in_force, post_only, price, quantity, quote_amount,
-- filled_quantity and filled_quote at zero, hold_id and accepted_seq null (a rejection never
-- reaches the point of creating a hold or being accepted onto the book), status "rejected",
-- reject_reason the named reason.
--
-- A rejected row can still carry the caller's own client_order_id, so two things that used
-- to be one now have to be told apart: the partial unique index that used to mean "at most
-- one order per key per client_order_id, ever" now excludes rejected rows, and place_order's
-- own duplicate check (the exists query that raises duplicate_client_order_id) excludes them
-- the same way. Together these let a genuine retry of the same handle after a rejection
-- through to a fresh attempt, while still refusing a second attempt against a client_order_id
-- some live (non rejected) order already owns, exactly as before.
drop index orders_client_order_idx;
create unique index orders_client_order_idx on orders (key_id, client_order_id)
  where client_order_id is not null and status <> 'rejected';

-- Same signature, so this replaces 0013's place_order in place rather than overloading it.
-- The only change from 0013 is the duplicate check's exists query excluding status =
-- 'rejected', for the reason above; every other line is unchanged.
create or replace function place_order(
  p_key_id text, p_order_id text, p_market text, p_client_order_id text,
  p_side text, p_type text, p_tif text, p_post_only boolean,
  p_price bigint, p_quantity bigint, p_quote_amount bigint, p_now timestamptz
) returns jsonb language plpgsql as $$
declare
  v_market markets%rowtype;
  v_base_exp int;
  v_divisor bigint;
  v_reason text;
  v_notional bigint;
  v_would_take boolean;
  v_fillable bigint;
  v_hold_asset text;
  v_hold_amount bigint;
  v_hold_account text;
  v_hold_id text;
  v_fee_account text;
  v_accepted_seq bigint;
  v_event_ids text[] := '{}';
  v_trades jsonb := '[]'::jsonb;
  v_order orders%rowtype;
  v_opp_side text;
  v_market_buy boolean;
  v_remaining bigint;
  v_remaining_quote bigint;
  v_resting orders%rowtype;
  v_resting_after orders%rowtype;
  v_resting_remaining bigint;
  v_fill_qty bigint;
  v_fill_notional bigint;
  v_lo bigint;
  v_hi bigint;
  v_mid bigint;
  v_try_notional bigint;
  v_try_fee bigint;
  v_buyer_fee bigint;
  v_seller_fee bigint;
  v_buyer_key text;
  v_seller_key text;
  v_buyer_hold text;
  v_seller_hold text;
  v_buy_order_id text;
  v_sell_order_id text;
  v_buyer_account text;
  v_seller_account text;
  v_transfer_id text;
  v_transfer_result jsonb;
  v_trade_id text;
  v_trade trades%rowtype;
  v_seq bigint;
  v_final_status text;
begin
  perform lock_markets(array[p_market]);

  select * into v_market from markets where symbol = p_market;
  if not found then
    raise exception 'validation_failed' using detail = 'unknown market';
  end if;
  select exponent into v_base_exp from assets where code = v_market.base;
  v_divisor := ('1' || repeat('0', v_base_exp))::bigint;
  v_opp_side := case when p_side = 'buy' then 'sell' else 'buy' end;

  if p_side not in ('buy', 'sell') then
    raise exception 'validation_failed' using detail = 'side';
  end if;
  if p_type not in ('limit', 'market') then
    raise exception 'validation_failed' using detail = 'type';
  end if;
  if p_type = 'market' then
    if p_tif <> 'IOC' then
      raise exception 'validation_failed' using detail = 'market orders must be IOC';
    end if;
    if p_post_only then
      raise exception 'validation_failed' using detail = 'market orders cannot be post_only';
    end if;
    if p_side = 'buy' and (p_quote_amount is null or p_quote_amount <= 0) then
      raise exception 'validation_failed' using detail = 'market buy requires quote_amount';
    end if;
    if p_side = 'sell' and p_quantity is null then
      raise exception 'validation_failed' using detail = 'market sell requires quantity';
    end if;
  else
    if p_tif not in ('GTC', 'IOC', 'FOK') then
      raise exception 'validation_failed' using detail = 'time_in_force';
    end if;
    if p_price is null or p_quantity is null then
      raise exception 'validation_failed' using detail = 'limit orders require price and quantity';
    end if;
  end if;

  -- Review round 1, finding 1: excludes status = 'rejected' so a retry of a handle a
  -- rejection already used, with a byte identical or a different body, reaches this
  -- function fresh instead of being refused against its own failed predecessor.
  if v_reason is null and p_client_order_id is not null
      and exists (select 1 from orders where key_id = p_key_id and client_order_id = p_client_order_id and status <> 'rejected') then
    v_reason := 'duplicate_client_order_id';
  end if;
  if v_reason is null and v_market.status <> 'open' then
    v_reason := 'market_halted';
  end if;
  if v_reason is null and p_type = 'limit' and (p_price <= 0 or p_price % v_market.tick_size <> 0) then
    v_reason := 'price_not_tick';
  end if;
  if v_reason is null and (p_type = 'limit' or p_side = 'sell')
      and (p_quantity <= 0 or p_quantity % v_market.lot_size <> 0) then
    v_reason := 'quantity_not_lot';
  end if;
  if v_reason is null and p_type = 'limit' then
    v_notional := (p_price * p_quantity) / v_divisor;
    if v_notional < v_market.min_notional then
      v_reason := 'below_min_notional';
    end if;
  end if;
  if v_reason is null and p_type = 'market' and p_side = 'buy' and p_quote_amount < v_market.min_notional then
    v_reason := 'below_min_notional';
  end if;

  if v_reason is null then
    if exists (
      select 1 from orders where market = p_market and side = v_opp_side and status in ('open', 'partially_filled')
        and key_id = p_key_id
        and (p_type = 'market' or (case when p_side = 'buy' then price <= p_price else price >= p_price end))
    ) then
      v_reason := 'self_trade';
    end if;
  end if;

  if v_reason is null and p_type = 'limit' and (p_post_only or p_tif = 'FOK') then
    select exists (
      select 1 from orders where market = p_market and side = v_opp_side and status in ('open', 'partially_filled')
        and (case when p_side = 'buy' then price <= p_price else price >= p_price end)
    ) into v_would_take;
    if p_post_only and v_would_take then
      v_reason := 'post_only_would_take';
    elsif p_tif = 'FOK' then
      select coalesce(sum(quantity - filled_quantity), 0) into v_fillable
        from orders where market = p_market and side = v_opp_side and status in ('open', 'partially_filled')
          and (case when p_side = 'buy' then price <= p_price else price >= p_price end);
      if v_fillable < p_quantity then
        v_reason := 'fok_not_fillable';
      end if;
    end if;
  end if;

  if v_reason is not null then
    raise exception 'order_rejected' using detail = v_reason;
  end if;

  if p_type = 'limit' and p_side = 'buy' then
    v_hold_asset := v_market.quote;
    v_hold_amount := v_notional + exchange_fee(v_notional, v_market.taker_fee_bps);
  elsif p_type = 'limit' and p_side = 'sell' then
    v_hold_asset := v_market.base;
    v_hold_amount := p_quantity;
  elsif p_type = 'market' and p_side = 'buy' then
    v_hold_asset := v_market.quote;
    v_hold_amount := p_quote_amount;
  else
    v_hold_asset := v_market.base;
    v_hold_amount := p_quantity;
  end if;

  v_hold_account := ensure_exchange_account(p_key_id, v_hold_asset, p_now);
  v_hold_id := new_id('hold');
  begin
    perform create_hold('ldg_exchange', v_hold_id, v_hold_account, v_hold_amount, 'infinity'::timestamptz,
      'order margin', jsonb_build_object('order_id', p_order_id, 'market', p_market), p_now);
  exception when others then
    if sqlerrm = 'insufficient_funds' then
      raise exception 'order_rejected' using detail = 'insufficient_funds';
    else
      raise;
    end if;
  end;

  v_accepted_seq := append_market_event(p_market, 'order.accepted',
    jsonb_build_object('order_id', p_order_id, 'key_id', p_key_id, 'side', p_side, 'type', p_type), p_now);

  insert into orders (
    id, key_id, market, client_order_id, side, type, time_in_force, post_only,
    price, quantity, quote_amount, filled_quantity, filled_quote, status, hold_id,
    accepted_seq, reject_reason, created_at, updated_at
  ) values (
    p_order_id, p_key_id, p_market, p_client_order_id, p_side, p_type, p_tif, p_post_only,
    case when p_type = 'limit' then p_price else null end,
    case when p_type = 'market' and p_side = 'buy' then null else p_quantity end,
    case when p_type = 'market' and p_side = 'buy' then p_quote_amount else null end,
    0, 0, 'open', v_hold_id, v_accepted_seq, null, p_now, p_now
  ) returning * into v_order;

  v_event_ids := v_event_ids || emit_key_event(p_key_id, 'order.accepted', p_order_id, jsonb_build_object('order', order_to_jsonb(v_order)), p_now);

  v_market_buy := (p_type = 'market' and p_side = 'buy');
  v_remaining := p_quantity;
  v_remaining_quote := p_quote_amount;

  for v_resting in
    select * from orders
    where market = p_market and side = v_opp_side and status in ('open', 'partially_filled')
      and (p_type = 'market' or (case when p_side = 'buy' then price <= p_price else price >= p_price end))
    order by (case when p_side = 'buy' then price else -price end) asc, accepted_seq asc
    for update
  loop
    exit when (v_market_buy and v_remaining_quote <= 0) or (not v_market_buy and v_remaining <= 0);

    v_resting_remaining := v_resting.quantity - v_resting.filled_quantity;

    if v_market_buy then
      v_lo := 0;
      v_hi := v_resting_remaining / v_market.lot_size;
      while v_lo < v_hi loop
        v_mid := (v_lo + v_hi + 1) / 2;
        v_try_notional := (v_resting.price * (v_mid * v_market.lot_size)) / v_divisor;
        v_try_fee := exchange_fee(v_try_notional, v_market.taker_fee_bps);
        if v_try_notional + v_try_fee <= v_remaining_quote then
          v_lo := v_mid;
        else
          v_hi := v_mid - 1;
        end if;
      end loop;
      v_fill_qty := v_lo * v_market.lot_size;
      exit when v_fill_qty = 0;
    else
      v_fill_qty := least(v_remaining, v_resting_remaining);
    end if;

    v_fill_notional := (v_resting.price * v_fill_qty) / v_divisor;

    if p_side = 'buy' then
      v_buyer_key := p_key_id; v_seller_key := v_resting.key_id;
      v_buyer_hold := v_hold_id; v_seller_hold := v_resting.hold_id;
      v_buy_order_id := p_order_id; v_sell_order_id := v_resting.id;
      v_buyer_fee := exchange_fee(v_order.filled_quote + v_fill_notional, v_market.taker_fee_bps)
        - exchange_fee(v_order.filled_quote, v_market.taker_fee_bps);
      v_seller_fee := exchange_fee(v_resting.filled_quote + v_fill_notional, v_market.maker_fee_bps)
        - exchange_fee(v_resting.filled_quote, v_market.maker_fee_bps);
    else
      v_seller_key := p_key_id; v_buyer_key := v_resting.key_id;
      v_seller_hold := v_hold_id; v_buyer_hold := v_resting.hold_id;
      v_sell_order_id := p_order_id; v_buy_order_id := v_resting.id;
      v_seller_fee := exchange_fee(v_order.filled_quote + v_fill_notional, v_market.taker_fee_bps)
        - exchange_fee(v_order.filled_quote, v_market.taker_fee_bps);
      v_buyer_fee := exchange_fee(v_resting.filled_quote + v_fill_notional, v_market.maker_fee_bps)
        - exchange_fee(v_resting.filled_quote, v_market.maker_fee_bps);
    end if;

    v_buyer_account := ensure_exchange_account(v_buyer_key, v_market.base, p_now);
    v_seller_account := ensure_exchange_account(v_seller_key, v_market.quote, p_now);
    select id into v_fee_account from accounts
      where ledger_id = 'ldg_exchange' and kind = 'normal' and asset = v_market.quote and name = 'fee:' || v_market.quote;

    v_transfer_id := new_id('tr');
    v_transfer_result := post_transfer('ldg_exchange', v_transfer_id, jsonb_build_array(
        jsonb_build_object('from_hold', v_buyer_hold, 'to', v_seller_account, 'asset', v_market.quote, 'amount', (v_fill_notional - v_seller_fee)::text),
        jsonb_build_object('from_hold', v_buyer_hold, 'to', v_fee_account, 'asset', v_market.quote, 'amount', (v_seller_fee + v_buyer_fee)::text),
        jsonb_build_object('from_hold', v_seller_hold, 'to', v_buyer_account, 'asset', v_market.base, 'amount', v_fill_qty::text)
      ), 'exchange fill', jsonb_build_object('market', p_market, 'buy_order_id', v_buy_order_id, 'sell_order_id', v_sell_order_id), p_now);
    v_event_ids := v_event_ids || array(select jsonb_array_elements_text(v_transfer_result -> 'event_ids'));

    v_seq := append_market_event(p_market, 'order.filled', jsonb_build_object(
      'buy_order_id', v_buy_order_id, 'sell_order_id', v_sell_order_id, 'price', v_resting.price::text,
      'quantity', v_fill_qty::text, 'notional', v_fill_notional::text), p_now);

    v_trade_id := new_id('trade');
    insert into trades (id, market, seq, buy_order_id, sell_order_id, price, quantity, notional, buyer_fee, seller_fee, transfer_id, created_at)
      values (v_trade_id, p_market, v_seq, v_buy_order_id, v_sell_order_id, v_resting.price, v_fill_qty, v_fill_notional, v_buyer_fee, v_seller_fee, v_transfer_id, p_now)
      returning * into v_trade;
    v_trades := v_trades || trade_to_jsonb(v_trade);

    v_event_ids := v_event_ids || emit_key_event(v_buyer_key, 'order.filled', v_buy_order_id, jsonb_build_object('trade', trade_to_jsonb(v_trade), 'role', 'buy'), p_now);
    v_event_ids := v_event_ids || emit_key_event(v_seller_key, 'order.filled', v_sell_order_id, jsonb_build_object('trade', trade_to_jsonb(v_trade), 'role', 'sell'), p_now);

    update orders set
        filled_quantity = filled_quantity + v_fill_qty,
        filled_quote = filled_quote + v_fill_notional,
        status = case when filled_quantity + v_fill_qty = quantity then 'filled' else 'partially_filled' end,
        updated_at = p_now
      where id = v_resting.id
      returning * into v_resting_after;
    if v_resting_after.status = 'filled' then
      v_event_ids := v_event_ids || close_order_hold('ldg_exchange', v_resting_after.hold_id, p_now);
    end if;

    update orders set
        filled_quantity = filled_quantity + v_fill_qty,
        filled_quote = filled_quote + v_fill_notional,
        status = case
          when v_market_buy then 'partially_filled'
          when filled_quantity + v_fill_qty = quantity then 'filled'
          else 'partially_filled'
        end,
        updated_at = p_now
      where id = p_order_id
      returning * into v_order;

    if v_market_buy then
      v_remaining_quote := v_remaining_quote - (v_fill_notional + v_buyer_fee);
    else
      v_remaining := v_remaining - v_fill_qty;
    end if;
  end loop;

  if v_market_buy then
    v_final_status := case when v_order.filled_quantity > 0 then 'filled' else 'cancelled' end;
  elsif v_order.filled_quantity = p_quantity then
    v_final_status := 'filled';
  elsif p_tif = 'GTC' then
    v_final_status := v_order.status;
  else
    v_final_status := 'cancelled';
  end if;

  if v_final_status is distinct from v_order.status then
    update orders set status = v_final_status, updated_at = p_now where id = p_order_id returning * into v_order;
  end if;

  if v_final_status in ('filled', 'cancelled') then
    v_event_ids := v_event_ids || close_order_hold('ldg_exchange', v_order.hold_id, p_now);
  end if;

  if v_final_status = 'cancelled' then
    perform append_market_event(p_market, 'order.cancelled', jsonb_build_object('order_id', p_order_id, 'reason', 'ioc_remainder'), p_now);
    v_event_ids := v_event_ids || emit_key_event(p_key_id, 'order.cancelled', p_order_id, jsonb_build_object('order', order_to_jsonb(v_order), 'reason', 'ioc_remainder'), p_now);
  end if;

  return jsonb_build_object('order', order_to_jsonb(v_order), 'trades', v_trades, 'event_ids', to_jsonb(v_event_ids));
end $$;

-- Review round 1, finding 1: was record_rejection(p_key_id, p_order_id, p_market, p_reason,
-- p_now); the signature grows to carry every field the caller sent, so the row it inserts
-- below is complete. Dropped first: a different argument count and set of types would
-- otherwise create a second, overloaded function alongside the old one rather than replace
-- it, and src/db/exchange.ts's TypeScript wrapper only ever calls the new thirteen argument
-- form from here on.
drop function if exists record_rejection(text, text, text, text, timestamptz);

create or replace function record_rejection(
  p_key_id text, p_order_id text, p_market text, p_client_order_id text,
  p_side text, p_type text, p_tif text, p_post_only boolean,
  p_price bigint, p_quantity bigint, p_quote_amount bigint,
  p_reason text, p_now timestamptz
) returns jsonb language plpgsql as $$
declare
  v_order orders%rowtype;
  v_event_id text;
begin
  perform lock_markets(array[p_market]);
  perform append_market_event(p_market, 'order.rejected', jsonb_build_object('order_id', p_order_id, 'reason', p_reason), p_now);
  insert into orders (
    id, key_id, market, client_order_id, side, type, time_in_force, post_only,
    price, quantity, quote_amount, filled_quantity, filled_quote, status, hold_id,
    accepted_seq, reject_reason, created_at, updated_at
  ) values (
    p_order_id, p_key_id, p_market, p_client_order_id, p_side, p_type, p_tif, p_post_only,
    p_price, p_quantity, p_quote_amount, 0, 0, 'rejected', null, null, p_reason, p_now, p_now
  ) returning * into v_order;
  v_event_id := emit_key_event(p_key_id, 'order.rejected', p_order_id, jsonb_build_object('order', order_to_jsonb(v_order), 'reason', p_reason), p_now);
  return jsonb_build_object('order', order_to_jsonb(v_order), 'event_ids', jsonb_build_array(v_event_id));
end $$;
