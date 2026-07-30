-- Adds an is_admin flag to users, used to gate the admin API routes
-- (e.g. updating any user's plan directly).

alter table users add column if not exists is_admin boolean not null default false;
