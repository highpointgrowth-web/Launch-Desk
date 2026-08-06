-- LaunchDesk Supabase schema

create extension if not exists "pgcrypto";

-- ============================================================
-- users
-- ============================================================
create table if not exists users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  plan text not null default 'inactive' check (plan in ('inactive', 'starter', 'pro', 'agency')),
  stripe_customer_id text,
  stripe_subscription_id text,
  scrape_credits_used integer not null default 0,
  scrape_credits_limit integer not null default 0,
  is_admin boolean not null default false,
  agency_name text,
  proposal_template text,
  goal_weekly_revenue numeric,
  goal_monthly_revenue numeric,
  goal_yearly_revenue numeric,
  usage_balance_cents integer not null default 0,
  created_at timestamptz not null default now()
);

alter table users enable row level security;

create policy "Users can view own row"
  on users for select
  using (auth.uid() = id);

create policy "Users can update own row"
  on users for update
  using (auth.uid() = id);

create policy "Users can insert own row"
  on users for insert
  with check (auth.uid() = id);

-- ============================================================
-- leads
-- ============================================================
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  business_name text not null,
  phone text,
  email text,
  website text,
  address text,
  city text,
  state text,
  rating numeric,
  review_count integer,
  category text,
  ai_score numeric,
  ai_reasoning text,
  recommended_agents text[],
  pipeline_stage text not null default 'new'
    check (pipeline_stage in ('new', 'to_contact', 'contacted', 'meeting', 'proposal', 'won', 'lost')),
  owner_status text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists leads_user_id_idx on leads(user_id);

alter table leads enable row level security;

create policy "Users can view own leads"
  on leads for select
  using (auth.uid() = user_id);

create policy "Users can insert own leads"
  on leads for insert
  with check (auth.uid() = user_id);

create policy "Users can update own leads"
  on leads for update
  using (auth.uid() = user_id);

create policy "Users can delete own leads"
  on leads for delete
  using (auth.uid() = user_id);

-- ============================================================
-- agents
-- ============================================================
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  business_name text not null,
  niche text,
  agent_name text,
  voice text,
  greeting text,
  system_prompt text,
  transfer_number text,
  retell_agent_id text,
  retell_llm_id text,
  retell_phone_number text,
  cal_api_key text,
  cal_event_type_id text,
  monthly_charge numeric,
  status text not null default 'building' check (status in ('building', 'active', 'inactive')),
  paused_for_balance boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists agents_user_id_idx on agents(user_id);
create index if not exists agents_lead_id_idx on agents(lead_id);

alter table agents enable row level security;

create policy "Users can view own agents"
  on agents for select
  using (auth.uid() = user_id);

create policy "Users can insert own agents"
  on agents for insert
  with check (auth.uid() = user_id);

create policy "Users can update own agents"
  on agents for update
  using (auth.uid() = user_id);

create policy "Users can delete own agents"
  on agents for delete
  using (auth.uid() = user_id);

-- ============================================================
-- call_logs
-- ============================================================
create table if not exists call_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  retell_call_id text unique,
  duration_seconds integer,
  transcript text,
  outcome text,
  booked boolean not null default false,
  retell_cost_cents integer,
  cost_charged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists call_logs_agent_id_idx on call_logs(agent_id);
create index if not exists call_logs_user_id_idx on call_logs(user_id);
create index if not exists call_logs_retell_call_id_idx on call_logs(retell_call_id);

alter table call_logs enable row level security;

create policy "Users can view own call logs"
  on call_logs for select
  using (auth.uid() = user_id);

create policy "Users can insert own call logs"
  on call_logs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own call logs"
  on call_logs for update
  using (auth.uid() = user_id);

create policy "Users can delete own call logs"
  on call_logs for delete
  using (auth.uid() = user_id);

-- ============================================================
-- proposals
-- ============================================================
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  agent_id uuid references agents(id) on delete set null,
  content text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'closed')),
  viewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists proposals_user_id_idx on proposals(user_id);
create index if not exists proposals_lead_id_idx on proposals(lead_id);
create index if not exists proposals_agent_id_idx on proposals(agent_id);

alter table proposals enable row level security;

create policy "Users can view own proposals"
  on proposals for select
  using (auth.uid() = user_id);

create policy "Users can insert own proposals"
  on proposals for insert
  with check (auth.uid() = user_id);

create policy "Users can update own proposals"
  on proposals for update
  using (auth.uid() = user_id);

