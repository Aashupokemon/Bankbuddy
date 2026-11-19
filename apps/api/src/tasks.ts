import { randomUUID } from "node:crypto";

import {
  allowedTransitions,
  can,
  canChangeStatus,
  canEditTask,
  canTransition,
  priorityRank,
  reasonRequiredFor,
  transitionNeedsManager,
  type BulkReassignInput,
  type BulkReassignResponse,
  type CreateTaskInput,
  type DashboardResponse,
  type TaskDto,
  type TaskListResponse,
  type TaskStatus,
  type TransitionTaskInput,
  type UpdateTaskInput,
} from "@bankbuddy/contracts";
import { addDays, dayBounds, endOfDay, isOverdue, toIsoDate } from "@bankbuddy/date";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import { ApiError } from "./http.ts";
import type { Identity } from "./auth.ts";

export interface TaskRow {
  id: string;
  branch_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskDto["priority"];
  category_key: string | null;
  owner_id: string | null;
  owner_name: string | null;
  unassigned_explicit: boolean;
  blocked_reason: string | null;
  due_at: Date | string | null;
  due_precision: TaskDto["duePrecision"];
  due_source_phrase: string | null;
  completed_at: Date | string | null;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  recurrence_rule: string | null;
  dependency_count?: number | string;
  blocked_by_count?: number | string;
  deleted_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function mapTask(row: TaskRow, timeZone: string, now = new Date()): TaskDto {
  const dueIso = iso(row.due_at);
  return {
    id: row.id,
    branchId: row.branch_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    categoryKey: row.category_key,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    unassigned: row.owner_id === null && row.unassigned_explicit,
    blockedReason: row.blocked_reason,
    dueAt: dueIso,
    duePrecision: row.due_precision,
    dueSourcePhrase: row.due_source_phrase,
    completedAt: iso(row.completed_at),
    version: row.version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    isOverdue:
      dueIso !== null &&
      row.status !== "done" &&
      row.status !== "cancelled" &&
      row.status !== "archived" &&
      isOverdue(new Date(dueIso), row.due_precision ?? "datetime", timeZone, now),
    dependencyCount: Number(row.dependency_count ?? 0),
    blockedByCount: Number(row.blocked_by_count ?? 0),
  };
}

const SELECT_TASK = `
  select t.*, u.name as owner_name,
    (select count(*) from task_dependencies d where d.task_id = t.id) as dependency_count,
    (select count(*) from task_dependencies d
       join tasks dep on dep.id = d.depends_on_task_id
      where d.task_id = t.id and dep.status not in ('done', 'cancelled', 'archived')) as blocked_by_count
    from tasks t
    left join users u on u.id = t.owner_id
`;

export interface ListOptions {
  scope?: "mine" | "team" | "all";
  status?: TaskStatus[];
  filter?: "due_today" | "overdue" | "blocked";
  ownerId?: string | null;
  categoryKey?: string;
  priority?: string[];
  q?: string;
  limit?: number;
  cursor?: string | null;
  sort?: "due" | "updated" | "created";
}

export async function listTasks(
  db: Queryable,
  identity: Identity,
  options: ListOptions = {},
): Promise<TaskListResponse> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf8")) || 0 : 0;

  const where: string[] = ["t.branch_id = $1", "t.deleted_at is null"];
  const params: unknown[] = [identity.branchId];

  if (identity.role === "employee" && options.scope !== "mine") {
    // Employees never see the whole branch board; they see their own work plus unassigned pickups.
    where.push("(t.owner_id = $2 or t.created_by = $2)");
    params.push(identity.userId);
  } else if (options.scope === "mine") {
    params.push(identity.userId);
    where.push(`(t.owner_id = $${params.length} or t.created_by = $${params.length})`);
  }

  if (options.status?.length) {
    params.push(options.status);
    where.push(`t.status = any($${params.length}::text[])`);
  }

