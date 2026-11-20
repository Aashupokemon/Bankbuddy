import {
  canEditTask,
  type ChecklistItemDto,
  type ChecklistResponse,
  type CreateChecklistItemInput,
  type UpdateChecklistItemInput,
} from "@bankbuddy/contracts";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import type { Identity } from "./auth.ts";
import { ApiError } from "./http.ts";
import { getTaskRow } from "./tasks.ts";

/**
 * The ordered steps inside one task.
 *
 * Anyone in the branch may read a checklist they can already read the task from, but only people
 * who may edit the task can change it, and never after it has been archived. Every change writes a
 * task event and an audit row, like the rest of the task mutations.
 */

interface ChecklistRow {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  position: number;
  completed_at: Date | string | null;
  created_at: Date | string;
  attachment_id?: string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function mapItem(row: ChecklistRow): ChecklistItemDto {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    done: row.done,
    position: row.position,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    attachmentId: row.attachment_id ?? null,
  };
}

async function assertMayEditChecklist(db: Queryable, identity: Identity, taskId: string): Promise<void> {
  const task = await getTaskRow(db, identity, taskId);
  if (!canEditTask(identity.role, identity.userId, task)) {
    throw ApiError.forbidden("cannot_edit_checklist", "You can only change the checklist on your own tasks");
  }
  if (task.status === "archived") {
    throw ApiError.forbidden("archived_read_only", "Archived tasks are read-only");
  }
}

async function event(
  db: Queryable,
  identity: Identity,
  taskId: string,
  summary: string,
  after: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
     values ($1, $2, $3, 'checklist', $4, $5::jsonb)`,
    [identity.branchId, taskId, identity.userId, summary, JSON.stringify(after)],
  );
}

export async function listChecklist(
  db: Queryable,
  identity: Identity,
  taskId: string,
): Promise<ChecklistResponse> {
  // Reading the task first keeps the 404 behaviour identical to the rest of the task routes.
  await getTaskRow(db, identity, taskId);
  // The attachment id comes along so the checklist can mark a step as evidenced without a second
  // request per row; the bytes themselves are only fetched when someone opens the photo.
  const rows = await db.query<ChecklistRow>(
    `select c.id, c.task_id, c.title, c.done, c.position, c.completed_at, c.created_at,
            (select a.id from task_attachments a where a.checklist_item_id = c.id limit 1) as attachment_id
       from task_checklist_items c
      where c.branch_id = $1 and c.task_id = $2
      order by c.position asc, c.created_at asc`,
    [identity.branchId, taskId],
  );
  const items = rows.rows.map(mapItem);
  return { items, done: items.filter((item) => item.done).length, total: items.length };
}

export async function addChecklistItem(
  db: Queryable,
  identity: Identity,
  taskId: string,
  input: CreateChecklistItemInput,
): Promise<ChecklistItemDto> {
  await assertMayEditChecklist(db, identity, taskId);

  const inserted = await db.query<ChecklistRow>(
    `insert into task_checklist_items (branch_id, task_id, title, position, created_by)
     values ($1, $2, $3,
             coalesce((select max(position) + 1 from task_checklist_items where task_id = $2), 0),
             $4)
     returning id, task_id, title, done, position, completed_at, created_at`,
    [identity.branchId, taskId, input.title, identity.userId],
  );
  const item = mapItem({ ...inserted.rows[0]!, attachment_id: null });

  await event(db, identity, taskId, `Added the checklist step “${item.title}”`, { checklistItemId: item.id });
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.checklist.add",
    entityType: "task",
    entityId: taskId,
    after: { checklistItemId: item.id, title: item.title },
  });
  return item;
}

async function loadItem(db: Queryable, identity: Identity, taskId: string, itemId: string): Promise<ChecklistRow> {
  const rows = await db.query<ChecklistRow>(
    `select c.id, c.task_id, c.title, c.done, c.position, c.completed_at, c.created_at,
            (select a.id from task_attachments a where a.checklist_item_id = c.id limit 1) as attachment_id
       from task_checklist_items c
      where c.branch_id = $1 and c.task_id = $2 and c.id = $3`,
    [identity.branchId, taskId, itemId],
  );
  const row = rows.rows[0];
  if (!row) throw ApiError.notFound("Checklist step");
  return row;
}

export async function updateChecklistItem(
  db: Queryable,
  identity: Identity,
  taskId: string,
  itemId: string,
  input: UpdateChecklistItemInput,
): Promise<ChecklistItemDto> {
  await assertMayEditChecklist(db, identity, taskId);
  const current = await loadItem(db, identity, taskId, itemId);

  const title = input.title ?? current.title;
  const done = input.done ?? current.done;
  const position = input.position ?? current.position;

  await db.query(
    `update task_checklist_items
        set title = $4, done = $5, position = $6,
            completed_at = case when $5 then coalesce(completed_at, now()) else null end,
            updated_at = now()
      where branch_id = $1 and task_id = $2 and id = $3`,
    [identity.branchId, taskId, itemId, title, done, position],
  );
  // Re-read rather than `returning`: the row also carries its attachment id, which lives elsewhere.
  const item = mapItem(await loadItem(db, identity, taskId, itemId));

  const summary =
    current.done !== item.done
      ? item.done
        ? `Checked off “${item.title}”`
        : `Reopened the checklist step “${item.title}”`
      : current.title !== item.title
        ? `Renamed the checklist step “${current.title}”`
        : `Reordered the checklist step “${item.title}”`;

  await event(db, identity, taskId, summary, {
    checklistItemId: item.id,
    before: { title: current.title, done: current.done, position: current.position },
    after: { title: item.title, done: item.done, position: item.position },
  });
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.checklist.update",
    entityType: "task",
    entityId: taskId,
    before: { title: current.title, done: current.done, position: current.position },
    after: { title: item.title, done: item.done, position: item.position },
  });
  return item;
}

export async function removeChecklistItem(
  db: Queryable,
  identity: Identity,
  taskId: string,
  itemId: string,
): Promise<void> {
  await assertMayEditChecklist(db, identity, taskId);
  const current = await loadItem(db, identity, taskId, itemId);

  await db.query("delete from task_checklist_items where branch_id = $1 and task_id = $2 and id = $3", [
    identity.branchId,
    taskId,
    itemId,
  ]);

  await event(db, identity, taskId, `Removed the checklist step “${current.title}”`, {
    checklistItemId: current.id,
    before: { title: current.title, done: current.done },
  });
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.checklist.remove",
    entityType: "task",
    entityId: taskId,
    before: { title: current.title, done: current.done },
  });
}
