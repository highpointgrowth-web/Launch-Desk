-- Adds user_integrations, storing each user's third-party connection
-- config (Cal.com, email) for the Settings > Integrations panel.

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
