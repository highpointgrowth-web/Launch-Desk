-- Prepaid usage balance: customers fund a balance before their agents can
-- run, and every real Retell call cost (+ markup) is deducted from it as
-- calls happen. Replaces ever fronting Retell cost on the agency's behalf.
alter table users add column if not exists usage_balance_cents integer not null default 0;

alter table call_logs add column if not exists cost_charged boolean not null default false;

create table if not exists usage_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount_cents integer not null,
  type text not null check (type in ('topup', 'call_charge')),
  call_log_id uuid references call_logs(id) on delete set null,
  description text,
  created_at timestamptz not null default now()
);

create index if not exists usage_transactions_user_id_idx on usage_transactions(user_id);

alter table usage_transactions enable row level security;

create policy "Users can view own usage transactions"
  on usage_transactions for select
  using (auth.uid() = user_id);

-- Atomic increment/decrement functions so concurrent calls settling at the
-- same time can't race each other into an incorrect balance.
create or replace function increment_usage_balance(p_user_id uuid, p_amount_cents integer)
returns integer
language plpgsql
as $$
declare
  new_balance integer;
begin
  update users
  set usage_balance_cents = usage_balance_cents + p_amount_cents
  where id = p_user_id
  returning usage_balance_cents into new_balance;
  return new_balance;
end;
$$;

create or replace function decrement_usage_balance(p_user_id uuid, p_amount_cents integer)
returns integer
language plpgsql
as $$
declare
  new_balance integer;
begin
  update users
  set usage_balance_cents = usage_balance_cents - p_amount_cents
  where id = p_user_id
  returning usage_balance_cents into new_balance;
  return new_balance;
end;
$$;
