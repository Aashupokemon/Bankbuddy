/**
 * Photo evidence captured without a connection.
 *
 * The image is the one queued write that cannot live in the JSON queue: 700 KB of JPEG is nearly a
 * megabyte as base64, and it would be re-serialised every time any other operation is added. So the
 * bytes are written to the app's own storage and the queue carries only the file's id. A sync reads
 * the file, uploads it through the same endpoint the online path uses, and deletes it once the
 * server has the photo.
 *
 * The store is injected, so this file has no React Native imports and the whole path can be tested
 * in Node. The device implementation is `evidenceFiles.ts`.
 */

import type { SyncOperation } from "@bankbuddy/contracts";

import { ApiFailure } from "./http";
import type { BatchResult, QueueOperation } from "./offlineQueue";

export const EVIDENCE_KIND = "attachment.add";

export interface EvidenceStore {
  /** Writes the photo and returns a uri the screen can render right away. */
  save(id: string, dataBase64: string): Promise<string>;
  /** The photo's bytes, or null when the file has already gone. */
  read(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export interface HeldPhoto {
  /** Local uri, so the photo shows on the step before it has ever been uploaded. */
  uri: string;
  operationId: string;
}

/** Every queued operation except the photos, which the sync endpoint does not accept. */
type QueuedWrite = QueueOperation & { kind: SyncOperation["kind"] };

function isQueuedWrite(operation: QueueOperation): operation is QueuedWrite {
  return operation.kind !== EVIDENCE_KIND;
}

export function evidenceOperation(input: {
  id: string;
  taskId: string;
  itemId: string | null;
  contentType: string;
  evidenceId: string;
}): QueueOperation {
  return {
    id: input.id,
    kind: EVIDENCE_KIND,
    at: new Date().toISOString(),
    payload: {
      taskId: input.taskId,
      itemId: input.itemId,
      contentType: input.contentType,
      evidenceId: input.evidenceId,
    },
  };
}

/** Holds the photo on the device and queues the upload for the next sync. */
export async function holdPhotoOffline(
  deps: {
    store: EvidenceStore;
    enqueue: (operation: QueueOperation) => Promise<unknown>;
    newId: () => string;
  },
  photo: { taskId: string; itemId: string | null; contentType: string; dataBase64: string },
): Promise<HeldPhoto> {
  const id = deps.newId();
  const uri = await deps.store.save(id, photo.dataBase64);
  await deps.enqueue(
    evidenceOperation({
      id,
      evidenceId: id,
      taskId: photo.taskId,
      itemId: photo.itemId,
      contentType: photo.contentType,
    }),
  );
  return { uri, operationId: id };
}

/**
 * Answers that say this photo can never be accepted: malformed, too large, or for a task or step the
 * server does not have. Anything else — no connection, an expired session, a 5xx — is about access or
 * infrastructure and must leave the photo queued rather than delete evidence on a guess.
 */
const TERMINAL_STATUSES = new Set([400, 404, 409, 413, 422]);

export interface BatchSenders {
  store: EvidenceStore;
  sendOperations: (operations: SyncOperation[]) => Promise<BatchResult[]>;
  upload: (
    taskId: string,
    body: { checklistItemId: string | null; contentType: string; dataBase64: string },
  ) => Promise<unknown>;
}

/**
 * Sends one queued batch: ordinary writes to the sync endpoint, photos to the attachment endpoint.
 * An operation the server refuses is dropped so it cannot wedge the queue; a transport failure is
 * re-thrown, which leaves every operation in place for the next attempt.
 */
export async function sendQueuedBatch(batch: QueueOperation[], senders: BatchSenders): Promise<BatchResult[]> {
  const results: BatchResult[] = [];

  const writes = batch.filter(isQueuedWrite);
  if (writes.length > 0) results.push(...(await senders.sendOperations(writes)));

  for (const operation of batch) {
    if (operation.kind === EVIDENCE_KIND) results.push(await uploadEvidence(operation, senders));
  }

  return results;
}

async function uploadEvidence(operation: QueueOperation, senders: BatchSenders): Promise<BatchResult> {
  const payload = operation.payload as {
    taskId?: unknown;
    itemId?: unknown;
    contentType?: unknown;
    evidenceId?: unknown;
  };
  const evidenceId = typeof payload.evidenceId === "string" ? payload.evidenceId : "";
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const itemId = typeof payload.itemId === "string" ? payload.itemId : null;
  const contentType = typeof payload.contentType === "string" ? payload.contentType : "image/jpeg";

  const dataBase64 = evidenceId ? await senders.store.read(evidenceId) : null;
  if (!dataBase64) {
    // Nothing to send: the file was cleared, or an earlier sync already uploaded it.
    if (evidenceId) await senders.store.remove(evidenceId);
    return { id: operation.id, status: "rejected" };
  }

  try {
    await senders.upload(taskId, { checklistItemId: itemId, contentType, dataBase64 });
  } catch (failure) {
    if (failure instanceof ApiFailure && TERMINAL_STATUSES.has(failure.status)) {
      // The server answered and will never take this photo; retrying would only repeat the answer.
      await senders.store.remove(evidenceId);
      return { id: operation.id, status: "rejected" };
    }
    // No connection, or a session problem: keep both the file and the operation for the next sync.
    throw failure;
  }

  await senders.store.remove(evidenceId);
  return { id: operation.id, status: "applied" };
}
