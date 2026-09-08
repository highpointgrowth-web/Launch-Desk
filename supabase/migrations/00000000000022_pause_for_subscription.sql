-- Separate from paused_for_balance (migration 13) - Stripe's default dunning
-- retries a failed subscription charge for ~3 weeks before the subscription
-- is actually canceled, and until now nothing paused an agent during that
-- window, meaning LaunchDesk kept paying real vendor cost (AI generation,
-- scraping) for a customer who wasn't paying it. Pausing on the second
-- failed attempt instead of waiting the full window - see the
-- no-fronting-money conversation this was derived from - needs its own flag
-- so a subscription-triggered pause and a balance-triggered pause can't
-- clobber each other's resume logic.
alter table agents add column if not exists paused_for_subscription boolean not null default false;
