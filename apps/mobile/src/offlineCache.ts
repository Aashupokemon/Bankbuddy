/**
 * Last-known-good copies of what the board and a task showed.
 *
 * The offline queue only helps if a person can still see what they were working on. Without this,
 * losing signal leaves an empty board and no way to read the task whose checklist they came to tick.
 * A cached copy is always labelled in the UI: stale data must never look live.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Cached<T> {
  value: T;
  savedAt: string;
}

const PREFIX = "bankbuddy.cache.v1.";

export async function remember<T>(key: string, value: T): Promise<void> {
  try {
    const payload: Cached<T> = { value, savedAt: new Date().toISOString() };
    await AsyncStorage.setItem(`${PREFIX}${key}`, JSON.stringify(payload));
  } catch {
    // Caching is best effort; the live response is already on screen.
  }
}

export async function recall<T>(key: string): Promise<Cached<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export const cacheKeys = {
  dashboard: "dashboard",
  tasks: (query: string): string => `tasks.${query}`,
  task: (id: string): string => `task.${id}`,
  checklist: (id: string): string => `checklist.${id}`,
} as const;

/** True when the error is a transport failure rather than the server refusing the request. */
export function isOfflineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status: number }).status === 0;
}
