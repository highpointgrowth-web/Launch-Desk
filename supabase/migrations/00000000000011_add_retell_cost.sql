-- Retell sends the real per-call cost (call_cost.combined_cost, in cents) in
-- the call_ended webhook payload - captured so billing pages can show real
-- profit/margin instead of a manually-entered estimate.
alter table call_logs add column if not exists retell_cost_cents integer;
