create or replace function ledger_is_sandbox(p_ledger_id text) returns boolean
language sql stable as $$
  select k.mode = 'test' from ledgers l join api_keys k on k.id = l.key_id where l.id = p_ledger_id
$$;

create or replace function resolve_account(p_ledger_id text, p_ref text, p_asset text, p_now timestamptz)
returns text language plpgsql as $$
declare
  v_id text;
  v_world_asset text;
begin
  if p_ref is null then
    raise exception 'validation_failed' using detail = 'account reference is required';
  end if;
  if p_asset is null then
    raise exception 'validation_failed' using detail = 'asset is required';
  end if;
  if p_ref like 'world:%' then
    v_world_asset := substr(p_ref, 7);
    if v_world_asset <> p_asset then
      raise exception 'asset_mismatch' using detail = p_ref;
    end if;
    select id into v_id from accounts where ledger_id = p_ledger_id and kind = 'world' and asset = p_asset;
    if v_id is null then
      v_id := new_id('acct');
      insert into accounts (id, ledger_id, asset, name, kind, created_at)
        values (v_id, p_ledger_id, p_asset, 'world', 'world', p_now);
    end if;
    return v_id;
  end if;
  select id into v_id from accounts where id = p_ref and ledger_id = p_ledger_id;
  if v_id is null then
    raise exception 'account_not_found' using detail = p_ref;
  end if;
  return v_id;
end $$;

