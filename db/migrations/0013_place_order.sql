-- The matching function. One plpgsql function validates an order, reserves margin as a
-- ledger hold, walks the opposite side of the book in price time priority, and settles
-- every fill as one ledger transfer with three legs, per spec 10.4.
--
-- Rejections are surfaced by raising order_rejected with detail set to the reason, rather
-- than by returning a rejection object. That choice means a rejection's own writes (the
-- market_events row and the trader facing event) cannot live inside the same transaction
-- as the raise, because raising rolls back everything place_order did, including those
-- writes. record_rejection below is the second function the TypeScript wrapper calls, in
-- its own transaction, after catching the raised error and letting the first transaction
-- roll back. See src/db/exchange.ts for the two step call.
--
-- A rejected attempt never gets a row in orders. The table keeps a status of 'rejected'
-- and a reject_reason column for a different consumer, but persisting a rejected attempt
-- here would let a retried client_order_id collide with its own failed predecessor, which
-- defeats the idempotency the column exists for. What actually happened is fully visible
-- through market_events and the trader's own event stream instead.

-- Task 3 review minor: a trader's account per asset in ldg_exchange is unique by
-- (ledger_id, name, asset), enforced here rather than only by application discipline.
create unique index accounts_exchange_idx on accounts (ledger_id, name, asset) where kind = 'normal' and ledger_id = 'ldg_exchange';

-- ceil(notional * bps / 10000) in pure integer arithmetic, spec 10.1.
create or replace function exchange_fee(p_notional bigint, p_bps int) returns bigint
language sql immutable as $$
  select (p_notional * p_bps + 9999) / 10000
$$;

-- The gapless per market sequence backing market_events, spec 10.4 step 6. Callers always
-- hold the market's advisory lock (lock_markets) for the whole of place_order or
-- cancel_order, so this plain update never contends with a concurrent writer on the same
-- market; the row lock the update itself takes is a formality, not the real defence.
create or replace function next_market_seq(p_market text) returns bigint
language plpgsql as $$
declare
  v_seq bigint;
begin
  update markets set next_seq = next_seq + 1 where symbol = p_market returning next_seq - 1 into v_seq;
  if v_seq is null then
    raise exception 'validation_failed' using detail = 'unknown market';
  end if;
  return v_seq;
end $$;

create or replace function append_market_event(p_market text, p_type text, p_payload jsonb, p_now timestamptz)
returns bigint language plpgsql as $$
declare
  v_seq bigint;
begin
  v_seq := next_market_seq(p_market);
  insert into market_events (market, seq, type, payload, created_at) values (p_market, v_seq, p_type, p_payload, p_now);
  return v_seq;
end $$;

-- Every bigint column is cast to text before it enters jsonb, matching the convention in
-- post_transfer and create_hold: jsonb numbers are IEEE doubles once a client parses them,
-- and an amount is never allowed to pass through that.
create or replace function order_to_jsonb(o orders) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', o.id, 'key_id', o.key_id, 'market', o.market, 'client_order_id', o.client_order_id,
    'side', o.side, 'type', o.type, 'time_in_force', o.time_in_force, 'post_only', o.post_only,
    'price', o.price::text, 'quantity', o.quantity::text, 'quote_amount', o.quote_amount::text,
    'filled_quantity', o.filled_quantity::text, 'filled_quote', o.filled_quote::text,
    'status', o.status, 'hold_id', o.hold_id, 'accepted_seq', o.accepted_seq::text,
    'reject_reason', o.reject_reason, 'created_at', fmt_ts(o.created_at), 'updated_at', fmt_ts(o.updated_at))
$$;

create or replace function trade_to_jsonb(t trades) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', t.id, 'market', t.market, 'seq', t.seq::text, 'buy_order_id', t.buy_order_id, 'sell_order_id', t.sell_order_id,
    'price', t.price::text, 'quantity', t.quantity::text, 'notional', t.notional::text,
    'buyer_fee', t.buyer_fee::text, 'seller_fee', t.seller_fee::text, 'transfer_id', t.transfer_id,
    'created_at', fmt_ts(t.created_at))
$$;

-- The events table (0004_ledger.sql) is the flat, per key stream src/db/events.ts reads
-- and src/platform/fanout.ts fans out to webhooks by key_id. append_journal also writes
-- there, but always under the ledger's own key_id, which for ldg_exchange is key_house,
-- never the trader who placed the order. Order lifecycle rows need the trader's own
-- key_id instead, so they are written directly here rather than through append_journal,
-- and never touch the hash chained journal table: they carry no balance effect for
-- verify_chain to replay, only a notification a trader's webhook can subscribe to.
create or replace function emit_key_event(p_key_id text, p_type text, p_entity_id text, p_payload jsonb, p_now timestamptz)
returns text language plpgsql as $$
declare
  v_id text := new_id('evt');
begin
  insert into events (id, key_id, ledger_id, type, entity_id, payload, created_at)
    values (v_id, p_key_id, 'ldg_exchange', p_type, p_entity_id, p_payload, p_now);
  return v_id;
