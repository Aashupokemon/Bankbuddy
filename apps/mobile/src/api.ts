import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import type { SyncOperation } from "@bankbuddy/contracts";

import { demoRequest } from "./demo";
import { createApiClient } from "./http";
import { createOfflineQueue, type FlushOutcome, type QueueConflict } from "./offlineQueue";

/**
 * The API base URL. `10.0.2.2` is how the Android emulator reaches the host machine; on a physical
 * device set EXPO_PUBLIC_API_URL to the machine's LAN address.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:8787";

const TOKEN_KEY = "bankbuddy.session";

/** Set EXPO_PUBLIC_DEMO_MODE=1 to skip the network entirely (useful for screenshots and demos). */
const DEMO_ONLY = process.env.EXPO_PUBLIC_DEMO_MODE === "1";

let tokenCache: string | null = null;

export async function loadToken(): Promise<string | null> {
  if (tokenCache) return tokenCache;
  try {
    tokenCache = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    tokenCache = null;
  }
  return tokenCache;
}

export async function saveToken(token: string): Promise<void> {
  tokenCache = token;
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {
    // Secure storage is unavailable in some environments; the in-memory token still works.
  }
}

export async function clearToken(): Promise<void> {
  tokenCache = null;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// The request pipeline itself lives in ./http so it stays testable without React Native; the demo
// fallback and the device token store are wired in here.
const client = createApiClient({
  baseUrl: API_URL,
  demo: demoRequest,
  getToken: loadToken,
  demoOnly: DEMO_ONLY,
});

export { ApiFailure, type DevUser } from "./http";

/**
 * True once a request could not reach the API and the bundled demo data took over. The screens use
 * this to label the session so on-device synthetic data is never mistaken for a live branch board.
 */
export function isDemoMode(): boolean {
  return client.isDemoMode();
}

/** Lets the shell show a banner while bundled demo data is standing in for the branch API. */
export function subscribeDemoMode(listener: (active: boolean) => void): () => void {
  return client.subscribeDemoMode(listener);
}

/** Drops demo mode so the next request tries the API again (used by "Retry live data"). */
export function resetDemoMode(): void {
  client.resetDemoMode();
}

export const api = client.api;

/* -------------------------------------------------------------------------------------------- *\
 * Offline queue: writes attempted without a connection are persisted to device storage and replayed
 * with their own id, which the API uses for idempotency. The queue therefore survives a restart and
 * each operation is still applied at most once.
 * ------------------------------------------------------------------------------------------ */

const offlineQueue = createOfflineQueue({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});

export function enqueueOperation(operation: SyncOperation): Promise<number> {
  return offlineQueue.enqueue(operation);
}

export function queuedCount(): Promise<number> {
  return offlineQueue.count();
}

export function subscribeQueue(listener: (count: number) => void): () => void {
  return offlineQueue.subscribe(listener);
}

export function flushQueue(): Promise<FlushOutcome> {
  return offlineQueue.flush(async (batch) => {
    const response = await api.sync(batch);
    return response.results;
  });
}

/** Changes the server refused to merge, kept so a person can review and dismiss them. */
export function listConflicts(): Promise<QueueConflict[]> {
  return offlineQueue.listConflicts();
}

export function dismissConflict(operationId: string): Promise<void> {
  return offlineQueue.dismissConflict(operationId);
}

/** A client-generated id, so a replayed operation is still applied at most once. */
export function newClientId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

/**
 * Re-sends a change that lost a version race, on top of whatever the server has now.
 *
 * The conflict is dismissed and the write is queued under a *new* id: the server has already recorded
 * the old id as conflicted, so reusing it would only replay the conflict. `overrides` is where the
 * caller puts the fresh version it just read.
 */
export async function retryConflict(
  operationId: string,
  overrides: Record<string, unknown> = {},
): Promise<FlushOutcome | null> {
  const conflict = (await offlineQueue.listConflicts()).find((entry) => entry.operation.id === operationId);
  if (!conflict) return null;

  await offlineQueue.enqueue({
    ...conflict.operation,
    id: newClientId(),
    at: new Date().toISOString(),
    payload: { ...conflict.operation.payload, ...overrides },
  });
  await offlineQueue.dismissConflict(operationId);
  return flushQueue();
}
