-- Deleting a lead from the CRM should also remove any meeting booked against
-- it, instead of leaving an orphaned meeting with lead_id set to null.
alter table meetings drop constraint if exists meetings_lead_id_fkey;
alter table meetings
  add constraint meetings_lead_id_fkey
  foreign key (lead_id) references leads(id) on delete cascade;
