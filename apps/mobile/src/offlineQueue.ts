/**
 * Durable queue of writes captured while offline.
 *
 * The queue is persisted on every mutation, so operations survive an app restart. Replay is
 * idempotent because each operation carries a client-generated id: if the app dies after the server
 * applied a batch but before the queue was pruned, sending it again returns "replayed" rather than
 * applying the change twice.
 *
 * Storage is injected so the logic can be tested outside React Native.
 */

export interface QueueOperation {
  id: string;
  kind: "task.create" | "task.update" | "task.transition" | "comment.create";
  at?: string;
  payload: Record<string, unknown>;
}

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface FlushOutcome {
  applied: number;
  conflicts: number;
  rejected: number;
  remaining: number;
}

export interface BatchResult {
  id: string;
  status: "applied" | "replayed" | "conflict" | "rejected";
}

export interface OfflineQueue {
  /** Appends an operation and persists it. Returns the new queue length. */
  enqueue(operation: QueueOperation): Promise<number>;
  /** Operations currently waiting, oldest first. */
  list(): Promise<QueueOperation[]>;
  count(): Promise<number>;
  /**
   * Sends the head of the queue. The send function must return one result per operation; an
   * operation is only dropped once the server has answered for it.
   */
  flush(send: (batch: QueueOperation[]) => Promise<BatchResult[]>): Promise<FlushOutcome>;
  subscribe(listener: (count: number) => void): () => void;
}

export const QUEUE_STORAGE_KEY = "bankbuddy.offline-queue.v1";
export const MAX_BATCH = 20;

function isOperation(value: unknown): value is QueueOperation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueueOperation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

export function createOfflineQueue(storage: QueueStorage): OfflineQueue {
  let cache: QueueOperation[] | null = null;
  let loading: Promise<QueueOperation[]> | null = null;
  let flushing = false;
  const listeners = new Set<(count: number) => void>();

  const notify = (): void => {
    const size = cache?.length ?? 0;
    for (const listener of listeners) listener(size);
  };

  const load = async (): Promise<QueueOperation[]> => {
    if (cache) return cache;
    if (loading) return loading;

    loading = (async () => {
      try {
        const raw = await storage.getItem(QUEUE_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        // A corrupted entry must never wedge every future write, so anything unreadable is dropped.
        cache = Array.isArray(parsed) ? parsed.filter(isOperation) : [];
      } catch {
        cache = [];
      } finally {
        loading = null;
      }
      notify();
      return cache;
    })();

    return loading;
  };

  const persist = async (): Promise<void> => {
    try {
      await storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(cache ?? []));
    } catch {
      // Storage is best-effort: the in-memory queue still holds the operation for this session.
    }
    notify();
  };

  return {
    async enqueue(operation) {
      const queue = await load();
      // Re-queuing the same client id (for example after a double tap) must not duplicate the write.
      if (!queue.some((item) => item.id === operation.id)) {
        queue.push(operation);
        await persist();
      }
      return queue.length;
    },

    async list() {
      return [...(await load())];
    },

    async count() {
      return (await load()).length;
    },

    async flush(send) {
      if (flushing) return { applied: 0, conflicts: 0, rejected: 0, remaining: (await load()).length };

      const queue = await load();
      if (queue.length === 0) return { applied: 0, conflicts: 0, rejected: 0, remaining: 0 };

      flushing = true;
      try {
        const batch = queue.slice(0, MAX_BATCH);
        const results = await send(batch);

        const settled = new Map(results.map((result) => [result.id, result.status]));
        const applied = results.filter((r) => r.status === "applied" || r.status === "replayed").length;
        const conflicts = results.filter((r) => r.status === "conflict").length;
        const rejected = results.filter((r) => r.status === "rejected").length;

        // Only operations the server answered for leave the queue. Anything it did not mention stays
        // and will be retried, which is safe because replay is idempotent.
        const remaining = queue.filter((operation) => !settled.has(operation.id));
        cache = remaining;
        await persist();

        return { applied, conflicts, rejected, remaining: remaining.length };
      } finally {
        flushing = false;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      void load().then(() => listener(cache?.length ?? 0));
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
