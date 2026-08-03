-- Groups leads inserted by a single Lead Finder scrape so the frontend
-- can reload "your most recent search" after navigating away, instead
-- of scrape results only existing in memory for the current page view.

alter table leads add column if not exists scrape_batch_id uuid;
create index if not exists leads_scrape_batch_id_idx on leads(scrape_batch_id);
