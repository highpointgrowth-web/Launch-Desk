-- Adds lead_searches, a history log of each Lead Finder scrape (with its
-- full scored results) so past searches can be reviewed/re-viewed/exported
-- without burning another scrape credit.

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
