-- New signups no longer get a working plan for free. plan now starts as
-- 'inactive' (no scrape credits, feature routes blocked) until Stripe
-- checkout completes and the webhook promotes them to a real paid plan.
alter table users drop constraint if exists users_plan_check;
alter table users add constraint users_plan_check
  check (plan in ('inactive', 'starter', 'pro', 'agency'));
alter table users alter column plan set default 'inactive';
