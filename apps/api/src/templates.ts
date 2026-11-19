import {
  can,
  type CreateTemplateInput,
  type RunTemplatesInput,
  type RunTemplatesResponse,
  type TaskDto,
  type TaskTemplateDto,
  type UpdateTemplateInput,
} from "@bankbuddy/contracts";
import { endOfDay, resolveWallTime, startOfDay, toIsoDate, wallTimeFromIsoDate } from "@bankbuddy/date";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import { ApiError } from "./http.ts";
import type { Identity } from "./auth.ts";
import { getTaskRow, mapTask } from "./tasks.ts";

/**
 * Recurring branch chores: "open the branch", "reconcile the vault", "weekly dormant-account review".
 * A template is only a definition — nothing is created until the materialiser runs for a date, and
 * the unique (template_id, occurrence_on) index makes a repeated run a no-op rather than duplicates.
 */

export interface TemplateRow {
  id: string;
  branch_id: string;
  title: string;
  description: string;
  priority: TaskDto["priority"];
  category_key: string | null;
  owner_id: string | null;
  owner_name?: string | null;
  cadence: "daily" | "weekly";
  weekday: number | null;
  due_time: string;
  active: boolean;
  last_run_on: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

const dateOnly = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};

export function mapTemplate(row: TemplateRow): TaskTemplateDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    categoryKey: row.category_key,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? null,
    cadence: row.cadence,
    weekday: row.weekday,
    dueTime: row.due_time,
    active: row.active,
    lastRunOn: dateOnly(row.last_run_on),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_TEMPLATE = `
  select tp.*, u.name as owner_name
    from task_templates tp
    left join users u on u.id = tp.owner_id
`;

/** Weekday of a branch-local date, with 0 = Sunday to match Postgres and the client chips. */
export function weekdayOf(datePart: string): number | null {
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getUTCDay();
}

/** Resolves a branch-local date + wall-clock time into an instant, tolerating a DST gap. */
export function instantFor(datePart: string, dueTime: string, timeZone: string): Date | null {
  const wall = wallTimeFromIsoDate(datePart);
  if (!wall) return null;
  const [hour, minute] = dueTime.split(":").map(Number);
  const resolved = resolveWallTime({ ...wall, hour: hour ?? 9, minute: minute ?? 0, second: 0 }, timeZone);
  return resolved.instant ?? startOfDay(datePart, timeZone);
}

function assertTemplateManager(identity: Identity): void {
  if (!can(identity.role, "task.assign")) {
    throw ApiError.forbidden("cannot_manage_templates", "Only leads and managers can manage recurring chores");
  }
}

async function assertOwnerInBranch(db: Queryable, identity: Identity, ownerId: string): Promise<void> {
  const rows = await db.query("select 1 from memberships where branch_id = $1 and user_id = $2", [
    identity.branchId,
    ownerId,
  ]);
  if (rows.rowCount === 0) {
    throw ApiError.validation("That person is not in this branch", [{ path: "ownerId", message: "Unknown member" }]);
  }
}

async function assertCategory(db: Queryable, identity: Identity, key: string): Promise<void> {
  const rows = await db.query("select 1 from categories where branch_id = $1 and key = $2", [identity.branchId, key]);
  if (rows.rowCount === 0) {
    throw ApiError.validation("Unknown category", [
      { path: "categoryKey", message: "No such category in this branch" },
    ]);
  }
}

export async function listTemplates(db: Queryable, identity: Identity): Promise<TaskTemplateDto[]> {
  const rows = await db.query<TemplateRow>(
    `${SELECT_TEMPLATE} where tp.branch_id = $1 order by tp.active desc, tp.cadence, tp.title`,
    [identity.branchId],
  );
  return rows.rows.map(mapTemplate);
}

async function getTemplateRow(db: Queryable, identity: Identity, templateId: string): Promise<TemplateRow> {
  const rows = await db.query<TemplateRow>(`${SELECT_TEMPLATE} where tp.branch_id = $1 and tp.id = $2`, [
    identity.branchId,
    templateId,
  ]);
  const row = rows.rows[0];
  if (!row) throw ApiError.notFound("Recurring chore");
  return row;
}

export async function createTemplate(
  db: Queryable,
  identity: Identity,
  input: CreateTemplateInput,
): Promise<TaskTemplateDto> {
  assertTemplateManager(identity);
  if (input.ownerId) await assertOwnerInBranch(db, identity, input.ownerId);
  if (input.categoryKey) await assertCategory(db, identity, input.categoryKey);

  const inserted = await db.query<TemplateRow>(
    `insert into task_templates (branch_id, title, description, priority, category_key, owner_id,
                                 cadence, weekday, due_time, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning *`,
    [
      identity.branchId,
      input.title,
      (input.description ?? "").trim() || input.title.trim(),
      input.priority,
      input.categoryKey ?? null,
      input.ownerId ?? null,
      input.cadence,
      input.cadence === "weekly" ? (input.weekday ?? null) : null,
      input.dueTime,
      identity.userId,
    ],
  );
  const row = inserted.rows[0]!;

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "template.create",
    entityType: "task_template",
    entityId: row.id,
    after: { title: row.title, cadence: row.cadence, weekday: row.weekday, dueTime: row.due_time },
  });

  return mapTemplate(row);
}