  if (options.ownerId === null) where.push("t.owner_id is null");
  else if (options.ownerId) {
    params.push(options.ownerId);
    where.push(`t.owner_id = $${params.length}`);
  }

  if (options.categoryKey) {
    params.push(options.categoryKey);
    where.push(`t.category_key = $${params.length}`);
  }

  if (options.priority?.length) {
    params.push(options.priority);
    where.push(`t.priority = any($${params.length}::text[])`);
  }

  const now = new Date();
  if (options.filter === "overdue") {
    where.push(
      `t.due_at is not null and t.status in ('open','in_progress','blocked')
       and case when t.due_precision = 'date' then t.due_at::date < $${params.length + 1}::date
                else t.due_at < now() end`,
    );
    params.push(toIsoDate(now, identity.timezone));
  } else if (options.filter === "due_today") {
    const bounds = dayBounds(now, identity.timezone);
    params.push(bounds.start.toISOString(), bounds.end.toISOString());
    where.push(`t.due_at between $${params.length - 1} and $${params.length}`);
  } else if (options.filter === "blocked") {
    where.push("t.status = 'blocked'");
  }

  if (options.q) {
    params.push(`%${options.q.trim()}%`);
    where.push(`(t.title ilike $${params.length} or t.description ilike $${params.length})`);
  }

  const orderBy =
    options.sort === "updated"
      ? "t.updated_at desc"
      : options.sort === "created"
        ? "t.created_at desc"
        : `t.due_at asc nulls last, case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end asc, t.created_at desc`;

  const clause = where.join(" and ");
  const total = await db.query<{ count: string }>(`select count(*)::text as count from tasks t where ${clause}`, params);
  const rows = await db.query<TaskRow>(
    `${SELECT_TASK} where ${clause} order by ${orderBy} limit ${limit} offset ${offset}`,
    params,
  );

  const totalCount = Number(total.rows[0]?.count ?? 0);
  return {
    items: rows.rows.map((row) => mapTask(row, identity.timezone, now)),
    total: totalCount,
    nextCursor: offset + rows.rows.length < totalCount ? Buffer.from(String(offset + rows.rows.length)).toString("base64url") : null,
  };
}

export async function getTaskRow(db: Queryable, identity: Identity, taskId: string): Promise<TaskRow> {
  const rows = await db.query<TaskRow>(`${SELECT_TASK} where t.branch_id = $1 and t.id = $2 and t.deleted_at is null`, [
    identity.branchId,
    taskId,
  ]);
  const row = rows.rows[0];
  if (!row) throw ApiError.notFound("Task");
  return row;
}

async function assertOwnerInBranch(db: Queryable, identity: Identity, ownerId: string): Promise<void> {
  const rows = await db.query("select 1 from memberships where branch_id = $1 and user_id = $2", [
    identity.branchId,
    ownerId,
  ]);
  if (rows.rowCount === 0) throw ApiError.validation("That person is not in this branch", [{ path: "ownerId", message: "Unknown member" }]);
}

async function assertCategory(db: Queryable, identity: Identity, key: string): Promise<void> {
  const rows = await db.query("select 1 from categories where branch_id = $1 and key = $2", [identity.branchId, key]);
  if (rows.rowCount === 0) throw ApiError.validation("Unknown category", [{ path: "categoryKey", message: "No such category in this branch" }]);
}

function assertDueNotInPast(dueAt: string | null, precision: "date" | "datetime" | null, identity: Identity): void {
  if (!dueAt) return;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw ApiError.validation("Invalid due date", [{ path: "dueAt", message: "Not a date" }]);
  const today = toIsoDate(new Date(), identity.timezone);
  if (precision === "date") {
    const end = endOfDay(toIsoDate(due, identity.timezone), identity.timezone);
    if (end && end.getTime() < Date.now()) {
      throw ApiError.validation("Due date is in the past", [{ path: "dueAt", message: `Choose ${today} or later` }]);
    }
    return;
  }
  if (due.getTime() < Date.now() - 60_000) {
    throw ApiError.validation("Due date is in the past", [{ path: "dueAt", message: "Choose a future date and time" }]);
  }
}

