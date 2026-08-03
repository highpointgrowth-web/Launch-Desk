-- Adds a real column for the Prompt tab's "Call Transfer" field, which was
-- previously a decorative input that saved nowhere.

alter table agents add column if not exists transfer_number text;