end $$;

-- Closes out whatever remains on an order's hold once the order leaves the book, whether
-- filled, cancelled, or a rejected FOK/post_only walk that never got this far. A fill that
-- draws a hold's remaining down to exactly zero already closes it as captured inside
-- post_transfer; this only ever has real work to do when a hold reserved more than it ended
-- up paying, most commonly a taker limit buy that filled at a resting price better than its
-- own limit, or an IOC/market order whose remainder never matched. Which primitive closes it
-- depends on whether anything was ever drawn: a hold with remaining below its original
-- amount already paid for something real, so it closes as captured (capture_close_hold,
-- 0008_capture_close_hold.sql), honestly reflecting that in both its terminal status and the
-- journal kind; a hold nothing was ever drawn from (remaining still equals amount) closes as
-- released, since nothing was ever captured against it. No-op, returning no event ids, when
-- the hold already closed itself.
create or replace function close_order_hold(p_ledger_id text, p_hold_id text, p_now timestamptz) returns text[]
language plpgsql as $$
declare
  v_hold holds%rowtype;
  r jsonb;
begin
  select * into v_hold from holds where id = p_hold_id and ledger_id = p_ledger_id;
  if v_hold.status is distinct from 'open' then
    return '{}';
  end if;
  if v_hold.remaining < v_hold.amount then
    r := capture_close_hold(p_ledger_id, p_hold_id, p_now);
  else
    r := release_hold(p_ledger_id, p_hold_id, 'hold.released', p_now);
  end if;
  return array(select jsonb_array_elements_text(r -> 'event_ids'));
end $$;

-- place_order(...). Spec 10.4 steps, in order: lock the market; (step 2, the house ladder
-- refresh, is spec 10.5 and belongs to a later task; nothing here depends on it); validate
-- and create the margin hold; walk the opposite side in price time priority; apply the
-- post_only, FOK, IOC and GTC rules around that walk; write market_events and per key
-- events for every accept, fill and cancel.
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

  -- Structural completeness. None of these are among the nine order_rejected reasons:
  -- they describe a malformed request, which the caller is expected to prevent before it
  -- ever reaches this function.
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

  -- The nine order_rejected reasons, spec 10.3, checked in the order that lets each test
  -- scenario isolate exactly one of them: duplicate handle, market state, the order's own
  -- shape against the market's tick, lot and floor, then whether it could even trade.
  if v_reason is null and p_client_order_id is not null
      and exists (select 1 from orders where key_id = p_key_id and client_order_id = p_client_order_id) then
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
  -- A market sell has no price yet, so no notional can be derived before the walk; it is
  -- exempt from this check rather than guessed at. A market buy's quote_amount already is
  -- a quote minor unit figure, so it is compared directly.
  if v_reason is null and p_type = 'market' and p_side = 'buy' and p_quote_amount < v_market.min_notional then
    v_reason := 'below_min_notional';
  end if;

  -- self_trade: a resting order is always someone's own liquidity, and a key is never
  -- allowed to take its own. Checked the same way as post_only, an existence query over the
  -- crossable resting orders restricted to this key, and unconditionally (unlike post_only
  -- and FOK below, this applies to every order type and every time in force, including a
  -- market order and a plain GTC limit order that would otherwise just cross and fill):
  -- without it, the walk would build a post_transfer leg moving money from an account to
  -- itself, which post_transfer already refuses outright as validation_failed, a confusing
  -- answer for what is really this order's own problem, not a ledger one.
  if v_reason is null then
    if exists (
      select 1 from orders where market = p_market and side = v_opp_side and status in ('open', 'partially_filled')
        and key_id = p_key_id
        and (p_type = 'market' or (case when p_side = 'buy' then price <= p_price else price >= p_price end))
    ) then
      v_reason := 'self_trade';
    end if;
  end if;

  -- post_only and FOK only ever apply to limit orders (market orders are always IOC,
  -- validated above). Both are answered by aggregates over the crossable resting orders,
  -- not by a literal walk: price time order decides who gets matched, never whether the
  -- requested amount can be matched at all.
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

  -- Margin, spec 10.3: a limit buy holds notional plus fee at its own price, computed at
  -- the taker rate because that is the worst case fee this order can ever be charged; if
  -- it rests and later fills as a maker at the (never higher) maker rate, or at a better
  -- price than its own limit, whatever the hold did not need is released when the order
  -- leaves the book. A limit sell holds the quantity being sold; a market buy holds the
  -- quote it is prepared to spend; a market sell holds the quantity being sold. Neither
  -- sell side hold carries a fee premium, because every fee in a fill is paid out of the
  -- buyer's hold, never the seller's.
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

  -- The walk, spec 10.4 step 4. accepted_seq, not created_at, is the tie breaker: it is a
  -- gapless per market sequence assigned under this same market's exclusive advisory lock,
  -- so it can never tie between two orders the way a caller supplied or even server
  -- assigned timestamp could if two orders happen to share one. v_opp_side was already set
  -- above, before the self_trade and post_only/FOK checks, and is unchanged since.
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
      -- The largest multiple of the lot size whose notional plus buyer fee fits the
      -- remaining quote, found by binary search: notional per lot is exact and constant
      -- at this resting price (the tick times lot invariant, enforced by
      -- enforce_market_tick_lot, guarantees it), so total cost is strictly increasing in
      -- the lot count and a single monotone search finds the boundary.
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

    -- The incoming order is always the taker in this walk; whichever resting order it
    -- matches is always the maker. That holds for every fill in every call, regardless of
    -- which side is buying, because the resting orders here were always accepted onto the
    -- book by an earlier, separate call.
    --
    -- Each side's fee is the increment of the ceiling on that order's own cumulative filled
    -- notional, not ceil applied to this one fill's notional in isolation: fee_i =
    -- ceil((filled_quote_before + notional_i) * bps / 10000) - ceil(filled_quote_before *
    -- bps / 10000). Summed over every fill an order ever receives, this telescopes to
    -- exactly ceil(total_filled_notional * bps / 10000): the single ceiling a fully filled
    -- order's hold reserved, never one cent more, regardless of how many separate fills, at
    -- how many different price levels, or across how many separate place_order calls, added
    -- up to it. Charging ceil(notional_i * bps / 10000) on each fill instead, the simpler
    -- and wrong way, can round up on every single fill and sum to more than the hold holds,
    -- failing the last fill of an otherwise fully fillable order with a spurious
    -- insufficient_funds. v_order.filled_quote is this call's incoming order's own running
    -- total as of before this fill; v_resting.filled_quote is the resting order's own total
    -- as of when the walk read it, correct whether this is that resting order's first fill
    -- ever or its fifth, across however many earlier, separate calls.
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

  -- Final status, spec 10.4 step 5: a market order, filled or not at all, never rests, so
  -- any execution at all is a completed market order and none is a cancelled one. A
  -- quantity bound order (every limit order, and a market sell) is filled once it reaches
  -- its full quantity; short of that, GTC rests with whatever remains open, and IOC or FOK
  -- cancels the remainder and releases whatever the hold has left. FOK cannot reach this
  -- branch short of full, because it was rejected before the walk if it could not be.
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