async function notify(
  db: Queryable,
  identity: Identity,
  input: { userId: string; taskId: string; kind: string; title: string; body: string; dedupeKey?: string },
): Promise<void> {
  if (input.userId === identity.userId) return;
  // A function rather than a plain insert: see insert_notification in 005 for why the dedupe probe
  // needs privileges the request role deliberately does not have.
  await db.query("select insert_notification($1, $2, $3, $4, $5, $6, $7)", [
    identity.branchId,
    input.userId,
    input.taskId,
    input.kind,
    input.title,
    input.body,
    input.dedupeKey ?? null,
  ]);
}

export async function createTask(
  db: Queryable,
  identity: Identity,
  input: CreateTaskInput,
): Promise<TaskDto> {
  const ownerId = input.ownerId === undefined || input.ownerId === null ? null : input.ownerId;
  const explicitlyUnassigned = input.unassigned === true;

  if (ownerId && explicitlyUnassigned) {
    throw ApiError.validation("A task cannot be assigned and unassigned at once", [
      { path: "unassigned", message: "Remove unassigned or the owner" },
    ]);
  }
  if (!ownerId && !explicitlyUnassigned && identity.role !== "employee") {
    throw ApiError.validation("Choose an owner or mark the task unassigned", [
      { path: "ownerId", message: "Owner required unless explicitly unassigned" },
    ]);
  }

  const assignedOwner = ownerId ?? (explicitlyUnassigned ? null : identity.userId);
  if (assignedOwner && assignedOwner !== identity.userId && !can(identity.role, "task.assign")) {
    throw ApiError.forbidden("cannot_assign_others", "Only leads and managers can assign work to other people");
  }
  if (assignedOwner) await assertOwnerInBranch(db, identity, assignedOwner);
  if (input.categoryKey) await assertCategory(db, identity, input.categoryKey);

  const dueAt = input.dueAt ?? null;
  const precision = dueAt ? (input.duePrecision ?? "datetime") : null;
  assertDueNotInPast(dueAt, precision, identity);

  const description = (input.description ?? "").trim() || input.title.trim();

  const inserted = await db.query<TaskRow>(
    `insert into tasks (branch_id, title, description, priority, category_key, owner_id, unassigned_explicit,
                        due_at, due_precision, due_source_phrase, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$11)
     returning *`,
    [
      identity.branchId,
      input.title,
      description,
      input.priority,
      input.categoryKey ?? null,
      assignedOwner,
      assignedOwner === null,
      dueAt,
      precision,
      input.dueSourcePhrase ?? null,
      identity.userId,
    ],
  );
  const created = inserted.rows[0]!;

  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
     values ($1, $2, $3, 'created', $4, $5::jsonb)`,
    [
      identity.branchId,
      created.id,
      identity.userId,
      `Created “${created.title}”`,
      JSON.stringify({ title: created.title, status: created.status, ownerId: created.owner_id }),
    ],
  );

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.create",
    entityType: "task",
    entityId: created.id,
    after: { title: created.title, status: created.status, ownerId: created.owner_id, dueAt: iso(created.due_at) },
    reason: null,
  });

  if (assignedOwner) {
    await notify(db, identity, {
      userId: assignedOwner,
      taskId: created.id,
      kind: "assigned",
      title: "New task assigned to you",
      body: created.title,
    });
  }

  return mapTask({ ...created, owner_name: null }, identity.timezone);
}

export async function updateTask(
  db: Queryable,
  identity: Identity,
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskDto> {
  const current = await getTaskRow(db, identity, taskId);
  if (!canEditTask(identity.role, identity.userId, current)) {
    throw ApiError.forbidden("cannot_edit_task", "You can only edit your own tasks");
  }
  if (input.version !== current.version) {
    throw ApiError.conflict("This task changed while you were editing it", mapTask(current, identity.timezone));
  }
  if (current.status === "archived") {
    throw ApiError.forbidden("archived_read_only", "Archived tasks are read-only");
  }

  if (input.categoryKey) await assertCategory(db, identity, input.categoryKey);

  let ownerId = current.owner_id;
  if (input.ownerId !== undefined) {
    ownerId = input.ownerId;
    if (ownerId && ownerId !== identity.userId && !can(identity.role, "task.assign")) {
      throw ApiError.forbidden("cannot_assign_others", "Only leads and managers can reassign work");
    }
    if (ownerId) await assertOwnerInBranch(db, identity, ownerId);
  } else if (input.unassigned === true) {
    if (!can(identity.role, "task.assign") && current.owner_id !== identity.userId) {
      throw ApiError.forbidden("cannot_unassign", "Only leads and managers can unassign work");
    }
    ownerId = null;
  }

  if (input.dueAt !== undefined) assertDueNotInPast(input.dueAt, input.duePrecision ?? current.due_precision, identity);

  const dueAt = input.dueAt === undefined ? current.due_at : input.dueAt;
  const duePrecision =
    dueAt === null ? null : input.duePrecision ?? (input.dueAt === undefined ? current.due_precision : "datetime");

  const next = {
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    priority: input.priority ?? current.priority,
    category_key: input.categoryKey === undefined ? current.category_key : input.categoryKey,
    owner_id: ownerId,
    due_at: dueAt,
    due_precision: duePrecision,
  };

  const updated = await db.query<TaskRow>(
    `update tasks
        set title = $3, description = $4, priority = $5, category_key = $6, owner_id = $7,
            unassigned_explicit = $8, due_at = $9::timestamptz, due_precision = $10,
            updated_by = $11,
            blocked_reason = case when owner_id is distinct from $7 and status = 'blocked' then blocked_reason else blocked_reason end
      where branch_id = $1 and id = $2 and version = $12
      returning *`,
    [
      identity.branchId,
      taskId,
      next.title,
      next.description,
      next.priority,
      next.category_key,
      next.owner_id,
      next.owner_id === null,
      next.due_at as unknown as string | null,
      next.due_precision,
      identity.userId,
      current.version,
    ],
  );

  if (updated.rowCount === 0) {
    const fresh = await getTaskRow(db, identity, taskId);
    throw ApiError.conflict("This task changed while you were editing it", mapTask(fresh, identity.timezone));
  }

  const row = updated.rows[0]!;
  const before = {
    title: current.title,
    description: current.description,
    priority: current.priority,
    categoryKey: current.category_key,
    ownerId: current.owner_id,
    dueAt: iso(current.due_at),
    duePrecision: current.due_precision,
  };
  const after = {
    title: row.title,
    description: row.description,
    priority: row.priority,
    categoryKey: row.category_key,
    ownerId: row.owner_id,
    dueAt: iso(row.due_at),
    duePrecision: row.due_precision,
  };

  const changed = (Object.keys(after) as Array<keyof typeof after>).filter((key) => before[key] !== after[key]);
  if (changed.length) {
    const summary =
      before.ownerId !== after.ownerId
        ? "Reassigned the task"
        : `Updated ${changed.map((c) => c.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`)).join(", ")}`;
    await db.query(
      `insert into task_events (branch_id, task_id, actor_id, kind, summary, before, after, reason)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [identity.branchId, taskId, identity.userId, "updated", summary, JSON.stringify(before), JSON.stringify(after), input.reason ?? null],
    );
    await writeAudit(db, {
      branchId: identity.branchId,
      actorId: identity.userId,
      action: "task.update",
      entityType: "task",
      entityId: taskId,
      before,
      after,
      reason: input.reason ?? null,
    });
  }

  if (before.ownerId !== after.ownerId && after.ownerId) {
    await notify(db, identity, {
      userId: after.ownerId,
      taskId,
      kind: "reassigned",
      title: "A task was assigned to you",
      body: row.title,
      dedupeKey: `reassign:${taskId}:${row.version}`,
    });
  }

  return mapTask({ ...row, owner_name: null }, identity.timezone);
}

export async function transitionTask(
  db: Queryable,
  identity: Identity,
  taskId: string,
  input: TransitionTaskInput,
): Promise<TaskDto> {
  const current = await getTaskRow(db, identity, taskId);
  if (!canChangeStatus(identity.role, identity.userId, current)) {
    throw ApiError.forbidden("cannot_change_status", "You can only change the status of your own tasks");
  }
  if (input.version !== current.version) {
    throw ApiError.conflict("This task changed while you were updating it", mapTask(current, identity.timezone));
  }
  if (current.status === input.status) {
    throw ApiError.validation("That is already the status", [{ path: "status", message: `Already ${input.status}` }]);
  }
  if (!canTransition(current.status, input.status)) {
    throw ApiError.validation("That status change is not allowed", [
      {
        path: "status",
        message: `From ${current.status} you can move to ${allowedTransitions[current.status].join(", ") || "nothing"}`,
      },
    ]);
  }
  if (transitionNeedsManager(current.status, input.status) && identity.role !== "manager" && identity.role !== "workspace_admin") {
    throw ApiError.forbidden("reopen_needs_manager", "Only a manager can reopen closed work");
  }
  if (reasonRequiredFor[current.status].includes(input.status) && !input.reason?.trim()) {
    throw ApiError.validation("A reason is required for this change", [{ path: "reason", message: "Explain why" }]);
  }
  if (input.status === "blocked" && !input.blockedReason?.trim()) {
    throw ApiError.validation("Say what is blocking the task", [
      { path: "blockedReason", message: "A blocked reason is required" },
    ]);
  }

  const now = new Date();
  const completed = input.status === "done";
  const archived = input.status === "archived";

  const updated = await db.query<TaskRow>(
    `update tasks
        set status = $3,
            blocked_reason = case when $3 = 'blocked' then $4 else null end,
            completed_at = case when $3 = 'done' then $5::timestamptz else null end,
            completed_by = case when $3 = 'done' then $6::uuid else null end,
            archived_at = case when $3 = 'archived' then $5::timestamptz else archived_at end,
            updated_by = $6
      where branch_id = $1 and id = $2 and version = $7
      returning *`,
    [
      identity.branchId,
      taskId,
      input.status,
      input.blockedReason ?? null,
      now.toISOString(),
      identity.userId,
      current.version,
    ],
  );

  if (updated.rowCount === 0) {
    const fresh = await getTaskRow(db, identity, taskId);
    throw ApiError.conflict("This task changed while you were updating it", mapTask(fresh, identity.timezone));
  }

  const row = updated.rows[0]!;
  const before = { status: current.status, blockedReason: current.blocked_reason, completedAt: iso(current.completed_at) };
  const after = { status: row.status, blockedReason: row.blocked_reason, completedAt: iso(row.completed_at) };

  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, before, after, reason)
     values ($1,$2,$3,'status_changed',$4,$5::jsonb,$6::jsonb,$7)`,
    [
      identity.branchId,
      taskId,
      identity.userId,
      `Moved from ${current.status.replace("_", " ")} to ${input.status.replace("_", " ")}`,
      JSON.stringify(before),
      JSON.stringify(after),
      input.reason ?? input.blockedReason ?? null,
    ],
  );

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.status",
    entityType: "task",
    entityId: taskId,
    before,
    after,
    reason: input.reason ?? input.blockedReason ?? null,
  });

  if (row.owner_id && row.owner_id !== identity.userId && (completed || input.status === "blocked")) {
    await notify(db, identity, {
      userId: row.owner_id,
      taskId,
      kind: `task_${input.status}`,
      title: completed ? "Task completed" : "Task blocked",
      body: row.title,
      dedupeKey: `status:${taskId}:${row.version}`,
    });
  }

  if (completed && row.recurrence_rule) {
    await materialiseNextOccurrence(db, identity, row);
  }

  return mapTask({ ...row, owner_name: null }, identity.timezone);
}

