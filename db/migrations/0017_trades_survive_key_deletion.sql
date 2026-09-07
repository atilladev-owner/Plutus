-- Whole branch review, finding 1 (critical): orders.key_id cascades from api_keys
-- (0011_exchange.sql), but trades.buy_order_id and sell_order_id only ever referenced
-- orders with no delete action. The sweep's deleteIdleSandbox (src/db/ledger.ts) deletes
-- an idle sandbox key outright, which cascades to every order that key ever placed; the
-- first idle key that was ever on either side of a trade turned that cascade into a plain
-- foreign key violation, and the throw ended the whole sweep before the purges, the
-- refresh and the top up that follow it ever ran.
--
-- Ruling: a trade outlives the orders that made it. buy_order_id and sell_order_id become
-- nullable, on delete set null, so deleting a trader's order (directly, or by cascade from
-- deleting their key) nulls only that trade's own reference to it, never the trade row
-- itself. The public tape (src/db/market-data.ts) never reads either column, so it is
-- unaffected either way; the counterparty's own trade history (listMyTrades,
-- src/db/exchange.ts) still needs to find the row by its own still live side, which is
-- the accompanying TypeScript change (inner joins to left joins) alongside this migration.
alter table trades alter column buy_order_id drop not null;
alter table trades alter column sell_order_id drop not null;
alter table trades drop constraint trades_buy_order_id_fkey;
alter table trades add constraint trades_buy_order_id_fkey foreign key (buy_order_id) references orders(id) on delete set null;
alter table trades drop constraint trades_sell_order_id_fkey;
alter table trades add constraint trades_sell_order_id_fkey foreign key (sell_order_id) references orders(id) on delete set null;

-- Whole branch review, finding 5 (minor): exchange_reset (0012_exchange_wallet.sql) relied
-- entirely on its caller, the reset route (src/routes/exchange-wallet.ts), to cancel every
-- open order first. Now that cancel_order exists (it did not yet when 0012 was written),
-- exchange_reset cancels every open or partially filled order of the key itself, through
-- cancel_order, right after taking every market's lock and before releasing anything or
-- rebalancing: a caller that reset without its own cancel loop would otherwise leave open
-- orders resting, with their holds never released and their balances never rebalanced back
-- to the faucet amounts, which used to be true only because the route happened to always
-- cancel first. The route is unchanged: it may keep or drop its own cancel loop, cancelling
-- an already cancelled order here is a no-op (cancel_order's own guard returns the order as
-- is rather than erroring), so calling both costs nothing beyond the one redundant lookup.
create or replace function exchange_reset(p_key_id text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_order_id text;
  v_hold_id text;
  v_acct record;
  v_target bigint;
  v_diff bigint;
  v_legs jsonb := '[]'::jsonb;
  v_event_ids jsonb := '[]'::jsonb;
  r jsonb;
begin
  perform lock_markets(array(select symbol from markets));

  for v_order_id in
    select id from orders where key_id = p_key_id and status in ('open', 'partially_filled')
    order by created_at, id
  loop
    r := cancel_order(p_key_id, v_order_id, p_now);
    v_event_ids := v_event_ids || (r -> 'event_ids');
  end loop;

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
