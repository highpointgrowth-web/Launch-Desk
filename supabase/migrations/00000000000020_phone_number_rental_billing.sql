-- Phone numbers were never metered - an agent's rented Retell number cost
-- real money every month forever (no expiry, unlimited agents on Pro/Agency)
-- with nothing deducting it from the customer's balance. This adds the
-- per-agent "next bill" clock the server.js cron and routes/agents.js
-- buy-phone route use to charge it monthly, same balance+ledger pattern as
-- call usage.
alter table agents add column if not exists phone_number_next_bill_at timestamptz;
