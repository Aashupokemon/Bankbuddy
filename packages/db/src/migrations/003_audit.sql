-- 003 — append-only, hash-chained audit trail

create or replace function audit_events_stamp() returns trigger
language plpgsql as $$
declare
  previous_hash text;
  payload text;
begin
  -- Serialise inserts per branch so the chain cannot fork under concurrency.
  if new.branch_id is not null then
    perform pg_advisory_xact_lock(hashtext('audit:' || new.branch_id::text));
    select a.hash into previous_hash
    from audit_events a
    where a.branch_id = new.branch_id
    order by a.seq desc
    limit 1;
  end if;

  new.prev_hash := previous_hash;

  payload := coalesce(new.prev_hash, '') || '|'
    || coalesce(new.branch_id::text, '') || '|'
    || coalesce(new.actor_id::text, '') || '|'
    || new.action || '|'
    || new.entity_type || '|'
    || coalesce(new.entity_id::text, '') || '|'
    || coalesce(new.before::text, '') || '|'
    || coalesce(new.after::text, '') || '|'
    || coalesce(new.reason, '') || '|'
    || new.occurred_at::text;

  new.hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
  return new;
end $$;

drop trigger if exists audit_events_stamp on audit_events;
create trigger audit_events_stamp
  before insert on audit_events
  for each row execute function audit_events_stamp();

create or replace function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_events_no_update on audit_events;
create trigger audit_events_no_update
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

-- Timestamps and versions are owned by the database, not by the caller.
create or replace function tasks_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch
  before update on tasks
  for each row execute function tasks_touch();