export async function updateTemplate(
  db: Queryable,
  identity: Identity,
  templateId: string,
  input: UpdateTemplateInput,
): Promise<TaskTemplateDto> {
  assertTemplateManager(identity);
  const current = await getTemplateRow(db, identity, templateId);
  if (input.ownerId) await assertOwnerInBranch(db, identity, input.ownerId);
  if (input.categoryKey) await assertCategory(db, identity, input.categoryKey);

  const cadence = input.cadence ?? current.cadence;
  const weekday =
    cadence === "weekly"
      ? input.weekday !== undefined
        ? input.weekday
        : current.weekday
      : null;

  const updated = await db.query<TemplateRow>(
    `update task_templates
        set title = $3, description = $4, priority = $5, category_key = $6, owner_id = $7,
            cadence = $8, weekday = $9, due_time = $10, active = $11, updated_at = now()
      where branch_id = $1 and id = $2
      returning *`,
    [
      identity.branchId,
      templateId,
      input.title ?? current.title,
      input.description ?? current.description,
      input.priority ?? current.priority,
      input.categoryKey === undefined ? current.category_key : input.categoryKey,
      input.ownerId === undefined ? current.owner_id : input.ownerId,
      cadence,
      weekday,
      input.dueTime ?? current.due_time,
      input.active ?? current.active,
    ],
  );

  const row = updated.rows[0]!;
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "template.update",
    entityType: "task_template",
    entityId: templateId,
    before: { title: current.title, active: current.active, cadence: current.cadence },
    after: { title: row.title, active: row.active, cadence: row.cadence },
  });

  return mapTemplate(row);
}

/**
 * Creates today's (or `input.date`'s) occurrences for every chore that is due. Idempotent: a second
 * run for the same date reports the chores as skipped instead of creating them again.
 */
export async function materialiseTemplates(
  db: Queryable,
  identity: Identity,
  input: RunTemplatesInput = {},
): Promise<RunTemplatesResponse> {
  assertTemplateManager(identity);

  const runDate = input.date ?? toIsoDate(new Date(), identity.timezone);
  const weekday = weekdayOf(runDate);
  const end = endOfDay(runDate, identity.timezone);
  if (!weekday || !end) {
    throw ApiError.validation("Not a real date", [{ path: "date", message: "Use YYYY-MM-DD" }]);
  }

  const due = await db.query<TemplateRow>(
    `${SELECT_TEMPLATE}
      where tp.branch_id = $1 and tp.active
        and (tp.cadence = 'daily' or tp.weekday = $2)
      order by tp.cadence, tp.title`,
    [identity.branchId, weekday],
  );

  const created: TaskDto[] = [];
  let skipped = 0;

  for (const template of due.rows) {
    const dueAt = instantFor(runDate, template.due_time, identity.timezone);
    if (!dueAt) {
      skipped += 1;
      continue;
    }

    const inserted = await db.query<{ id: string }>(
      `insert into tasks (branch_id, title, description, priority, category_key, owner_id, unassigned_explicit,
                          due_at, due_precision, template_id, occurrence_on, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,'datetime',$9,$10::date,$11,$11)
       on conflict (template_id, occurrence_on) do nothing
       returning id`,
      [
        identity.branchId,
        template.title,
        template.description,
        template.priority,
        template.category_key,
        template.owner_id,
        template.owner_id === null,
        dueAt.toISOString(),
        template.id,
        runDate,
        identity.userId,
      ],
    );

    const id = inserted.rows[0]?.id;
    if (!id) {
      // Someone (or an earlier run) already created this chore for today.
      skipped += 1;
      continue;
    }

    await db.query(
      `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
       values ($1,$2,$3,'created',$4,$5::jsonb)`,
      [
        identity.branchId,
        id,
        identity.userId,
        `Created “${template.title}” from a recurring chore`,
        JSON.stringify({ templateId: template.id, occurrenceOn: runDate }),
      ],
    );

    await writeAudit(db, {
      branchId: identity.branchId,
      actorId: identity.userId,
      action: "task.create",
      entityType: "task",
      entityId: id,
      after: { title: template.title, templateId: template.id, occurrenceOn: runDate, dueAt: dueAt.toISOString() },
      reason: "Recurring chore",
    });

    if (template.owner_id && template.owner_id !== identity.userId) {
      await db.query("select insert_notification($1, $2, $3, 'assigned', $4, $5, $6)", [
        identity.branchId,
        template.owner_id,
        id,
        "Today's branch chore is on your list",
        template.title,
        `chore:${template.id}:${runDate}`,
      ]);
    }

    created.push(mapTask(await getTaskRow(db, identity, id), identity.timezone));
  }

  await db.query(
    `update task_templates set last_run_on = $3::date, updated_at = now()
      where branch_id = $1 and id = any($2::uuid[])`,
    [identity.branchId, due.rows.map((row) => row.id), runDate],
  );

  if (created.length > 0) {
    await writeAudit(db, {
      branchId: identity.branchId,
      actorId: identity.userId,
      action: "template.run",
      entityType: "branch",
      entityId: null,
      after: { date: runDate, created: created.length, skipped },
    });
  }

  return { date: runDate, created: created.length, skipped, items: created };
}
