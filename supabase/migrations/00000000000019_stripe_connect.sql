-- Read-only Stripe Connect: lets an agency link the Stripe account they
-- already use to bill their own clients, so LaunchDesk can show real
-- revenue instead of the self-reported monthly_charge estimate. Storing
-- only the connected account id (not a secret - used with the platform's
-- own secret key via the Stripe-Account header) since scope is read_only,
-- LaunchDesk can never move money through a connected account.
alter table users add column if not exists stripe_connect_account_id text;
