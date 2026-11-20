import {
  can,
  type CreateCommentInput,
  type ProposeHandoverInput,
  type RespondHandoverInput,
} from "@bankbuddy/contracts";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import { ApiError } from "./http.ts";
import type { Identity } from "./auth.ts";

export interface CommentDto {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export async function listComments(db: Queryable, identity: Identity, taskId: string): Promise<CommentDto[]> {
  const rows = await db.query<{
    id: string;
    task_id: string;
    author_id: string;
    author_name: string;
    body: string;
    created_at: Date | string;
  }>(
    `select c.id, c.task_id, c.author_id, u.name as author_name, c.body, c.created_at
       from task_comments c
       join users u on u.id = c.author_id
      where c.branch_id = $1 and c.task_id = $2 and c.deleted_at is null
      order by c.created_at asc`,
    [identity.branchId, taskId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function addComment(
  db: Queryable,
  identity: Identity,
  taskId: string,
  input: CreateCommentInput,
): Promise<CommentDto> {
  const exists = await db.query("select 1 from tasks where branch_id = $1 and id = $2 and deleted_at is null", [
    identity.branchId,
    taskId,
  ]);
  if (exists.rowCount === 0) throw ApiError.notFound("Task");

  const inserted = await db.query<{ id: string; created_at: Date | string }>(
    `insert into task_comments (branch_id, task_id, author_id, body)
     values ($1, $2, $3, $4) returning id, created_at`,
    [identity.branchId, taskId, identity.userId, input.body],
  );
  const row = inserted.rows[0]!;

  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
     values ($1,$2,$3,'commented','Added a comment',$4::jsonb)`,
    [identity.branchId, taskId, identity.userId, JSON.stringify({ commentId: row.id })],
  );

  // "@Name" in a comment is how a branch actually pulls someone in; turning it into a notification
  // row is cheaper and less disruptive than inventing a chat feature.
  const mentioned = await notifyMentions(db, identity, taskId, input.body, row.id);

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "comment.create",
    entityType: "task_comment",
    entityId: row.id,
    after: { taskId, bodyLength: input.body.length, mentioned },
  });

  return {
    id: row.id,
    taskId,
    authorId: identity.userId,
    authorName: identity.name,
    body: input.body,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Resolves @mentions against real branch members and notifies each one at most once per comment. */
async function notifyMentions(
  db: Queryable,
  identity: Identity,
  taskId: string,
  body: string,
  commentId: string,
): Promise<string[]> {
  // Two words at most ("@Priya Menon", "@Meera"), which covers how people are actually named here.
  const candidates = [...body.matchAll(/@([A-Za-z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)?)/g)].map((match) =>
    match[1]!.trim().toLowerCase(),
  );
  if (candidates.length === 0) return [];

  const members = await db.query<{ id: string; name: string }>(
    `select u.id, u.name from memberships m join users u on u.id = m.user_id where m.branch_id = $1`,
    [identity.branchId],
  );
  const task = await db.query<{ title: string }>("select title from tasks where branch_id = $1 and id = $2", [
    identity.branchId,
    taskId,
  ]);
  const title = task.rows[0]?.title ?? "a task";

  const notified: string[] = [];
  for (const member of members.rows) {
    if (member.id === identity.userId) continue;
    if (!candidates.includes(member.name.toLowerCase())) continue;
    await db.query("select insert_notification($1,$2,$3,'mentioned',$4,$5,$6)", [
      identity.branchId,
      member.id,
      taskId,
      `${identity.name} mentioned you`,
      `${title}: ${body.slice(0, 160)}`,
      `mention:${commentId}:${member.id}`,
    ]);
    notified.push(member.id);
  }
  return notified;
}

export interface DependencyDto {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  dependsOnTitle: string;
  dependsOnStatus: string;
}

export async function listDependencies(
  db: Queryable,
  identity: Identity,
  taskId: string,
): Promise<{ blocking: DependencyDto[]; blockedBy: DependencyDto[] }> {
  const outgoing = await db.query<{
    id: string;
    task_id: string;
    depends_on_task_id: string;
    title: string;
    status: string;
  }>(
    `select d.id, d.task_id, d.depends_on_task_id, t.title, t.status
       from task_dependencies d
       join tasks t on t.id = d.depends_on_task_id
      where d.branch_id = $1 and d.task_id = $2`,
    [identity.branchId, taskId],
  );
  const incoming = await db.query<{
    id: string;
    task_id: string;
    depends_on_task_id: string;
    title: string;
    status: string;
  }>(
    `select d.id, d.task_id, d.depends_on_task_id, t.title, t.status
       from task_dependencies d
       join tasks t on t.id = d.task_id
      where d.branch_id = $1 and d.depends_on_task_id = $2`,
    [identity.branchId, taskId],
  );

  const map = (row: { id: string; task_id: string; depends_on_task_id: string; title: string; status: string }, outgoingRow: boolean): DependencyDto => ({
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    dependsOnTitle: row.title,
    dependsOnStatus: row.status,
  });

  return {
    blocking: outgoing.rows.map((row) => map(row, true)),
    blockedBy: incoming.rows.map((row) => map(row, false)),
  };
}

export async function addDependency(
  db: Queryable,
  identity: Identity,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  if (!can(identity.role, "dependency.manage")) {
    throw ApiError.forbidden("cannot_manage_dependencies", "Only leads and managers can link dependencies");
  }
  if (taskId === dependsOnTaskId) {
    throw ApiError.validation("A task cannot depend on itself", [
      { path: "dependsOnTaskId", message: "Pick a different task" },
    ]);
  }

  const both = await db.query<{ id: string }>(
    "select id from tasks where branch_id = $1 and id = any($2::uuid[]) and deleted_at is null",
    [identity.branchId, [taskId, dependsOnTaskId]],
  );
  if (both.rowCount !== 2) throw ApiError.notFound("Task");

  // Walk the existing graph from the prospective dependency back to this task.
  const cycle = await db.query<{ id: string }>(
    `with recursive reach as (
       select depends_on_task_id as id from task_dependencies where task_id = $1
       union
       select d.depends_on_task_id from task_dependencies d join reach r on d.task_id = r.id
     )
     select id from reach where id = $2 limit 1`,
    [dependsOnTaskId, taskId],
  );
  if (cycle.rowCount > 0) {
    throw ApiError.validation("That would create a circular dependency", [
      { path: "dependsOnTaskId", message: "These tasks would depend on each other" },
    ]);
  }

  await db.query(
    `insert into task_dependencies (branch_id, task_id, depends_on_task_id, created_by)
     values ($1,$2,$3,$4) on conflict (task_id, depends_on_task_id) do nothing`,
    [identity.branchId, taskId, dependsOnTaskId, identity.userId],
  );

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "dependency.create",
    entityType: "task",
    entityId: taskId,
    after: { dependsOnTaskId },
  });
}

export async function removeDependency(db: Queryable, identity: Identity, taskId: string, dependencyId: string): Promise<void> {
  if (!can(identity.role, "dependency.manage")) {
    throw ApiError.forbidden("cannot_manage_dependencies", "Only leads and managers can unlink dependencies");
  }
  const deleted = await db.query("delete from task_dependencies where branch_id = $1 and task_id = $2 and id = $3", [
    identity.branchId,
    taskId,
    dependencyId,
  ]);
  if (deleted.rowCount === 0) throw ApiError.notFound("Dependency");
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "dependency.delete",
    entityType: "task",
    entityId: taskId,
    before: { dependencyId },
  });
}

export interface HandoverDto {
  id: string;
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  note: string | null;
  scope: "tasks" | "shift";
  status: "proposed" | "accepted" | "declined" | "cancelled";
  createdAt: string;
  respondedAt: string | null;
  tasks: Array<{ id: string; title: string; status: string }>;
}

export async function listHandovers(db: Queryable, identity: Identity): Promise<HandoverDto[]> {
  const rows = await db.query<{
    id: string;
    from_user_id: string;
    from_name: string;
    to_user_id: string;
    to_name: string;
    note: string | null;
    scope: "tasks" | "shift";
    status: HandoverDto["status"];
    created_at: Date | string;
    responded_at: Date | string | null;
  }>(
    `select h.id, h.from_user_id, f.name as from_name, h.to_user_id, t.name as to_name,
            h.note, h.scope, h.status, h.created_at, h.responded_at
       from handovers h
       join users f on f.id = h.from_user_id
       join users t on t.id = h.to_user_id
      where h.branch_id = $1
      order by h.created_at desc
      limit 50`,
    [identity.branchId],
  );

  const result: HandoverDto[] = [];
  for (const row of rows.rows) {
    const tasks = await db.query<{ id: string; title: string; status: string }>(
      `select t.id, t.title, t.status from handover_tasks ht join tasks t on t.id = ht.task_id where ht.handover_id = $1`,
      [row.id],
    );
    result.push({
      id: row.id,
      fromUserId: row.from_user_id,
      fromName: row.from_name,
      toUserId: row.to_user_id,
      toName: row.to_name,
      note: row.note,
      scope: row.scope,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
      tasks: tasks.rows,
    });
  }
  return result;
}

export async function proposeHandover(
  db: Queryable,
  identity: Identity,
  input: ProposeHandoverInput,
): Promise<HandoverDto> {
  if (input.toUserId === identity.userId) {
    throw ApiError.validation("Pick someone else", [{ path: "toUserId", message: "You cannot hand over to yourself" }]);
  }
  const target = await db.query("select 1 from memberships where branch_id = $1 and user_id = $2", [
    identity.branchId,
    input.toUserId,
  ]);
  if (target.rowCount === 0) throw ApiError.validation("That person is not in this branch", [{ path: "toUserId", message: "Unknown member" }]);

  const scope = input.scope ?? "tasks";
  // A whole-shift handover is resolved here, from the database, so the device cannot widen or narrow
  // the set of tasks it covers.
  const taskIds =
    scope === "shift"
      ? (
          await db.query<{ id: string }>(
            `select id from tasks
              where branch_id = $1 and owner_id = $2 and deleted_at is null
                and status in ('open','in_progress','blocked')
              order by due_at asc nulls last`,
            [identity.branchId, identity.userId],
          )
        ).rows.map((row) => row.id)
      : (input.taskIds ?? []);

  if (taskIds.length === 0) {
    throw ApiError.validation(
      scope === "shift" ? "You have no open work to hand over" : "Pick at least one task",
      [{ path: scope === "shift" ? "scope" : "taskIds", message: "Nothing to hand over" }],
    );
  }

  const tasks = await db.query<{ id: string; owner_id: string | null }>(
    "select id, owner_id from tasks where branch_id = $1 and id = any($2::uuid[]) and deleted_at is null",
    [identity.branchId, taskIds],
  );
  if (tasks.rowCount !== taskIds.length) throw ApiError.notFound("Task");
  if (!can(identity.role, "task.assign") && tasks.rows.some((t) => t.owner_id !== identity.userId)) {
    throw ApiError.forbidden("cannot_hand_over", "You can only hand over work you own");
  }

  const inserted = await db.query<{ id: string }>(
    `insert into handovers (branch_id, from_user_id, to_user_id, note, scope) values ($1,$2,$3,$4,$5) returning id`,
    [identity.branchId, identity.userId, input.toUserId, input.note ?? null, scope],
  );
  const handoverId = inserted.rows[0]!.id;

  for (const taskId of taskIds) {
    await db.query("insert into handover_tasks (handover_id, task_id) values ($1, $2) on conflict do nothing", [
      handoverId,
      taskId,
    ]);
  }

  await db.query(
    `insert into notifications (branch_id, user_id, kind, title, body, dedupe_key)
     values ($1,$2,'handover','Shift handover to review',$3,$4)`,
    [
      identity.branchId,
      input.toUserId,
      scope === "shift"
        ? `${identity.name} handed over the whole shift (${taskIds.length} task(s))`
        : `${identity.name} handed over ${taskIds.length} task(s)`,
      `handover:${handoverId}`,
    ],
  );

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "handover.propose",
    entityType: "handover",
    entityId: handoverId,
    after: { toUserId: input.toUserId, scope, taskIds },
  });

  const list = await listHandovers(db, identity);
  return list.find((h) => h.id === handoverId)!;
}

export async function respondHandover(
  db: Queryable,
  identity: Identity,
  handoverId: string,
  input: RespondHandoverInput,
): Promise<HandoverDto> {
  const rows = await db.query<{ id: string; status: string; from_user_id: string; to_user_id: string }>(
    "select id, status, from_user_id, to_user_id from handovers where branch_id = $1 and id = $2",
    [identity.branchId, handoverId],
  );
  const handover = rows.rows[0];
  if (!handover) throw ApiError.notFound("Handover");
  if (handover.to_user_id !== identity.userId) {
    throw ApiError.forbidden("not_your_handover", "Only the person receiving the handover can respond");
  }
  if (handover.status !== "proposed") {
    throw ApiError.validation("This handover was already answered", [{ path: "decision", message: `Status is ${handover.status}` }]);
  }

  await db.query("update handovers set status = $2, responded_at = now() where id = $1", [
    handoverId,
    input.decision === "accept" ? "accepted" : "declined",
  ]);

  if (input.decision === "accept") {
    const tasks = await db.query<{ task_id: string }>("select task_id from handover_tasks where handover_id = $1", [handoverId]);
    for (const task of tasks.rows) {
      await db.query(
        `update tasks set owner_id = $3, unassigned_explicit = false, updated_by = $3
          where branch_id = $1 and id = $2 and deleted_at is null`,
        [identity.branchId, task.task_id, identity.userId],
      );
      await db.query(
        `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
         values ($1,$2,$3,'handover','Accepted in a shift handover',$4::jsonb)`,
        [identity.branchId, task.task_id, identity.userId, JSON.stringify({ ownerId: identity.userId, handoverId })],
      );
    }
  }

  await db.query(
    `insert into notifications (branch_id, user_id, kind, title, body, dedupe_key)
     values ($1,$2,'handover_response',$3,$4,$5)`,
    [
      identity.branchId,
      handover.from_user_id,
      input.decision === "accept" ? "Handover accepted" : "Handover declined",
      input.note ?? `${identity.name} ${input.decision}ed the handover`,
      `handover-response:${handoverId}`,
    ],
  );

  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: `handover.${input.decision}`,
    entityType: "handover",
    entityId: handoverId,
    before: { status: handover.status },
    after: { status: input.decision === "accept" ? "accepted" : "declined" },
    reason: input.note ?? null,
  });

  const list = await listHandovers(db, identity);
  return list.find((h) => h.id === handoverId)!;
}
