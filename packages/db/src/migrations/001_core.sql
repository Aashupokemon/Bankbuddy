-- 001 — core schema
-- Every table that holds branch data carries branch_id so row-level security can be applied
-- without joins, and so audit queries stay cheap.

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_unique on users (lower(email));

create table memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('employee', 'lead', 'manager', 'workspace_admin', 'auditor')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (branch_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

-- Role changes are security events: the current role lives on memberships, the trail lives here.
create table membership_role_events (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references memberships (id) on delete cascade,
  branch_id uuid not null,
  from_role text,
  to_role text not null,
  actor_id uuid references users (id),
  reason text,
  created_at timestamptz not null default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  label text not null,
  created_at timestamptz not null default now(),
  unique (branch_id, key)
);

create table branch_settings (
  branch_id uuid primary key references branches (id) on delete cascade,
  quiet_hours_start time,
  quiet_hours_end time,
  reminder_lead_minutes integer not null default 60 check (reminder_lead_minutes between 0 and 10080),
  weekly_overdue_day integer not null default 0 check (weekly_overdue_day between 0 and 6),
  updated_at timestamptz not null default now()
);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  day date not null,
  label text,
  unique (branch_id, day)
);

create table notification_preferences (
  user_id uuid not null references users (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  in_app boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  primary key (user_id, branch_id)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  title text not null check (length(title) between 3 and 200),
  description text not null default '',
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled', 'archived')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  category_key text,
  owner_id uuid references users (id),
  -- Distinguishes "nobody has chosen an owner yet" from "explicitly unassigned".
  unassigned_explicit boolean not null default false,
  blocked_reason text,
  due_at timestamptz,
  due_precision text check (due_precision in ('date', 'datetime')),
  due_source_phrase text,
  completed_at timestamptz,
  completed_by uuid references users (id),
  archived_at timestamptz,
  deleted_at timestamptz,
  recurrence_rule text check (recurrence_rule in ('daily', 'weekly', 'monthly')),
  recurrence_parent_id uuid references tasks (id),
  version integer not null default 0,
  created_by uuid not null references users (id),
  updated_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint due_precision_required check ((due_at is null) = (due_precision is null)),
  constraint blocked_needs_reason check (status <> 'blocked' or (blocked_reason is not null and length(blocked_reason) > 0)),
  constraint archived_needs_timestamp check (status <> 'archived' or archived_at is not null)
);

create index tasks_branch_status_idx on tasks (branch_id, status) where deleted_at is null;
create index tasks_branch_due_idx on tasks (branch_id, due_at) where deleted_at is null;
create index tasks_branch_owner_idx on tasks (branch_id, owner_id) where deleted_at is null;
create index tasks_overdue_idx on tasks (branch_id, due_at) where status in ('open', 'in_progress', 'blocked') and deleted_at is null;
create index tasks_search_idx on tasks using gin (to_tsvector('english', title || ' ' || description));

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  author_id uuid not null references users (id),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index task_comments_task_idx on task_comments (task_id, created_at);

create table task_dependencies (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  depends_on_task_id uuid not null references tasks (id) on delete cascade,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (task_id, depends_on_task_id),
  constraint no_self_dependency check (task_id <> depends_on_task_id)
);

-- Activity feed: what changed, with before/after, readable by the branch.
create table task_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null,
  task_id uuid not null references tasks (id) on delete cascade,
  actor_id uuid references users (id),
  kind text not null,
  summary text not null,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index task_events_task_idx on task_events (task_id, created_at);

-- Audit trail: append-only (enforced in 003) and hash-chained per branch.
create table audit_events (
  seq bigserial primary key,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  actor_id uuid references users (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  occurred_at timestamptz not null default now(),
  prev_hash text,
  hash text not null default ''
);
create index audit_events_branch_idx on audit_events (branch_id, occurred_at desc);
create index audit_events_entity_idx on audit_events (entity_type, entity_id);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  kind text not null check (kind in ('due_soon', 'overdue_daily', 'overdue_weekly')),
  dedupe_key text not null unique,
  scheduled_for timestamptz not null,
  task_version_at_schedule integer not null,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index reminders_pending_idx on reminders (scheduled_for) where sent_at is null;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  task_id uuid references tasks (id) on delete set null,
  kind text not null,
  title text not null,
  body text not null,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table handovers (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  from_user_id uuid not null references users (id),
  to_user_id uuid not null references users (id),
  note text,
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create index handovers_to_idx on handovers (to_user_id, status);

create table handover_tasks (
  handover_id uuid not null references handovers (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  primary key (handover_id, task_id)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  locked_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_due_idx on jobs (run_at) where completed_at is null;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  device_label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Offline replay: an operation is applied at most once, keyed by its client-generated id.
create table sync_operations (
  id uuid primary key,
  branch_id uuid not null references branches (id) on delete cascade,
  user_id uuid not null references users (id),
  kind text not null,
  payload jsonb not null,
  status text not null,
  detail text,
  task_id uuid,
  created_at timestamptz not null default now()
);
