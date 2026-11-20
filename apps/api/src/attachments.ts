import {
  canEditTask,
  type AttachmentDto,
  type CreateAttachmentInput,
} from "@bankbuddy/contracts";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import type { Identity } from "./auth.ts";
import { ApiError } from "./http.ts";
import { getTaskRow } from "./tasks.ts";

/**
 * Photo evidence for a task, usually for one checklist step.
 *
 * Bytes are stored in the database because a branch phone has no object store to upload to, and the
 * alternative — keeping the picture only on the device that took it — is not evidence anyone else
 * can review. The size cap is enforced here so an oversized image is a readable 413 rather than a
 * constraint error, and a step can only ever hold one photo: attaching again replaces it.
 */

const MAX_BYTES = 700_000;

function decode(input: CreateAttachmentInput): Buffer {
  const base64 = input.dataBase64.replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw ApiError.validation("That photo is empty", [{ path: "dataBase64", message: "No image data" }]);
  }
  if (bytes.length > MAX_BYTES) {
    throw ApiError.tooLarge(
      "attachment_too_large",
      "That photo is too large for a branch phone. Take a smaller picture.",
    );
  }
  return bytes;
}

function mapAttachment(row: {
  id: string;
  task_id: string;
  checklist_item_id: string | null;
  content_type: AttachmentDto["contentType"];
  byte_size: number;
  created_at: Date | string;
}): AttachmentDto {
  return {
    id: row.id,
    taskId: row.task_id,
    checklistItemId: row.checklist_item_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function addAttachment(
  db: Queryable,
  identity: Identity,
  taskId: string,
  input: CreateAttachmentInput,
): Promise<AttachmentDto> {
  const task = await getTaskRow(db, identity, taskId);
  if (!canEditTask(identity.role, identity.userId, task)) {
    throw ApiError.forbidden("cannot_attach", "You can only add evidence to your own tasks");
  }
  if (task.status === "archived") {
    throw ApiError.forbidden("archived_read_only", "Archived tasks are read-only");
  }

  let checklistItemId: string | null = null;
  if (input.checklistItemId) {
    const item = await db.query("select 1 from task_checklist_items where branch_id = $1 and task_id = $2 and id = $3", [
      identity.branchId,
      taskId,
      input.checklistItemId,
    ]);
    if (item.rowCount === 0) throw ApiError.notFound("Checklist step");
    checklistItemId = input.checklistItemId;
  }

  const bytes = decode(input);
  const inserted = await db.query<{
    id: string;
    task_id: string;
    checklist_item_id: string | null;
    content_type: AttachmentDto["contentType"];
    byte_size: number;
    created_at: Date | string;
  }>(
    `insert into task_attachments (branch_id, task_id, checklist_item_id, content_type, byte_size, data, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (checklist_item_id) where checklist_item_id is not null
     do update set content_type = excluded.content_type, byte_size = excluded.byte_size,
                   data = excluded.data, created_by = excluded.created_by, created_at = now()
     returning id, task_id, checklist_item_id, content_type, byte_size, created_at`,
    [identity.branchId, taskId, checklistItemId, input.contentType, bytes.length, bytes, identity.userId],
  );
  const attachment = mapAttachment(inserted.rows[0]!);

  await db.query(
    `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
     values ($1,$2,$3,'evidence',$4,$5::jsonb)`,
    [
      identity.branchId,
      taskId,
      identity.userId,
      checklistItemId ? "Attached a photo to a checklist step" : "Attached a photo to the task",
      JSON.stringify({ attachmentId: attachment.id, checklistItemId }),
    ],
  );
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "task.attachment.add",
    entityType: "task",
    entityId: taskId,
    after: { attachmentId: attachment.id, checklistItemId, byteSize: attachment.byteSize },
  });
  return attachment;
}

export async function listAttachments(
  db: Queryable,
  identity: Identity,
  taskId: string,
): Promise<AttachmentDto[]> {
  await getTaskRow(db, identity, taskId);
  const rows = await db.query<{
    id: string;
    task_id: string;
    checklist_item_id: string | null;
    content_type: AttachmentDto["contentType"];
    byte_size: number;
    created_at: Date | string;
  }>(
    `select id, task_id, checklist_item_id, content_type, byte_size, created_at
       from task_attachments
      where branch_id = $1 and task_id = $2
      order by created_at desc`,
    [identity.branchId, taskId],
  );
  return rows.rows.map(mapAttachment);
}

/**
 * Returned as JSON base64 rather than a binary response: the client already authorises every call
 * with a bearer token, and an <Image> tag cannot add that header on Android.
 */
export async function readAttachment(
  db: Queryable,
  identity: Identity,
  attachmentId: string,
): Promise<{ id: string; contentType: string; dataBase64: string }> {
  const rows = await db.query<{ id: string; content_type: string; data_base64: string }>(
    "select id, content_type, encode(data, 'base64') as data_base64 from task_attachments where branch_id = $1 and id = $2",
    [identity.branchId, attachmentId],
  );
  const row = rows.rows[0];
  if (!row) throw ApiError.notFound("Photo");
  return { id: row.id, contentType: row.content_type, dataBase64: row.data_base64 };
}
