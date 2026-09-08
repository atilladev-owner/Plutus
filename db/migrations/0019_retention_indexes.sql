-- Every index the daily retention purges need, in the two directions they read.
--
-- First, by order id. The purge of the house's own old quotes (purgeHouseOrders in
-- src/db/exchange.ts) keeps any order a trade names, and the set null action
-- 0017_trades_survive_key_deletion.sql put on both trade sides runs on every order delete.
-- Both look trades up by order id, and neither column had an index, so each was a scan of
-- the whole trades table per order. Two plain indexes, one per side.
create index if not exists trades_buy_order_idx on trades (buy_order_id);
create index if not exists trades_sell_order_idx on trades (sell_order_id);

-- Second, by the purges' own predicates. Review round 1, finding 1: each of the three
-- retention purges filtered and then ordered a whole table with nothing to walk, so the
-- planner had to scan every row and sort the matches before the 5000 row cap could bite,
-- which also meant the trades check above ran against every candidate rather than against
-- the batch actually being deleted. The two purges this repo already had are each backed by
-- exactly this kind of index (events_created_idx in 0004_ledger.sql, idempotency_expires_idx
-- in 0007_idempotency.sql); these are the three that were missing.
--
-- The orders one is partial on the purge's own predicate rather than a plain index on
-- updated_at, so it holds only the house's own terminal quotes, a small fraction of the
-- table, and the ordered scan reads candidates and nothing else. Neither existing index on
-- orders could serve it: orders_client_order_idx covers only rows with a client_order_id,
-- which a house quote never has, and orders_book_idx is restricted to the open and partially
-- filled rows this purge is defined to exclude.
create index if not exists orders_house_retention_idx on orders (updated_at)
  where key_id = 'key_house' and status in ('filled', 'cancelled', 'rejected');
create index if not exists market_events_created_idx on market_events (created_at);
create index if not exists api_key_old_secrets_expires_idx on api_key_old_secrets (expires_at);

-- Review round 1, finding 3: the purge of inert exchange holds (purgeInertExchangeHolds in
-- src/db/exchange.ts) reads holds by its own predicate and then checks that no order and no
-- transfer leg names each candidate. holds_ledger_idx orders by created_at, not by the
-- closed_at this purge bounds and sorts on, so a partial index on the predicate itself is
-- what keeps that read to candidates only. The other two are the columns the checks look up:
-- neither had an index, and transfer_legs.from_hold also carries the on delete cascade
-- 0010_cascade_legs.sql put there, which without an index scans the whole leg table for every
-- hold deleted, exactly the cost the two trade side indexes above exist to avoid.
create index if not exists holds_exchange_released_idx on holds (closed_at)
  where ledger_id = 'ldg_exchange' and status = 'released';
create index if not exists orders_hold_idx on orders (hold_id);
create index if not exists transfer_legs_from_hold_idx on transfer_legs (from_hold);