-- Called by the TypeScript wrapper in its own, fresh transaction, after place_order raised
-- order_rejected and the transaction that ran it rolled back. Writes exactly the two rows
-- spec 10.4 step 6 promises for a rejection: one market_events row and one event for the
-- trading key, so the caller sees the reason and the record of it exists, without any of
-- place_order's own attempted writes surviving the rollback that produced the reason.
create or replace function record_rejection(p_key_id text, p_order_id text, p_market text, p_reason text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_event_id text;
begin
  perform lock_markets(array[p_market]);
  perform append_market_event(p_market, 'order.rejected', jsonb_build_object('order_id', p_order_id, 'reason', p_reason), p_now);
  v_event_id := emit_key_event(p_key_id, 'order.rejected', p_order_id, jsonb_build_object('order_id', p_order_id, 'market', p_market, 'reason', p_reason), p_now);
  return jsonb_build_object('event_ids', jsonb_build_array(v_event_id));
end $$;

-- cancel_order(...). The order's market is read once, unlocked, before the market lock is
-- taken: the market a given order belongs to never changes, so there is nothing that read
-- could race against. Every actual decision after that reads the order fresh, with a row
-- lock, once the lock on its market is held.
create or replace function cancel_order(p_key_id text, p_order_id text, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  v_market text;
  v_order orders%rowtype;
  v_event_ids text[] := '{}';
begin
  select market into v_market from orders where id = p_order_id and key_id = p_key_id;
  if v_market is null then
    raise exception 'order_not_found' using detail = p_order_id;
  end if;

  perform lock_markets(array[v_market]);

  select * into v_order from orders where id = p_order_id and key_id = p_key_id for update;
  if not found then
    raise exception 'order_not_found' using detail = p_order_id;
  end if;

  if v_order.status = 'cancelled' then
    return jsonb_build_object('order', order_to_jsonb(v_order), 'event_ids', jsonb_build_array());
  end if;
  if v_order.status not in ('open', 'partially_filled') then
    raise exception 'order_not_open' using detail = v_order.status;
  end if;

  v_event_ids := v_event_ids || close_order_hold('ldg_exchange', v_order.hold_id, p_now);

  update orders set status = 'cancelled', updated_at = p_now where id = p_order_id returning * into v_order;

  perform append_market_event(v_market, 'order.cancelled', jsonb_build_object('order_id', p_order_id, 'reason', 'requested'), p_now);
  v_event_ids := v_event_ids || emit_key_event(p_key_id, 'order.cancelled', p_order_id, jsonb_build_object('order', order_to_jsonb(v_order), 'reason', 'requested'), p_now);

  return jsonb_build_object('order', order_to_jsonb(v_order), 'event_ids', to_jsonb(v_event_ids));
end $$;
