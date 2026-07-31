-- Stores the Retell LLM object id alongside the agent so it can be cleaned
-- up (DELETE /delete-retell-llm/:id) when the agent is deleted, instead of
-- leaking an orphaned Retell LLM resource on every build+delete cycle.

alter table agents add column if not exists retell_llm_id text;
