-- Distinguishes "we auto-paused this for a $0 balance" from a user
-- deliberately setting an agent inactive, so topping up only resumes the
-- agents the balance system paused, not ones the user turned off on purpose.
alter table agents add column if not exists paused_for_balance boolean not null default false;
