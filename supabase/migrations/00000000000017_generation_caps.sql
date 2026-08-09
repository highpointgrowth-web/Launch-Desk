-- Replaces per-action balance charges for agent-build/proposal/cold-call-
-- script generation with monthly counted caps per plan, bundled into the
-- subscription instead of metered from the prepaid balance - matches how
-- scrape_credits already work, and avoids charging per-AI-action the way
-- that frustrated real testing (client didn't expect a $0.75 deduction just
-- for reviewing a prompt).
alter table users add column if not exists agent_build_count integer not null default 0;
alter table users add column if not exists proposal_count integer not null default 0;
alter table users add column if not exists cold_call_script_count integer not null default 0;

create or replace function increment_agent_build_count(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
as $$
declare
  new_count integer;
begin
  update users
  set agent_build_count = agent_build_count + 1
  where id = p_user_id and agent_build_count < p_limit
  returning agent_build_count into new_count;
  return new_count;
end;
$$;

create or replace function increment_proposal_count(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
as $$
declare
  new_count integer;
begin
  update users
  set proposal_count = proposal_count + 1
  where id = p_user_id and proposal_count < p_limit
  returning proposal_count into new_count;
  return new_count;
end;
$$;

create or replace function increment_cold_call_script_count(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
as $$
declare
  new_count integer;
begin
  update users
  set cold_call_script_count = cold_call_script_count + 1
  where id = p_user_id and cold_call_script_count < p_limit
  returning cold_call_script_count into new_count;
  return new_count;
end;
$$;

-- Extend the existing monthly reset (see migration 16) to also zero these
-- counts out alongside scrape_credits_used.
select cron.unschedule(jobid) from cron.job where jobname = 'reset-scrape-credits-monthly';

select cron.schedule(
  'reset-scrape-credits-monthly',
  '0 0 1 * *',
  $$ update public.users set scrape_credits_used = 0, agent_build_count = 0, proposal_count = 0, cold_call_script_count = 0; $$
);
