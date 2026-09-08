-- Security sweep, finding 1, second look: the daily purge of the house's own old quotes
-- (purgeHouseOrders in src/db/exchange.ts) keeps any order a trade names, and the set null
-- action 0017_trades_survive_key_deletion.sql put on both trade sides runs on every order
-- delete. Both look trades up by order id, and neither column had an index, so each was a
-- scan of the whole trades table per order. Two plain indexes, one per side.
create index if not exists trades_buy_order_idx on trades (buy_order_id);
create index if not exists trades_sell_order_idx on trades (sell_order_id);
