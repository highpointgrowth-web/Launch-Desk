-- Add retell_call_id to call_logs so call_analyzed webhooks can be matched
-- back to the exact row created by the preceding call_ended webhook.

alter table call_logs add column if not exists retell_call_id text unique;
create index if not exists call_logs_retell_call_id_idx on call_logs(retell_call_id);
