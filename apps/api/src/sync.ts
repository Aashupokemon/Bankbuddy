import {
  createChecklistItemSchema,
  createCommentSchema,
  createTaskSchema,
  syncRequestSchema,
  transitionTaskSchema,
  updateChecklistItemSchema,
  updateTaskSchema,
  type SyncOperation,
  type SyncResult,
} from "@bankbuddy/contracts";
import type { Database } from "@bankbuddy/db";
import { withRequestContext } from "@bankbuddy/db";
import { z } from "zod";

import { ApiError } from "./http.ts";
import { addChecklistItem, removeChecklistItem, updateChecklistItem } from "./checklist.ts";
import { addComment } from "./collaboration.ts";
import { createTask, transitionTask, updateTask } from "./tasks.ts";
import type { Identity } from "./auth.ts";

const updateOpPayload = z.object({ taskId: z.string().uuid() }).and(updateTaskSchema);
const transitionOpPayload = transitionTaskSchema.extend({ taskId: z.string().uuid() });
const commentOpPayload = createCommentSchema.extend({ taskId: z.string().uuid() });
const checklistAddPayload = createChecklistItemSchema.extend({ taskId: z.string().uuid() });
const checklistUpdatePayload = updateChecklistItemSchema.and(
  z.object({ taskId: z.string().uuid(), itemId: z.string().uuid() }),
);
const checklistRemovePayload = z.object({ taskId: z.string().uuid(), itemId: z.string().uuid() });

interface Applied {
  taskId: string;
  serverVersion?: number;
}

async function applyOperation(db: Parameters<Parameters<typeof withRequestContext>[2]>[0], identity: Identity, op: SyncOperation): Promise<Applied> {
  switch (op.kind) {
    case "task.create": {
      const task = await createTask(db, identity, createTaskSchema.parse(op.payload));
      return { taskId: task.id, serverVersion: task.version };
    }
    case "task.update": {
      const payload = updateOpPayload.parse(op.payload);
      const task = await updateTask(db, identity, payload.taskId, payload);
      return { taskId: task.id, serverVersion: task.version };
    }
    case "task.transition": {
      const payload = transitionOpPayload.parse(op.payload);
      const task = await transitionTask(db, identity, payload.taskId, payload);
      return { taskId: task.id, serverVersion: task.version };
    }
    case "comment.create": {
      const payload = commentOpPayload.parse(op.payload);
      await addComment(db, identity, payload.taskId, { body: payload.body });
      return { taskId: payload.taskId };
    }
    case "checklist.add": {
      const payload = checklistAddPayload.parse(op.payload);
      await addChecklistItem(db, identity, payload.taskId, { title: payload.title });
      return { taskId: payload.taskId };
    }
    case "checklist.update": {
      const payload = checklistUpdatePayload.parse(op.payload);
      await updateChecklistItem(db, identity, payload.taskId, payload.itemId, {
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.done === undefined ? {} : { done: payload.done }),
        ...(payload.position === undefined ? {} : { position: payload.position }),
      });
      return { taskId: payload.taskId };
    }
    case "checklist.remove": {
      const payload = checklistRemovePayload.parse(op.payload);
      await removeChecklistItem(db, identity, payload.taskId, payload.itemId);
      return { taskId: payload.taskId };
    }
    default:
      throw ApiError.validation("Unknown operation", [{ path: "kind", message: String(op.kind) }]);
  }
}

/**
 * Replays queued offline operations. Every operation carries a client-generated id, so replaying a
 * batch after a dropped connection applies each change at most once, and a version mismatch comes
 * back as an explicit conflict the user can resolve on the device.
 */
export async function runSync(
  database: Database,
  identity: Identity,
  body: unknown,
): Promise<SyncResult[]> {
  const request = syncRequestSchema.parse(body);
  const results: SyncResult[] = [];

  for (const op of request.operations) {
    const existing = await database.query<{ status: string; detail: string | null; task_id: string | null }>(
      "select status, detail, task_id from sync_operations where id = $1",
      [op.id],
    );
    const prior = existing.rows[0];
    if (prior) {
      results.push({
        id: op.id,
        status: prior.status === "applied" ? "replayed" : (prior.status as SyncResult["status"]),
        ...(prior.detail ? { detail: prior.detail } : {}),
        ...(prior.task_id ? { taskId: prior.task_id } : {}),
      });
      continue;
    }

    try {
      const applied = await withRequestContext(database, identity, async (tx) => {
        const outcome = await applyOperation(tx, identity, op);
        await tx.query(
          `insert into sync_operations (id, branch_id, user_id, kind, payload, status, task_id)
           values ($1,$2,$3,$4,$5::jsonb,'applied',$6)`,
          [op.id, identity.branchId, identity.userId, op.kind, JSON.stringify(op.payload), outcome.taskId],
        );
        return outcome;
      });

      results.push({
        id: op.id,
        status: "applied",
        taskId: applied.taskId,
        ...(applied.serverVersion === undefined ? {} : { serverVersion: applied.serverVersion }),
      });
    } catch (error) {
      const status: SyncResult["status"] = error instanceof ApiError && error.status === 409 ? "conflict" : "rejected";
      const detail = error instanceof Error ? error.message : "Rejected";

      await withRequestContext(database, identity, async (tx) => {
        await tx.query(
          `insert into sync_operations (id, branch_id, user_id, kind, payload, status, detail)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7)
           on conflict (id) do nothing`,
          [op.id, identity.branchId, identity.userId, op.kind, JSON.stringify(op.payload), status, detail],
        );
      });

      results.push({
        id: op.id,
        status,
        detail,
        ...(error instanceof ApiError && error.status === 409
          ? { serverVersion: (error.extra.current as { version?: number } | undefined)?.version }
          : {}),
      });
    }
  }

  return results;
}