/** Creates the next occurrence of a recurring task when the current one is completed. */
async function materialiseNextOccurrence(db: Queryable, identity: Identity, row: TaskRow): Promise<void> {
  const stepDays = row.recurrence_rule === "daily" ? 1 : row.recurrence_rule === "weekly" ? 7 : 30;
  const base = row.due_at ? new Date(row.due_at) : new Date();
  const nextDue = addDays(base, stepDays, identity.timezone);

  const inserted = await db.query<{ id: string }>(
    `insert into tasks (branch_id, title, description, priority, category_key, owner_id, due_at, due_precision,
                        recurrence_rule, recurrence_parent_id, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$11)
     returning id`,
    [
      identity.branchId,
      row.title,
      row.description,
      row.priority,
      row.category_key,
      row.owner_id,
      nextDue.toISOString(),
      row.due_precision ?? "date",
      row.recurrence_rule,
      row.id,
      identity.userId,
    ],
  );

  const nextId = inserted.rows[0]!.id;
  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
     values ($1,$2,$3,'recurred',$4,$5::jsonb)`,
    [
      identity.branchId,
      nextId,
      identity.userId,
      `Created the next occurrence of “${row.title}”`,
      JSON.stringify({ recurrenceParentId: row.id, dueAt: nextDue.toISOString() }),
    ],
  );
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.recur",
    entityType: "task",
    entityId: nextId,
    after: { recurrenceParentId: row.id, dueAt: nextDue.toISOString() },
  });
}

/**
 * Reassigns (or unassigns) a batch of tasks in one call. Every task still keeps its own event and
 * audit row, so a bulk action stays as traceable as doing them one at a time.
 */
export async function bulkReassign(
  db: Queryable,
  identity: Identity,
  input: BulkReassignInput,
): Promise<BulkReassignResponse> {
  if (!can(identity.role, "task.assign")) {
    throw ApiError.forbidden("cannot_bulk_assign", "Only leads and managers can reassign work in bulk");
  }
  if (input.ownerId) await assertOwnerInBranch(db, identity, input.ownerId);

  const requested = [...new Set(input.taskIds)];
  const before = await db.query<{ id: string; title: string; owner_id: string | null; status: TaskStatus }>(
    `select id, title, owner_id, status from tasks
      where branch_id = $1 and id = any($2::uuid[]) and deleted_at is null and status <> 'archived'`,
    [identity.branchId, requested],
  );
  if (before.rowCount === 0) throw ApiError.notFound("Task");

  const updated = await db.query<TaskRow>(
    `update tasks
        set owner_id = $3, unassigned_explicit = $4, updated_by = $2
      where branch_id = $1 and id = any($5::uuid[]) and deleted_at is null and status <> 'archived'
      returning *`,
    [identity.branchId, identity.userId, input.ownerId, input.ownerId === null, requested],
  );

  const summary = input.ownerId === null ? "Unassigned in bulk" : "Reassigned in bulk";
  for (const row of updated.rows) {
    await db.query(
      `insert into task_events (branch_id, task_id, actor_id, kind, summary, before, after, reason)
       values ($1,$2,$3,'reassigned',$4,$5::jsonb,$6::jsonb,$7)`,
      [
        identity.branchId,
        row.id,
        identity.userId,
        summary,
        JSON.stringify({ ownerId: before.rows.find((item) => item.id === row.id)?.owner_id ?? null }),
        JSON.stringify({ ownerId: row.owner_id }),
        input.reason ?? null,
      ],
    );
    await writeAudit(db, {
      branchId: identity.branchId,
      actorId: identity.userId,
      action: "task.bulk_assign",
      entityType: "task",
      entityId: row.id,
      before: { ownerId: before.rows.find((item) => item.id === row.id)?.owner_id ?? null },
      after: { ownerId: row.owner_id, batchSize: updated.rows.length },
      reason: input.reason ?? null,
    });
  }

  // One notification per new owner, not one per task: a shift change is a single interruption.
  if (input.ownerId && input.ownerId !== identity.userId) {
    const names = updated.rows.map((row) => row.title);
    await notify(db, identity, {
      userId: input.ownerId,
      taskId: updated.rows[0]!.id,
      kind: "reassigned",
      title: `${names.length} task(s) moved to you`,
      body: names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : ""),
      dedupeKey: `bulk:${randomUUID()}`,
    });
  }

  return {
    updated: updated.rows.length,
    skipped: requested.length - updated.rows.length,
    taskIds: updated.rows.map((row) => row.id),
  };
}

export async function softDeleteTask(db: Queryable, identity: Identity, taskId: string): Promise<void> {
  const current = await getTaskRow(db, identity, taskId);
  if (!can(identity.role, "task.archive")) {
    throw ApiError.forbidden("cannot_delete", "Only managers can remove tasks");
  }
  await db.query("update tasks set deleted_at = now(), updated_by = $3 where branch_id = $1 and id = $2", [
    identity.branchId,
    taskId,
    identity.userId,
  ]);
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.delete",
    entityType: "task",
    entityId: taskId,
    before: { title: current.title, status: current.status },
  });
}

export async function dashboard(db: Queryable, identity: Identity): Promise<DashboardResponse> {
  const now = new Date();
  const bounds = dayBounds(now, identity.timezone);
  const today = toIsoDate(now, identity.timezone);

  const counts = await db.query<Record<string, string>>(
    `select
       count(*) filter (where due_at between $2 and $3) as due_today,
       count(*) filter (where due_at is not null and status in ('open','in_progress','blocked')
                          and case when due_precision = 'date' then due_at::date < $4::date else due_at < now() end) as overdue,
       count(*) filter (where status = 'blocked') as blocked,
       count(*) filter (where status = 'in_progress') as in_progress,
       count(*) filter (where owner_id = $5) as mine,
       count(*) filter (where owner_id is null) as unassigned
     from tasks
     where branch_id = $1 and deleted_at is null and status not in ('done','cancelled','archived')`,
    [identity.branchId, bounds.start.toISOString(), bounds.end.toISOString(), today, identity.userId],
  );
  const row = counts.rows[0] ?? {};

  const upcoming = await db.query<TaskRow>(
    `${SELECT_TASK}
      where t.branch_id = $1 and t.deleted_at is null and t.status not in ('done','cancelled','archived')
        and t.due_at is not null
      order by t.due_at asc
      limit 5`,
    [identity.branchId],
  );

  const load = await db.query<{ owner_id: string | null; owner_name: string | null; open: string; overdue: string }>(
    `select t.owner_id, u.name as owner_name,
            count(*)::text as open,
            count(*) filter (where t.due_at is not null and t.status in ('open','in_progress','blocked')
                               and case when t.due_precision = 'date' then t.due_at::date < $2::date else t.due_at < now() end)::text as overdue
       from tasks t
       left join users u on u.id = t.owner_id
      where t.branch_id = $1 and t.deleted_at is null and t.status not in ('done','cancelled','archived')
      group by t.owner_id, u.name
      order by count(*) desc`,
    [identity.branchId, today],
  );

  return {
    counts: {
      dueToday: Number(row.due_today ?? 0),
      overdue: Number(row.overdue ?? 0),
      blocked: Number(row.blocked ?? 0),
      inProgress: Number(row.in_progress ?? 0),
      mine: Number(row.mine ?? 0),
      unassigned: Number(row.unassigned ?? 0),
    },
    upcoming: upcoming.rows.map((r) => mapTask(r, identity.timezone, now)),
    teamLoad: load.rows.map((r) => ({
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      open: Number(r.open),
      overdue: Number(r.overdue),
    })),
  };
}

export { priorityRank, randomUUID };
