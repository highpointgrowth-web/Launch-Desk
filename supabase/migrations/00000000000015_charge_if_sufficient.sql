-- Atomic "charge only if the balance covers it" - the update's WHERE clause
-- makes the check-then-deduct a single atomic operation, so a flat-fee charge
-- (agent build, proposal, cold-call script) can never push a balance negative
-- the way a post-hoc call charge can. Returns the new balance, or no row
-- (null) if the balance was insufficient - the caller never performs the
-- underlying paid action in that case, so we never front the cost.
create or replace function charge_if_sufficient(p_user_id uuid, p_amount_cents integer)
returns integer
language plpgsql
as $$
declare
  new_balance integer;
begin
  update users
  set usage_balance_cents = usage_balance_cents - p_amount_cents
  where id = p_user_id and usage_balance_cents >= p_amount_cents
  returning usage_balance_cents into new_balance;
  return new_balance;
end;
$$;

alter table usage_transactions drop constraint if exists usage_transactions_type_check;
alter table usage_transactions
  add constraint usage_transactions_type_check
  check (type in ('topup', 'call_charge', 'feature_charge'));
