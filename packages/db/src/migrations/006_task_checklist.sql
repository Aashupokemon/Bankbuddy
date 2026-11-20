-- 006 — task checklists
--
-- A checklist is the small, ordered set of steps inside one task ("collect the address proof",
-- "get the manager's signature"). It is deliberately not a sub-task: no owner, no due date, no
-- notifications, so it cannot grow into a second board nobody reconciles.
--
-- Position is a plain integer rather than a float rank: the branch lists are a handful of steps,
-- so rewriting the positions on reorder is cheaper and easier to reason about than fractional ranks.

create table task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  done boolean not null default false,
  position integer not null default 0,
  completed_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A checked item always carries its timestamp, so progress over time stays auditable.
  constraint checklist_completed_needs_timestamp check ((not done) or completed_at is not null)
);

create index task_checklist_task_idx on task_checklist_items (task_id, position);

alter table task_checklist_items enable row level security;
create policy branch_isolation on task_checklist_items for all
  using (branch_id = current_branch_id())
  with check (branch_id = current_branch_id());

grant select, insert, update, delete on task_checklist_items to bankbuddy_app;
