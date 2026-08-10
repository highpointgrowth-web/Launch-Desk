-- Tracks when an agent was paused for balance, so a scheduled cleanup can
-- release its phone number (which otherwise keeps renting on our Retell
-- account forever) once it's been dormant long enough.
alter table agents add column if not exists paused_at timestamptz;
