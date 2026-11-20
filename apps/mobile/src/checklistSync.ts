/**
 * Checklist writes try the API first and fall back to the offline queue.
 *
 * A tick is the most repeated action in the app, so losing one to a dropped connection is worse
 * than losing a whole screen. The decision lives here rather than inside the screen so it can be
 * exercised in a test: only a transport failure (status 0) is queued — a reachable server that
 * refuses the write has answered, and replaying that answer later would be a second, unwanted edit.
 */

import { ApiFailure } from "./http";

export interface ChecklistWrite<T> {
  /** The server's answer, or null when the write was queued instead. */
  value: T | null;
  queued: boolean;
}

export async function writeChecklistStep<T>(write: {
  send: () => Promise<T>;
  queue: () => Promise<unknown>;
}): Promise<ChecklistWrite<T>> {
  try {
    return { value: await write.send(), queued: false };
  } catch (failure) {
    if (failure instanceof ApiFailure && failure.status === 0) {
      await write.queue();
      return { value: null, queued: true };
    }
    throw failure;
  }
}