create policy "Users can delete own proposals"
  on proposals for delete
  using (auth.uid() = user_id);

-- ============================================================
-- user_integrations
-- ============================================================
create table if not exists user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('cal', 'email')),
  config jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists user_integrations_user_id_idx on user_integrations(user_id);

alter table user_integrations enable row level security;

create policy "Users can view own integrations"
  on user_integrations for select
  using (auth.uid() = user_id);

create policy "Users can insert own integrations"
  on user_integrations for insert
  with check (auth.uid() = user_id);

create policy "Users can update own integrations"
  on user_integrations for update
  using (auth.uid() = user_id);

create policy "Users can delete own integrations"
  on user_integrations for delete
  using (auth.uid() = user_id);

-- ============================================================
-- meetings
-- ============================================================
create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  business_name text not null,
  meeting_date date not null,
  meeting_time text,
  notes text,
  status text not null default 'upcoming' check (status in ('upcoming', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists meetings_user_id_idx on meetings(user_id);
create index if not exists meetings_lead_id_idx on meetings(lead_id);

alter table meetings enable row level security;

create policy "Users can view own meetings"
  on meetings for select
  using (auth.uid() = user_id);

create policy "Users can insert own meetings"
  on meetings for insert
  with check (auth.uid() = user_id);

create policy "Users can update own meetings"
  on meetings for update
  using (auth.uid() = user_id);

create policy "Users can delete own meetings"
  on meetings for delete
  using (auth.uid() = user_id);

-- ============================================================
-- lead_activities
-- ============================================================
create table if not exists lead_activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  type text not null check (type in ('call', 'email', 'dm')),
  notes text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists lead_activities_user_id_idx on lead_activities(user_id);
create index if not exists lead_activities_lead_id_idx on lead_activities(lead_id);

alter table lead_activities enable row level security;

create policy "Users can view own lead activities"
  on lead_activities for select
  using (auth.uid() = user_id);

create policy "Users can insert own lead activities"
  on lead_activities for insert
  with check (auth.uid() = user_id);

create policy "Users can update own lead activities"
  on lead_activities for update
  using (auth.uid() = user_id);

create policy "Users can delete own lead activities"
  on lead_activities for delete
  using (auth.uid() = user_id);

-- ============================================================
-- todos
-- ============================================================
create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists todos_user_id_idx on todos(user_id);

alter table todos enable row level security;

create policy "Users can view own todos"
  on todos for select
  using (auth.uid() = user_id);

create policy "Users can insert own todos"
  on todos for insert
  with check (auth.uid() = user_id);

create policy "Users can update own todos"
  on todos for update
  using (auth.uid() = user_id);

create policy "Users can delete own todos"
  on todos for delete
  using (auth.uid() = user_id);

-- ============================================================
-- lead_searches
-- ============================================================
create table if not exists lead_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  industry text not null,
  location text not null,
  radius integer,
  result_count integer not null default 0,
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lead_searches_user_id_idx on lead_searches(user_id);
create index if not exists lead_searches_created_at_idx on lead_searches(created_at);

alter table lead_searches enable row level security;

create policy "Users can view own lead searches"
  on lead_searches for select
  using (auth.uid() = user_id);

create policy "Users can insert own lead searches"
  on lead_searches for insert
  with check (auth.uid() = user_id);

create policy "Users can update own lead searches"
  on lead_searches for update
  using (auth.uid() = user_id);

create policy "Users can delete own lead searches"
  on lead_searches for delete
  using (auth.uid() = user_id);

-- ============================================================
-- usage_transactions
-- ============================================================
create table if not exists usage_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount_cents integer not null,
  type text not null check (type in ('topup', 'call_charge', 'feature_charge')),
  call_log_id uuid references call_logs(id) on delete set null,
  description text,
  created_at timestamptz not null default now()
);

create index if not exists usage_transactions_user_id_idx on usage_transactions(user_id);

alter table usage_transactions enable row level security;

create policy "Users can view own usage transactions"
  on usage_transactions for select
  using (auth.uid() = user_id);

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

-- Atomic "charge only if the balance covers it" - see billing-constants.js
-- for why this exists (flat-fee AI-generation charges must never front cost).
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

-- scrape_credits_used is monotonically incremented by routes/leads.js -
-- reset it monthly so "N scrapes/mo" is actually monthly, not lifetime.
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'reset-scrape-credits-monthly',
  '0 0 1 * *',
  $$ update public.users set scrape_credits_used = 0; $$
);

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
