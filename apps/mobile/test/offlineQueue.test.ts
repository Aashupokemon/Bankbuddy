import assert from "node:assert/strict";
import { test } from "node:test";

import { createOfflineQueue, QUEUE_STORAGE_KEY, type QueueOperation } from "../src/offlineQueue.ts";

/** Stands in for AsyncStorage; the same map is shared by "restarted" app instances. */
function memoryStorage(initial: Record<string, string> = {}): {
  map: Map<string, string>;
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      async getItem(key) {
        return map.has(key) ? map.get(key)! : null;
      },
      async setItem(key, value) {
        map.set(key, value);
      },
    },
  };
}

function operation(id: string, title = "Task created offline"): QueueOperation {
  return {
    id,
    kind: "task.create",
    at: "2026-11-17T10:00:00.000Z",
    payload: { title, ownerId: "8f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5" },
  };
}

test("queued operations survive an app restart", async () => {
  const { storage } = memoryStorage();

  const before = createOfflineQueue(storage);
  await before.enqueue(operation("11111111-1111-4111-8111-111111111111"));
  await before.enqueue(operation("22222222-2222-4222-8222-222222222222", "Second task"));

  // A new process with the same storage is what a relaunch looks like.
  const after = createOfflineQueue(storage);
  const restored = await after.list();

  assert.equal(restored.length, 2);
  assert.equal(restored[0]?.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(restored[1]?.payload.title, "Second task");
  assert.equal(await after.count(), 2);
});

test("an operation is stored once even if it is queued twice", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);

  const op = operation("33333333-3333-4333-8333-333333333333");
  await queue.enqueue(op);
  const count = await queue.enqueue(op);

  assert.equal(count, 1);
  assert.equal((await queue.list()).length, 1);
});

test("flush removes only what the server answered for", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);

  await queue.enqueue(operation("44444444-4444-4444-8444-444444444444"));
  await queue.enqueue(operation("55555555-5555-4555-8555-555555555555"));

  const outcome = await queue.flush(async (batch) => [
    { id: batch[0]!.id, status: "applied" },
  ]);

  assert.deepEqual(outcome, { applied: 1, conflicts: 0, rejected: 0, remaining: 1 });

  const restarted = createOfflineQueue(storage);
  const left = await restarted.list();
  assert.equal(left.length, 1);
  assert.equal(left[0]?.id, "55555555-5555-4555-8555-555555555555");
});

test("a failed send leaves the queue untouched and replay stays idempotent", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);
  await queue.enqueue(operation("66666666-6666-4666-8666-666666666666"));

  // Network failure: the send throws before any result exists.
  await assert.rejects(() =>
    queue.flush(async () => {
      throw new Error("network_unavailable");
    }),
  );
  assert.equal(await queue.count(), 1);

  // The retry is answered with "replayed": the server had already applied it, so it is not applied
  // twice and the entry finally leaves the queue.
  const outcome = await queue.flush(async (batch) => [{ id: batch[0]!.id, status: "replayed" }]);
  assert.equal(outcome.applied, 1);
  assert.equal(outcome.remaining, 0);
  assert.equal(await createOfflineQueue(storage).count(), 0);
});

test("conflicts are kept for review while rejections are dropped", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);

  await queue.enqueue(operation("77777777-7777-4777-8777-777777777777"));
  await queue.enqueue(operation("88888888-8888-4888-8888-888888888888"));
  await queue.enqueue(operation("99999999-9999-4999-8999-999999999999"));

  const outcome = await queue.flush(async (batch) => [
    { id: batch[0]!.id, status: "conflict" },
    { id: batch[1]!.id, status: "rejected" },
    { id: batch[2]!.id, status: "applied" },
  ]);

  assert.deepEqual(outcome, { applied: 1, conflicts: 1, rejected: 1, remaining: 0 });

  // The conflicting edit is not lost: it waits in a review list until someone dismisses it.
  const kept = await queue.listConflicts();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.operation.id, "77777777-7777-4777-8777-777777777777");

  await queue.dismissConflict("77777777-7777-4777-8777-777777777777");
  assert.equal((await queue.listConflicts()).length, 0);
  assert.equal((await createOfflineQueue(storage).listConflicts()).length, 0);
});

test("a conflict survives an app restart so it is not silently lost", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);
  await queue.enqueue(operation("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Edited offline"));

  await queue.flush(async (batch) => [{ id: batch[0]!.id, status: "conflict" }]);

  const restarted = createOfflineQueue(storage);
  const kept = await restarted.listConflicts();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.operation.payload.title, "Edited offline");
  assert.equal(await restarted.count(), 0, "it is out of the retry queue, not retried forever");
});

test("flushing an empty queue does not call the server", async () => {
  const { storage } = memoryStorage();
  const queue = createOfflineQueue(storage);

  let called = false;
  const outcome = await queue.flush(async () => {
    called = true;
    return [];
  });

  assert.equal(called, false);
  assert.deepEqual(outcome, { applied: 0, conflicts: 0, rejected: 0, remaining: 0 });
});

test("corrupt storage does not wedge future writes", async () => {
  const { map, storage } = memoryStorage({ [QUEUE_STORAGE_KEY]: "{not json" });
  const queue = createOfflineQueue(storage);

  assert.equal(await queue.count(), 0);
  await queue.enqueue(operation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  assert.equal(await queue.count(), 1);
  assert.ok(JSON.parse(map.get(QUEUE_STORAGE_KEY)!).length === 1);
});

test("unreadable entries are discarded but valid ones are kept", async () => {
  const { storage } = memoryStorage({
    [QUEUE_STORAGE_KEY]: JSON.stringify([{ junk: true }, operation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")]),
  });
  const queue = createOfflineQueue(storage);
  const items = await queue.list();

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
});

test("subscribers see the pending count, including after a restart", async () => {
  const { storage } = memoryStorage();
  const first = createOfflineQueue(storage);
  await first.enqueue(operation("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));

  const seen: number[] = [];
  const second = createOfflineQueue(storage);
  const unsubscribe = second.subscribe((count) => seen.push(count));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.at(-1), 1);

  await second.flush(async (batch) => [{ id: batch[0]!.id, status: "applied" }]);
  assert.equal(seen.at(-1), 0);

  unsubscribe();
});
