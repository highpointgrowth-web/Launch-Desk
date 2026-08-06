-- scrape_credits_used only ever incremented (routes/leads.js POST /scrape) -
-- nothing anywhere reset it, so despite plans being sold as "N scrapes/mo",
-- a user who hit their cap once was locked out of Lead Finder permanently.
create extension if not exists pg_cron with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'reset-scrape-credits-monthly';

select cron.schedule(
  'reset-scrape-credits-monthly',
  '0 0 1 * *',
  $$ update public.users set scrape_credits_used = 0; $$
);
