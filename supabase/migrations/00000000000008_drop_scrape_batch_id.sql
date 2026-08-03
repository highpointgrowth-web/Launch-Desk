-- Reverts migration 00000000000007. Lead Finder results are no longer
-- auto-persisted on scrape (they stay in-memory until the user explicitly
-- adds one to CRM), so the batch-grouping column this supported is no
-- longer needed. Kept as a forward migration rather than editing/deleting
-- 00000000000007 directly, since that one is already applied in production
-- and rewriting applied migration history is asking for drift.

alter table leads drop column if exists scrape_batch_id;
