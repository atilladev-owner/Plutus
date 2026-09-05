-- Closes a hold as captured when a capture leaves a remainder that the caller chose to
-- release. release_hold always leaves a hold "released", which would misreport a hold
-- that actually had money captured against it. This is the primitive for that case: it
-- frees the remaining held funds exactly like release_hold, but the terminal status is
-- "captured", and the journal records both what happened, in order: the remainder was
-- released, then the hold closed as captured.
create or replace function capture_close_hold(p_ledger_id text, p_hold_id text, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_hold holds%rowtype;
  v_first jsonb;
  v_second jsonb;
  v_events jsonb := '[]'::jsonb;
begin
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
  update holds set status = 'captured', remaining = 0, closed_at = p_now where id = p_hold_id;

  -- v_hold.remaining being zero here cannot happen today: post_transfer already closes a
  -- hold as captured itself when a capture leg exactly exhausts it, so this function is
  -- only ever reached with money still held. Kept as a guard, not a load bearing branch.
  if v_hold.remaining > 0 then
    v_first := append_journal(p_ledger_id, 'hold.released', p_hold_id,
      jsonb_build_object('hold', jsonb_build_object(
        'id', p_hold_id, 'account', v_hold.account_id, 'asset', v_hold.asset,
        'amount', v_hold.remaining::text, 'reason', 'capture_remainder')),
      p_now);
    v_events := v_events || to_jsonb(v_first ->> 'event_id');
  end if;

  v_second := append_journal(p_ledger_id, 'hold.captured', p_hold_id,
    jsonb_build_object('hold', jsonb_build_object(
      'id', p_hold_id, 'account', v_hold.account_id, 'asset', v_hold.asset,
      'amount', v_hold.amount::text, 'captured', (v_hold.amount - v_hold.remaining)::text)),
    p_now);
  v_events := v_events || to_jsonb(v_second ->> 'event_id');

  return jsonb_build_object('id', p_hold_id, 'released', v_hold.remaining::text,
    'seq', (v_second ->> 'seq')::bigint, 'event_ids', v_events);
end $$;
