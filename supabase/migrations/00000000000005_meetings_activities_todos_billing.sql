-- Adds the tables/columns for Booked Meetings, Clients, Payments, Proposals
-- funnel stats, CRM activity logging, To-Dos, agency profile/goals, and
-- per-agent client billing.

alter table users add column if not exists agency_name text;
alter table users add column if not exists proposal_template text;
alter table users add column if not exists goal_weekly_revenue numeric;
alter table users add column if not exists goal_monthly_revenue numeric;
alter table users add column if not exists goal_yearly_revenue numeric;

alter table agents add column if not exists monthly_charge numeric;

alter table proposals add column if not exists viewed_at timestamptz;

-- ============================================================
-- meetings
-- ============================================================
create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
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