-- The caller holds the ledger row lock. Appends one entry, extends the chain,
-- writes the matching event row, and returns the sequence, hash and event id.
create or replace function append_journal(p_ledger_id text, p_kind text, p_entity_id text, p_payload jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_seq bigint;
  v_prev bytea;
  v_key text;
  v_payload jsonb;
  v_hash bytea;
  v_event_id text;
begin
  select next_seq, head_hash, key_id into v_seq, v_prev, v_key from ledgers where id = p_ledger_id for update;
  if v_seq is null then
    raise exception 'ledger_not_found';
  end if;
  if v_seq > 10000 and ledger_is_sandbox(p_ledger_id) then
    raise exception 'sandbox_limit_reached' using detail = 'journal_entries_per_ledger';
  end if;
  v_payload := p_payload || jsonb_build_object('seq', v_seq, 'kind', p_kind, 'ledger', p_ledger_id, 'at', fmt_ts(p_now));
  v_hash := sha256(v_prev || convert_to(canonical_json(v_payload), 'UTF8'));
  insert into journal (ledger_id, seq, kind, entity_id, payload, prev_hash, hash, created_at)
    values (p_ledger_id, v_seq, p_kind, p_entity_id, v_payload, v_prev, v_hash, p_now);
  v_event_id := new_id('evt');
  insert into events (id, key_id, ledger_id, type, entity_id, payload, created_at)
    values (v_event_id, v_key, p_ledger_id, p_kind, p_entity_id, v_payload, p_now);
  update ledgers set next_seq = v_seq + 1, head_hash = v_hash, last_activity_at = p_now where id = p_ledger_id;
  return jsonb_build_object('seq', v_seq, 'hash', encode(v_hash, 'hex'), 'event_id', v_event_id);
end $$;

create or replace function post_transfer(p_ledger_id text, p_transfer_id text, p_legs jsonb, p_memo text, p_metadata jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_n int;
  v_i int;
  v_leg jsonb;
  v_asset text;
  v_amount bigint;
  v_from text;
  v_to text;
  v_hold text;
  v_ids text[] := '{}';
  v_resolved jsonb := '[]'::jsonb;
  v_from_row accounts%rowtype;
  v_to_row accounts%rowtype;
  v_hold_row holds%rowtype;
  v_entry jsonb;
  v_hold_entry jsonb;
  v_events jsonb := '[]'::jsonb;
  v_closed text[] := '{}';
begin
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  v_n := jsonb_array_length(p_legs);
  if v_n < 1 or v_n > 20 then
    raise exception 'validation_failed' using detail = 'legs must have between 1 and 20 entries';
  end if;

  -- Pass one: resolve every account and collect ids. World accounts are created here,
  -- safely, because the ledger lock above serialises writers.
  for v_i in 0 .. v_n - 1 loop
    v_leg := p_legs -> v_i;
    v_asset := v_leg ->> 'asset';
    -- An absent key makes v_leg -> 'key' SQL NULL, and PL/pgSQL's IF treats NULL as
    -- false, so every one of these checks tests key existence first with the jsonb
    -- ? operator: an absent key must fail validation, never fall through as if unset.
    if not (v_leg ? 'asset') or jsonb_typeof(v_leg -> 'asset') <> 'string' or not exists (select 1 from assets where code = v_asset) then
      raise exception 'validation_failed' using detail = format('leg %s asset', v_i);
    end if;
    if not (v_leg ? 'amount') or jsonb_typeof(v_leg -> 'amount') <> 'string' or (v_leg ->> 'amount') !~ '^[1-9][0-9]*$' then
      raise exception 'validation_failed' using detail = format('leg %s amount must be a decimal string of minor units', v_i);
    end if;
    v_amount := (v_leg ->> 'amount')::bigint;
    if ((v_leg ? 'from')::int + (v_leg ? 'from_hold')::int) <> 1 then
      raise exception 'validation_failed' using detail = format('leg %s needs exactly one of from and from_hold', v_i);
    end if;
    if (v_leg ? 'from') and jsonb_typeof(v_leg -> 'from') <> 'string' then
      raise exception 'validation_failed' using detail = format('leg %s from must be an account reference', v_i);
    end if;
    if (v_leg ? 'from_hold') and jsonb_typeof(v_leg -> 'from_hold') <> 'string' then
      raise exception 'validation_failed' using detail = format('leg %s from_hold must be a hold reference', v_i);
    end if;
    if not (v_leg ? 'to') or jsonb_typeof(v_leg -> 'to') <> 'string' then
      raise exception 'validation_failed' using detail = format('leg %s to must be an account reference', v_i);
    end if;
    v_hold := v_leg ->> 'from_hold';
    if v_hold is not null then
      select * into v_hold_row from holds where id = v_hold and ledger_id = p_ledger_id;
      if not found then
        raise exception 'hold_not_found' using detail = format('leg %s', v_i);
      end if;
      v_from := v_hold_row.account_id;
    else
      v_from := resolve_account(p_ledger_id, v_leg ->> 'from', v_asset, p_now);
    end if;
    v_to := resolve_account(p_ledger_id, v_leg ->> 'to', v_asset, p_now);
    if v_from = v_to then
      raise exception 'validation_failed' using detail = format('leg %s moves money from an account to itself', v_i);
    end if;
    v_ids := v_ids || v_from || v_to;
    v_resolved := v_resolved || jsonb_build_object(
      'from', v_from, 'to', v_to, 'asset', v_asset, 'amount', v_amount::text, 'from_hold', v_hold);
  end loop;

  -- The ledger row lock taken above is what actually serialises every writer on this
  -- ledger; that alone is enough for every legitimate caller today. This line is a
  -- fallback, not the primary defence: it locks every touched account in one fixed
  -- order, so two transfers touching the same accounts would queue here instead of
  -- deadlocking, in case the ledger lock is ever relaxed or bypassed.
  perform 1 from accounts where id = any(v_ids) order by id for update;

  -- Pass two: check and apply, reading each account fresh so a second leg on the
  -- same account sees the first leg's effect.
  for v_i in 0 .. v_n - 1 loop
    v_leg := v_resolved -> v_i;
    v_from := v_leg ->> 'from';
    v_to := v_leg ->> 'to';
    v_asset := v_leg ->> 'asset';
    v_amount := (v_leg ->> 'amount')::bigint;
    v_hold := v_leg ->> 'from_hold';
    select * into v_from_row from accounts where id = v_from;
    select * into v_to_row from accounts where id = v_to;
    if v_from_row.asset <> v_asset or v_to_row.asset <> v_asset then
      raise exception 'asset_mismatch' using detail = format('leg %s', v_i);
    end if;
    if v_hold is not null then
      select * into v_hold_row from holds where id = v_hold for update;
      if v_hold_row.status <> 'open' then
        raise exception 'hold_not_open' using detail = format('leg %s', v_i);
      end if;
      if v_hold_row.account_id <> v_from or v_hold_row.asset <> v_asset then
        raise exception 'asset_mismatch' using detail = format('leg %s hold', v_i);
      end if;
      if v_hold_row.remaining < v_amount then
        raise exception 'insufficient_funds' using detail = format('leg %s hold remaining %s', v_i, v_hold_row.remaining);
      end if;
      update holds set remaining = remaining - v_amount where id = v_hold;
      update accounts set balance = balance - v_amount, held = held - v_amount where id = v_from;
      if v_hold_row.remaining = v_amount then
        update holds set status = 'captured', closed_at = p_now where id = v_hold;
        v_closed := v_closed || v_hold;
      end if;
    else
      if v_from_row.kind = 'normal' and v_from_row.balance - v_from_row.held < v_amount then
        raise exception 'insufficient_funds' using detail = format('leg %s available %s', v_i, v_from_row.balance - v_from_row.held);
      end if;
      update accounts set balance = balance - v_amount where id = v_from;
    end if;
    update accounts set balance = balance + v_amount where id = v_to;
  end loop;

  insert into transfers (id, ledger_id, memo, metadata, created_at)
    values (p_transfer_id, p_ledger_id, coalesce(p_memo, ''), coalesce(p_metadata, '{}'::jsonb), p_now);
  for v_i in 0 .. v_n - 1 loop
    v_leg := v_resolved -> v_i;
    insert into transfer_legs (transfer_id, position, from_account, from_hold, to_account, asset, amount)
      values (p_transfer_id, v_i, v_leg ->> 'from', v_leg ->> 'from_hold', v_leg ->> 'to', v_leg ->> 'asset', (v_leg ->> 'amount')::bigint);
  end loop;

  v_entry := append_journal(p_ledger_id, 'transfer.posted', p_transfer_id,
    jsonb_build_object('transfer', jsonb_build_object(
      'id', p_transfer_id, 'memo', coalesce(p_memo, ''), 'metadata', coalesce(p_metadata, '{}'::jsonb), 'legs', v_resolved)),
    p_now);
  update transfers set seq = (v_entry ->> 'seq')::bigint where id = p_transfer_id;
  v_events := v_events || to_jsonb(v_entry ->> 'event_id');

  foreach v_hold in array v_closed loop
    select * into v_hold_row from holds where id = v_hold;
    v_hold_entry := append_journal(p_ledger_id, 'hold.captured', v_hold,
      jsonb_build_object('hold', jsonb_build_object(
        'id', v_hold, 'account', v_hold_row.account_id, 'asset', v_hold_row.asset, 'amount', v_hold_row.amount::text)),
      p_now);
    v_events := v_events || to_jsonb(v_hold_entry ->> 'event_id');
  end loop;

  return jsonb_build_object('id', p_transfer_id, 'seq', (v_entry ->> 'seq')::bigint, 'legs', v_resolved, 'event_ids', v_events);
end $$;

create or replace function create_hold(p_ledger_id text, p_hold_id text, p_account text, p_amount bigint, p_expires_at timestamptz, p_memo text, p_metadata jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_acc accounts%rowtype;
  v_entry jsonb;
  v_open int;
begin
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  select * into v_acc from accounts where id = p_account and ledger_id = p_ledger_id for update;
  if not found then
    raise exception 'account_not_found' using detail = p_account;
  end if;
  if v_acc.kind <> 'normal' then
    raise exception 'validation_failed' using detail = 'holds are not allowed on world accounts';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'validation_failed' using detail = 'amount must be positive';
  end if;
  if ledger_is_sandbox(p_ledger_id) then
    select count(*) into v_open from holds where account_id = p_account and status = 'open';
    if v_open >= 100 then
      raise exception 'sandbox_limit_reached' using detail = 'open_holds_per_account';
    end if;
  end if;
  if v_acc.balance - v_acc.held < p_amount then
    raise exception 'insufficient_funds' using detail = format('available %s', v_acc.balance - v_acc.held);
  end if;
  update accounts set held = held + p_amount where id = p_account;
  insert into holds (id, ledger_id, account_id, asset, amount, remaining, status, expires_at, memo, metadata, created_at)
    values (p_hold_id, p_ledger_id, p_account, v_acc.asset, p_amount, p_amount, 'open', p_expires_at, coalesce(p_memo, ''), coalesce(p_metadata, '{}'::jsonb), p_now);
  v_entry := append_journal(p_ledger_id, 'hold.created', p_hold_id,
    jsonb_build_object('hold', jsonb_build_object(
      'id', p_hold_id, 'account', p_account, 'asset', v_acc.asset, 'amount', p_amount::text,
      'expires_at', fmt_ts(p_expires_at), 'memo', coalesce(p_memo, ''), 'metadata', coalesce(p_metadata, '{}'::jsonb))),
    p_now);
  return jsonb_build_object('id', p_hold_id, 'seq', (v_entry ->> 'seq')::bigint, 'event_ids', jsonb_build_array(v_entry ->> 'event_id'));
end $$;

-- p_kind is 'hold.released' or 'hold.expired'. Returns the remaining amount to available.
create or replace function release_hold(p_ledger_id text, p_hold_id text, p_kind text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_hold holds%rowtype;
  v_entry jsonb;
begin
  if p_kind not in ('hold.released', 'hold.expired') then
    raise exception 'validation_failed' using detail = 'kind';
  end if;
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  select * into v_hold from holds where id = p_hold_id and ledger_id = p_ledger_id for update;
  if not found then
    raise exception 'hold_not_found' using detail = p_hold_id;
  end if;
  if v_hold.status <> 'open' then
    raise exception 'hold_not_open' using detail = v_hold.status;
  end if;
  perform 1 from accounts where id = v_hold.account_id for update;
  update accounts set held = held - v_hold.remaining where id = v_hold.account_id;
  update holds set status = case when p_kind = 'hold.expired' then 'expired' else 'released' end,
    remaining = 0, closed_at = p_now where id = p_hold_id;
  v_entry := append_journal(p_ledger_id, p_kind, p_hold_id,
    jsonb_build_object('hold', jsonb_build_object(
      'id', p_hold_id, 'account', v_hold.account_id, 'asset', v_hold.asset, 'amount', v_hold.remaining::text)),
    p_now);
  return jsonb_build_object('id', p_hold_id, 'released', v_hold.remaining::text, 'seq', (v_entry ->> 'seq')::bigint,
    'event_ids', jsonb_build_array(v_entry ->> 'event_id'));
end $$;

create or replace function expire_holds(p_ledger_id text, p_account text, p_now timestamptz)
returns int language plpgsql as $$
declare
  v_id text;
  v_count int := 0;
begin
  perform 1 from ledgers where id = p_ledger_id for update;
  if not found then
    raise exception 'ledger_not_found';
  end if;
  for v_id in
    select id from holds
    where ledger_id = p_ledger_id and status = 'open' and expires_at <= p_now
      and (p_account is null or account_id = p_account)
    order by created_at, id
  loop
    perform release_hold(p_ledger_id, v_id, 'hold.expired', p_now);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
