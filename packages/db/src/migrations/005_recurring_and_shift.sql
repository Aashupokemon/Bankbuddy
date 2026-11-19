-- 005 — recurring branch chores and whole-shift handovers
--
-- A template is the definition of a chore; a task is one day's occurrence of it. The unique index on
-- (template_id, occurrence_on) makes running the materialiser twice in a day a no-op instead of a
-- duplicate chore, even if two managers tap "run" at the same moment.

create table task_templates (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  title text not null check (length(title) between 3 and 200),
  description text not null default '',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category_key text,
  owner_id uuid references users (id),
  cadence text not null check (cadence in ('daily', 'weekly')),
  -- 0 = Sunday … 6 = Saturday, in the branch's timezone. Only meaningful for weekly chores.
  weekday integer check (weekday between 0 and 6),
  due_time text not null default '09:00' check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  active boolean not null default true,
  last_run_on date,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_chore_needs_weekday check (cadence <> 'weekly' or weekday is not null)
);
create index task_templates_branch_idx on task_templates (branch_id, active);

alter table tasks add column template_id uuid references task_templates (id) on delete set null;
alter table tasks add column occurrence_on date;
create unique index tasks_template_occurrence_idx on tasks (template_id, occurrence_on);

-- 'tasks' is the existing explicit list; 'shift' is everything the outgoing person still owns.
alter table handovers add column scope text not null default 'tasks' check (scope in ('tasks', 'shift'));

alter table task_templates enable row level security;
create policy branch_isolation on task_templates for all
  using (branch_id = current_branch_id())
  with check (branch_id = current_branch_id());

grant select, insert, update, delete on task_templates to bankbuddy_app;

-- Inserting a notification for someone else is allowed by the insert policy, but the
-- `on conflict (dedupe_key) do nothing` probe cannot see another person's row under the read
-- policy, so Postgres rejects the speculative insert as an RLS violation. This helper is the single
-- sanctioned path for that insert: it runs as the owner, re-checks the branch and the recipient
-- itself, and keeps the dedupe guarantee without widening who may read notifications.
create or replace function insert_notification(
  p_branch uuid,
  p_user uuid,
  p_task uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_dedupe text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_branch is distinct from current_branch_id() then
    raise exception 'notification outside the request branch' using errcode = '42501';
  end if;
  if not exists (select 1 from memberships m where m.branch_id = p_branch and m.user_id = p_user) then
    raise exception 'notification recipient is not in this branch' using errcode = '42501';
  end if;

  insert into notifications (branch_id, user_id, task_id, kind, title, body, dedupe_key)
  values (p_branch, p_user, p_task, p_kind, p_title, p_body, p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

grant execute on function insert_notification(uuid, uuid, uuid, text, text, text, text) to bankbuddy_app;
