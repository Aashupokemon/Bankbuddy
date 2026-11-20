-- 007 — photo evidence
--
-- A checked checklist step is an assertion. A photo next to it is the evidence a supervisor can
-- actually review ("the vault is empty and the register is signed"), which is the one attachment a
-- branch workflow really needs.
--
-- The bytes live in a separate table from the checklist item so listing a checklist never pulls
-- image data, and a step can only ever carry one photo (unique on checklist_item_id): replacing it
-- is an update, not an ever-growing gallery. Content is deliberately capped in the API rather than
-- here so the error is a readable 413 instead of a constraint violation.

create table task_attachments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  checklist_item_id uuid references task_checklist_items (id) on delete cascade,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 700000),
  data bytea not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now()
);

create index task_attachments_task_idx on task_attachments (task_id);
create unique index task_attachments_step_idx on task_attachments (checklist_item_id)
  where checklist_item_id is not null;

alter table task_attachments enable row level security;
create policy branch_isolation on task_attachments for all
  using (branch_id = current_branch_id())
  with check (branch_id = current_branch_id());

grant select, insert, update, delete on task_attachments to bankbuddy_app;
