import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { createOfflineQueue, type FlushOutcome } from "./offlineQueue";

import type {
  DashboardResponse,
  ExtractResponse,
  MeResponse,
  NotificationDto,
  SyncOperation,
  SyncResult,
  TaskDto,
  TaskListResponse,
  TaskStatus,
} from "@bankbuddy/contracts";

/**
 * The API base URL. `10.0.2.2` is how the Android emulator reaches the host machine; on a physical
 * device set EXPO_PUBLIC_API_URL to the machine's LAN address.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:8787";

const TOKEN_KEY = "bankbuddy.session";

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

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly payload: unknown = null,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const token = options.token === undefined ? await loadToken() : options.token;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new ApiFailure(0, "network_unavailable", "Cannot reach the server. Check the connection.", error);
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const problem = payload as { title?: string; code?: string } | null;
    throw new ApiFailure(
      response.status,
      problem?.code ?? "error",
      problem?.title ?? `Request failed (${response.status})`,
      payload,
    );
  }
  return payload as T;
}

export interface DevUser {
  email: string;
  name: string;
  role: string;
  branch: string;
}

export const api = {
  devUsers: () => request<{ users: DevUser[] }>("/api/v1/auth/users", { token: null }),

  login: (email: string) =>
    request<{ token: string; me: MeResponse }>("/api/v1/auth/dev-login", {
      method: "POST",
      body: { email },
      token: null,
    }),

  logout: () => request<void>("/api/v1/auth/logout", { method: "POST" }),

  me: () => request<MeResponse>("/api/v1/me"),

  dashboard: () => request<DashboardResponse>("/api/v1/dashboard"),

  members: () => request<{ items: Array<{ id: string; name: string; role: string }> }>("/api/v1/members"),

  tasks: (query: Record<string, string | number | undefined> = {}) => {
    const search = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    return request<TaskListResponse>(`/api/v1/tasks${search ? `?${search}` : ""}`);
  },

  task: (id: string) => request<TaskDto>(`/api/v1/tasks/${id}`),

  createTask: (body: Record<string, unknown>) =>
    request<TaskDto>("/api/v1/tasks", { method: "POST", body }),

  updateTask: (id: string, body: Record<string, unknown>) =>
    request<TaskDto>(`/api/v1/tasks/${id}`, { method: "PATCH", body }),

  transition: (id: string, body: { version: number; status: TaskStatus; reason?: string; blockedReason?: string }) =>
    request<TaskDto>(`/api/v1/tasks/${id}/status`, { method: "POST", body }),

  comments: (id: string) =>
    request<{ items: Array<{ id: string; authorName: string; body: string; createdAt: string }> }>(
      `/api/v1/tasks/${id}/comments`,
    ),

  addComment: (id: string, body: string) =>
    request<{ id: string }>(`/api/v1/tasks/${id}/comments`, { method: "POST", body: { body } }),

  activity: (id: string) =>
    request<{ items: Array<{ id: string; summary: string; actorName: string; createdAt: string; reason: string | null }> }>(
      `/api/v1/tasks/${id}/activity`,
    ),

  dependencies: (id: string) =>
    request<{
      blocking: Array<{ id: string; dependsOnTaskId: string; dependsOnTitle: string; dependsOnStatus: string }>;
      blockedBy: Array<{ id: string; dependsOnTaskId: string; dependsOnTitle: string; dependsOnStatus: string }>;
    }>(`/api/v1/tasks/${id}/dependencies`),

  addDependency: (id: string, dependsOnTaskId: string) =>
    request<{ ok: boolean }>(`/api/v1/tasks/${id}/dependencies`, { method: "POST", body: { dependsOnTaskId } }),

  extract: (text: string) =>
    request<ExtractResponse>("/api/v1/assistant/extract", { method: "POST", body: { text } }),

  notifications: () => request<{ items: NotificationDto[] }>("/api/v1/notifications"),

  acknowledge: (id: string) => request<void>(`/api/v1/notifications/${id}/ack`, { method: "POST" }),

  acknowledgeAll: () => request<{ acknowledged: number }>("/api/v1/notifications/read-all", { method: "POST" }),

  audit: (query: Record<string, string | undefined> = {}) => {
    const search = Object.entries(query)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    return request<{
      items: Array<{
        id: string;
        action: string;
        entityType: string;
        actorName: string | null;
        occurredAt: string;
        reason: string | null;
        hash: string;
      }>;
    }>(`/api/v1/audit/events${search ? `?${search}` : ""}`);
  },

  auditVerify: () =>
    request<{ checked: number; brokenLinks: number; tampered: number; valid: boolean }>("/api/v1/audit/verify"),

  analytics: () =>
    request<{
      windowDays: number;
      created: number;
      completed: number;
      reopened: number;
      medianCompletionHours: number | null;
      onTimeRate: number | null;
      blockedNow: number;
      byCategory: Array<{ categoryKey: string | null; count: number }>;
    }>("/api/v1/analytics/summary"),

  handovers: () =>
    request<{
      items: Array<{
        id: string;
        fromName: string;
        toName: string;
        status: string;
        note: string | null;
        tasks: Array<{ id: string; title: string }>;
      }>;
    }>("/api/v1/handovers"),

  proposeHandover: (taskId: string, toUserId: string) =>
    request<{ id: string }>("/api/v1/handovers", {
      method: "POST",
      body: { toUserId, taskIds: [taskId] },
    }),

  respondHandover: (id: string, decision: "accept" | "decline") =>
    request<{ id: string }>(`/api/v1/handovers/${id}/respond`, { method: "POST", body: { decision } }),

  sync: (operations: SyncOperation[]) =>
    request<{ results: SyncResult[] }>("/api/v1/sync/operations", { method: "POST", body: { operations } }),
};

/* -------------------------------------------------------------------------------------------- *
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
