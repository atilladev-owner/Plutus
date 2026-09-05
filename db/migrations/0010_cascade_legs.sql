-- Transfer legs and holds referenced accounts and holds without a delete action, so a ledger
-- that ever posted an account to account transfer could not be deleted: the no action check on
-- accounts ran before the cascade through transfers reached the legs. Every row under a ledger
-- now cascades with it.
alter table transfer_legs drop constraint transfer_legs_from_account_fkey,
  add constraint transfer_legs_from_account_fkey foreign key (from_account) references accounts(id) on delete cascade;
alter table transfer_legs drop constraint transfer_legs_to_account_fkey,
  add constraint transfer_legs_to_account_fkey foreign key (to_account) references accounts(id) on delete cascade;
alter table transfer_legs drop constraint transfer_legs_from_hold_fkey,
  add constraint transfer_legs_from_hold_fkey foreign key (from_hold) references holds(id) on delete cascade;
alter table holds drop constraint holds_account_id_fkey,
  add constraint holds_account_id_fkey foreign key (account_id) references accounts(id) on delete cascade;
