-- Customers had no way to avoid a balance running dry mid-day and pausing
-- their agents - they had to notice and manually top up. This lets them opt
-- into automatic recharging off their card on file. Off by default: nobody
-- gets auto-charged unless they explicitly turn it on themselves.
alter table users add column if not exists auto_topup_enabled boolean not null default false;
alter table users add column if not exists auto_topup_threshold_cents integer;
alter table users add column if not exists auto_topup_amount_cents integer;
