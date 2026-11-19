import type {
  BulkReassignResponse,
  DashboardResponse,
  ExtractResponse,
  MeResponse,
  NotificationDto,
  SyncOperation,
  SyncResult,
  RunTemplatesResponse,
  TaskDto,
  TaskListResponse,
  TaskStatus,
  TaskTemplateDto,
} from "@bankbuddy/contracts";

/**
 * The request pipeline, kept free of React Native imports so it can be exercised in Node: token
 * lookup, the demo handler and even `fetch` are injected by the caller (see `api.ts`).
 */

/** Handles a request from bundled data, or returns `undefined` when it has no answer for the path. */
export type DemoHandler = (path: string, method: string, body: unknown) => unknown | undefined;

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DevUser {
  email: string;
  name: string;
  role: string;
  branch: string;
  branchId: string;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  /** "text" keeps the body as-is instead of parsing JSON, for the CSV export. */
  as?: "text";
}

export interface ApiClientOptions {
  baseUrl: string;
  demo: DemoHandler;
  getToken: () => Promise<string | null>;
  /** Set to skip the network entirely (used by EXPO_PUBLIC_DEMO_MODE for demos and screenshots). */
  demoOnly?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  api: ReturnType<typeof endpointMap>;
  /** True once a request could not reach the API and the bundled demo data took over. */
  isDemoMode(): boolean;
  /** Fires when the app enters or leaves demo mode, so the UI can show or hide its banner. */
  subscribeDemoMode(listener: (active: boolean) => void): () => void;
  /** Leaves demo mode so the next request tries the API again. */
  resetDemoMode(): void;
}

/** A body that is empty or not JSON is not an exception the caller should ever see. */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function endpointMap(request: ApiClient["request"]) {
  return {
    devUsers: () => request<{ users: DevUser[] }>("/api/v1/auth/users", { token: null }),

    // branchId matters for users with more than one membership (the workspace admin): the same email
    // signs in to different branches, so the row the person tapped decides the branch.
    login: (email: string, branchId: string) =>
      request<{ token: string; me: MeResponse }>("/api/v1/auth/dev-login", {
        method: "POST",
        body: { email, branchId },
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

    bulkReassign: (taskIds: string[], ownerId: string | null) =>
      request<BulkReassignResponse>("/api/v1/tasks/bulk-reassign", {
        method: "POST",
        body: { taskIds, ownerId },
      }),

    createTask: (body: Record<string, unknown>) => request<TaskDto>("/api/v1/tasks", { method: "POST", body }),

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

    extract: (text: string) => request<ExtractResponse>("/api/v1/assistant/extract", { method: "POST", body: { text } }),

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

    auditCsv: () => request<string>("/api/v1/audit/export.csv", { as: "text" }),

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

    templates: () => request<{ items: TaskTemplateDto[] }>("/api/v1/templates"),

    createTemplate: (body: Record<string, unknown>) =>
      request<TaskTemplateDto>("/api/v1/templates", { method: "POST", body }),

    updateTemplate: (id: string, body: Record<string, unknown>) =>
      request<TaskTemplateDto>(`/api/v1/templates/${id}`, { method: "PATCH", body }),

    runTemplates: (date?: string) =>
      request<RunTemplatesResponse>("/api/v1/templates/run", { method: "POST", body: date ? { date } : {} }),

    handovers: () =>
      request<{
        items: Array<{
          id: string;
          fromName: string;
          toName: string;
          status: string;
          scope: string;
          note: string | null;
          tasks: Array<{ id: string; title: string }>;
        }>;
      }>("/api/v1/handovers"),

    proposeHandover: (taskId: string, toUserId: string) =>
      request<{ id: string }>("/api/v1/handovers", {
        method: "POST",
        body: { toUserId, taskIds: [taskId] },
      }),

    // The server resolves "my whole shift" from the tasks it knows this person owns.
    handoverShift: (toUserId: string, note?: string) =>
      request<{ id: string }>("/api/v1/handovers", {
        method: "POST",
        body: { toUserId, scope: "shift" as const, ...(note ? { note } : {}) },
      }),

    respondHandover: (id: string, decision: "accept" | "decline") =>
      request<{ id: string }>(`/api/v1/handovers/${id}/respond`, { method: "POST", body: { decision } }),

    sync: (operations: SyncOperation[]) =>
      request<{ results: SyncResult[] }>("/api/v1/sync/operations", { method: "POST", body: { operations } }),
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  let demoMode = false;
  const demoListeners = new Set<(active: boolean) => void>();

  function setDemoMode(active: boolean): void {
    if (demoMode === active) return;
    demoMode = active;
    for (const listener of demoListeners) listener(active);
  }

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const token = requestOptions.token === undefined ? await options.getToken() : requestOptions.token;
    const method = requestOptions.method ?? "GET";

    if (options.demoOnly) {
      const local = options.demo(path, method, requestOptions.body);
      if (local !== undefined) {
        setDemoMode(true);
        return local as T;
      }
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(requestOptions.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      });
    } catch (error) {
      // No API reachable (a real phone has no route to 10.0.2.2): fall back to the bundled demo data.
      // Only a transport failure falls back — an HTTP error from a reachable server is still surfaced.
      const local = options.demo(path, method, requestOptions.body);
      if (local !== undefined) {
        setDemoMode(true);
        return local as T;
      }
      throw new ApiFailure(0, "network_unavailable", "Cannot reach the server. Check the connection.");
    }

    const text = await response.text();
    // A proxy or gateway can answer with an HTML page; optional chaining below reads nothing from it.
    const payload = parseJsonOrNull(text);

    if (!response.ok) {
      const problem = payload as { title?: string; code?: string } | null;
      throw new ApiFailure(
        response.status,
        problem?.code ?? "error",
        problem?.title ?? `Request failed (${response.status})`,
      );
    }
    if (requestOptions.as === "text") return text as T;
    // No body at all is a normal 204; a body that did not parse is a broken success.
    if (!text) return null as T;
    if (payload === null) {
      throw new ApiFailure(response.status, "invalid_response", "The server sent a response that is not JSON");
    }
    return payload as T;
  }

  return {
    request,
    api: endpointMap(request),
    isDemoMode: () => demoMode,
    subscribeDemoMode(listener) {
      demoListeners.add(listener);
      listener(demoMode);
      return () => {
        demoListeners.delete(listener);
      };
    },
    resetDemoMode: () => setDemoMode(false),
  };
}
