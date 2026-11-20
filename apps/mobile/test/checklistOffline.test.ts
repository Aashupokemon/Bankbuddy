import assert from "node:assert/strict";
import { test } from "node:test";

import { writeChecklistStep } from "../src/checklistSync.ts";
import { demoRequest } from "../src/demo.ts";
import { ApiFailure, createApiClient } from "../src/http.ts";
import { createOfflineQueue, type QueueOperation, type QueueStorage } from "../src/offlineQueue.ts";

/**
 * A tick made without a connection has to survive the demo fallback.
 *
 * The fallback is what answers the board on a phone with no route to the API, but it only knows its
 * own synthetic ids: for a real task loaded from the server it has no answer, and it used to throw
 * its own "Task not found" through the request. That error was not an ApiFailure, so the screen's
 * status-0 branch never ran, the write was neither queued nor reported, and the tick vanished.
 */

const REAL_TASK = "11111111-1111-4111-8111-111111111111";
const REAL_STEP = "22222222-2222-4222-8222-222222222222";

/** A client whose transport always fails, as on a phone in a basement branch. */
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

function memoryStorage(): QueueStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
}

test("an offline tick fails as a transport error, not as a demo lookup error", async () => {
  const app = offlineClient();

  await assert.rejects(
    () => app.api.updateChecklistItem(REAL_TASK, REAL_STEP, { done: true }),
    (error: unknown) => {
      assert.ok(
        error instanceof ApiFailure,
        "the screen decides on ApiFailure.status, so the fallback must not leak its own Error",
      );
      assert.equal(error.status, 0);
      assert.equal(error.code, "network_unavailable");
      return true;
    },
  );

  assert.equal(app.isDemoMode(), false, "bundled data does not stand in for a task it does not have");
});

test("an offline tick reaches the offline queue and replays once", async () => {
  const app = offlineClient();
  const queue = createOfflineQueue(memoryStorage());
  const operation: QueueOperation = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "checklist.update",
    at: "2026-11-20T09:00:00.000Z",
    payload: { taskId: REAL_TASK, itemId: REAL_STEP, done: true },
  };

  const write = await writeChecklistStep({
    send: () => app.api.updateChecklistItem(REAL_TASK, REAL_STEP, { done: true }),
    queue: () => queue.enqueue(operation),
  });

  assert.equal(write.queued, true);
  assert.equal(write.value, null, "there is no server answer to show");
  assert.equal(await queue.count(), 1);
  assert.deepEqual(await queue.list(), [operation]);

  const flushed = await queue.flush(async (batch) =>
    batch.map((item) => ({ id: item.id, status: "applied" as const })),
  );
  assert.equal(flushed.applied, 1);
  assert.equal(await queue.count(), 0, "a replayed tick leaves the queue");
});

test("a reachable server that refuses the tick is not queued", async () => {
  const app = createApiClient({
    baseUrl: "http://10.0.2.2:8787",
    demo: demoRequest,
    getToken: async () => "branch-session",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ title: "Someone else changed this task", code: "version_conflict" }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      })) as typeof fetch,
  });

  let queued = false;
  await assert.rejects(
    () =>
      writeChecklistStep({
        send: () => app.api.updateChecklistItem(REAL_TASK, REAL_STEP, { done: true }),
        queue: async () => {
          queued = true;
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.status, 409, "an answer from the server is surfaced, not replayed later");
      return true;
    },
  );
  assert.equal(queued, false);
});

test("a demo task the bundled data knows is still ticked offline, without queueing", async () => {
  const app = offlineClient();

  const toggled = await app.api.updateChecklistItem("demo-task-1", "demo-check-3", { done: true });

  assert.equal(toggled.done, true);
  assert.equal(app.isDemoMode(), true, "demo data did answer, so the banner is honest");
});
