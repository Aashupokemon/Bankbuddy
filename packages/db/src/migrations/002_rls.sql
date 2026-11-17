-- 002 — row-level security
--
-- The API sets `app.branch_id` and `app.user_id` for the lifetime of a request transaction, both
-- derived from the authenticated membership. Policies fail closed: when the setting is absent the
-- comparison yields NULL and no rows are visible.

create or replace function current_branch_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.branch_id', true), '')::uuid
$$;

create or replace function current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'tasks', 'task_comments', 'task_events', 'task_dependencies', 'reminders',
    'notifications', 'handovers', 'handover_tasks', 'categories', 'holidays',
    'branch_settings', 'audit_events', 'sync_operations'
  ]
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Branch-scoped tables: every row must belong to the request's branch.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tasks', 'task_comments', 'task_events', 'task_dependencies', 'reminders',
    'categories', 'holidays', 'branch_settings', 'audit_events'
  ]
  loop
    execute format('drop policy if exists branch_isolation on %I', t);
    execute format(
      'create policy branch_isolation on %I for all
         using (branch_id = current_branch_id())
         with check (branch_id = current_branch_id())', t);
  end loop;
end $$;

-- Notifications are readable and acknowledgeable only by their recipient, but any member of the
-- branch may create one for someone else (assignment, handover, reminder fan-out). The API decides
-- who receives what; the database stops anyone reading another person's notifications.
drop policy if exists branch_isolation on notifications;
create policy notifications_read on notifications for select
  using (branch_id = current_branch_id() and user_id = current_user_id());
create policy notifications_insert on notifications for insert
  with check (branch_id = current_branch_id());
create policy notifications_update on notifications for update
  using (branch_id = current_branch_id() and user_id = current_user_id())
  with check (branch_id = current_branch_id() and user_id = current_user_id());

-- Sync operations are strictly the caller's own.
drop policy if exists branch_isolation on sync_operations;
create policy sync_operations_read on sync_operations for select
  using (branch_id = current_branch_id() and user_id = current_user_id());
create policy sync_operations_insert on sync_operations for insert
  with check (branch_id = current_branch_id() and user_id = current_user_id());
create policy sync_operations_update on sync_operations for update
  using (branch_id = current_branch_id() and user_id = current_user_id());

-- Handovers: visible to the two parties and to nothing else.
drop policy if exists branch_isolation on handovers;
create policy branch_isolation on handovers for all
  using (
    branch_id = current_branch_id()
    and (from_user_id = current_user_id() or to_user_id = current_user_id())
  )
  with check (branch_id = current_branch_id());

drop policy if exists branch_isolation on handover_tasks;
create policy branch_isolation on handover_tasks for all
  using (
    exists (
      select 1 from handovers h
      where h.id = handover_tasks.handover_id
        and h.branch_id = current_branch_id()
        and (h.from_user_id = current_user_id() or h.to_user_id = current_user_id())
    )
  )
  with check (
    exists (
      select 1 from handovers h
      where h.id = handover_tasks.handover_id
        and h.branch_id = current_branch_id()
    )
  );

-- The seed and migration path runs as the table owner. Application connections use this same
-- owner role in development, so the API deliberately does not rely on RLS alone: every query is
-- also scoped by branch_id (§6.3 defence in depth). Tests prove the policies work by assuming a
-- non-owner role — see apps/api/test/isolation.test.ts.
