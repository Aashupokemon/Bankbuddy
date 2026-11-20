import assert from "node:assert/strict";
import { test } from "node:test";

import { writeChecklistStep } from "../src/checklistSync.ts";
import { demoRequest } from "../src/demo.ts";
import { holdPhotoOffline, sendQueuedBatch, type EvidenceStore } from "../src/evidence.ts";
import { ApiFailure, createApiClient } from "../src/http.ts";
import { createOfflineQueue, type QueueOperation, type QueueStorage } from "../src/offlineQueue.ts";

/**
 * A photo taken at a counter with no signal is the whole point of evidence capture, so the bytes
 * have to survive on the device until the API is reachable again. These tests pin down the three
 * outcomes: held then uploaded, held again after a failed sync, and dropped once the server refuses
 * it for good.
 */

const REAL_TASK = "11111111-1111-4111-8111-111111111111";
const REAL_STEP = "22222222-2222-4222-8222-222222222222";
/** Stands in for the camera's base64; the tests care about the bytes moving, not their content. */
const PHOTO_BASE64 = "ZmFrZS1qcGVnLWJ5dGVz";

function memoryStorage(): QueueStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
}

function memoryEvidence(): EvidenceStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    save: async (id, dataBase64) => {
      files.set(id, dataBase64);
      return `file:///evidence/${id}`;
    },
    read: async (id) => files.get(id) ?? null,
    remove: async (id) => {
      files.delete(id);
    },
  };
}

function offlineClient() {
  return createApiClient({
    baseUrl: "http://10.0.2.2:8787",
    demo: demoRequest,
    getToken: async () => "branch-session",
    fetchImpl: (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch,
  });
}

/** The screen's decision: try the API, and on a transport failure hold the photo and queue it. */
function captureOffline(store: EvidenceStore, queue: ReturnType<typeof createOfflineQueue>) {
  const app = offlineClient();
  return writeChecklistStep({
    send: () =>
      app.api.addAttachment(REAL_TASK, {
        checklistItemId: REAL_STEP,
        contentType: "image/jpeg",
        dataBase64: PHOTO_BASE64,
      }),
    queue: () =>
      holdPhotoOffline(
        { store, enqueue: (operation) => queue.enqueue(operation), newId: () => "photo-1" },
        { taskId: REAL_TASK, itemId: REAL_STEP, contentType: "image/jpeg", dataBase64: PHOTO_BASE64 },
      ),
  });
}

test("a photo taken offline is held on the device and uploaded on the next sync", async () => {
  const queue = createOfflineQueue(memoryStorage());
  const store = memoryEvidence();

  const tick: QueueOperation = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "checklist.update",
    payload: { taskId: REAL_TASK, itemId: REAL_STEP, done: true },
  };
  await queue.enqueue(tick);

  const write = await captureOffline(store, queue);
  assert.equal(write.queued, true, "no connection means the photo joins the queue");
  assert.deepEqual([...store.files.values()], [PHOTO_BASE64], "the bytes are on the device, not in the queue JSON");

  const held = (await queue.list()).find((operation) => operation.kind === "attachment.add");
  assert.ok(held, "the queue holds the photo operation");
  assert.deepEqual(held.payload, {
    taskId: REAL_TASK,
    itemId: REAL_STEP,
    contentType: "image/jpeg",
    evidenceId: "photo-1",
  });
  assert.ok(!JSON.stringify(held).includes(PHOTO_BASE64), "the queue carries an id, never the image");

  const uploaded: Array<{ taskId: string; body: Record<string, unknown> }> = [];
  const synced: string[] = [];
  const flushed = await queue.flush((batch) =>
    sendQueuedBatch(batch, {
      store,
      sendOperations: async (operations) => {
        synced.push(...operations.map((operation) => operation.kind));
        return operations.map((operation) => ({ id: operation.id, status: "applied" as const }));
      },
      upload: async (taskId, body) => {
        uploaded.push({ taskId, body });
      },
    }),
  );

  assert.deepEqual(synced, ["checklist.update"], "the tick still goes through the sync endpoint");
  assert.deepEqual(uploaded, [
    {
      taskId: REAL_TASK,
      body: { checklistItemId: REAL_STEP, contentType: "image/jpeg", dataBase64: PHOTO_BASE64 },
    },
  ]);
  assert.deepEqual([flushed.applied, flushed.remaining], [2, 0]);
  assert.equal(await queue.count(), 0);
  assert.equal(store.files.size, 0, "the held file is deleted once the server has it");
});

test("a photo that cannot upload yet stays queued with its bytes", async () => {
  const queue = createOfflineQueue(memoryStorage());
  const store = memoryEvidence();
  await captureOffline(store, queue);

  await assert.rejects(
    () =>
      queue.flush((batch) =>
        sendQueuedBatch(batch, {
          store,
          sendOperations: async () => [],
          upload: async () => {
            throw new ApiFailure(0, "network_unavailable", "Cannot reach the server.");
          },
        }),
      ),
    (error: unknown) => error instanceof ApiFailure && error.status === 0,
  );

  assert.equal(await queue.count(), 1, "a transport failure leaves the upload queued");
  assert.deepEqual([...store.files.values()], [PHOTO_BASE64], "and keeps the photo it has not uploaded");
});

test("an expired session keeps the photo queued instead of discarding it", async () => {
  const queue = createOfflineQueue(memoryStorage());
  const store = memoryEvidence();
  await captureOffline(store, queue);

  await assert.rejects(
    () =>
      queue.flush((batch) =>
        sendQueuedBatch(batch, {
          store,
          sendOperations: async () => [],
          upload: async () => {
            throw new ApiFailure(401, "unauthorized", "Sign in again.");
          },
        }),
      ),
    (error: unknown) => error instanceof ApiFailure && error.status === 401,
  );

  assert.equal(await queue.count(), 1, "a session problem is not a verdict on the photo");
  assert.equal(store.files.size, 1, "the evidence is still on the phone");
});

test("a photo the server refuses is reported rejected instead of retrying forever", async () => {
  const queue = createOfflineQueue(memoryStorage());
  const store = memoryEvidence();
  await captureOffline(store, queue);

  const flushed = await queue.flush((batch) =>
    sendQueuedBatch(batch, {
      store,
      sendOperations: async () => [],
      upload: async () => {
        throw new ApiFailure(413, "too_large", "That photo is too large.");
      },
    }),
  );

  assert.deepEqual([flushed.applied, flushed.rejected, flushed.remaining], [0, 1, 0]);
  assert.equal(store.files.size, 0, "a refused photo stops taking up space on the phone");
});
