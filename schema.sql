-- LaunchDesk Supabase schema

create extension if not exists "pgcrypto";

-- ============================================================
-- users
-- ============================================================
create table if not exists users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  plan text not null default 'starter' check (plan in ('starter', 'pro', 'agency')),
  stripe_customer_id text,
  stripe_subscription_id text,
  scrape_credits_used integer not null default 0,
  scrape_credits_limit integer not null default 0,
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
  retell_agent_id text,
  retell_phone_number text,
  cal_api_key text,
  cal_event_type_id text,
  status text not null default 'building' check (status in ('building', 'active', 'inactive')),
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
