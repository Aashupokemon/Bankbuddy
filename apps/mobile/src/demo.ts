import type {
  AnalyticsSummary,
  DashboardResponse,
  ExtractResponse,
  MeResponse,
  NotificationDto,
  TaskDto,
  TaskStatus,
  TaskTemplateDto,
} from "@bankbuddy/contracts";

/**
 * On-device demo data, used when the app cannot reach the API — a phone on the street has no
 * `10.0.2.2`, and the pilot is meant to be reviewable without running the backend.
 *
 * Everything here is synthetic and lives in memory for the session; nothing is persisted and no
 * request leaves the device. The app labels this mode in the UI so it is never mistaken for live data.
 */

const BRANCH_ID = "demo-branch-mg-road";
const WORKSPACE_ID = "demo-workspace";

export const DEMO_ACCOUNT: MeResponse = {
  user: { id: "demo-priya", name: "Priya Menon", email: "priya@alpha.example" },
  workspace: { id: WORKSPACE_ID, name: "BankBuddy Pilot Workspace (synthetic)" },
  branch: { id: BRANCH_ID, name: "MG Road Branch", timezone: "Asia/Kolkata" },
  role: "manager",
  permissions: [
    "task.read.own",
    "task.read.branch",
    "task.create",
    "task.update.own",
    "task.update.any",
    "task.status.own",
    "task.status.any",
    "task.assign",
    "task.archive",
    "comment.create",
    "dependency.manage",
    "handover.propose",
    "handover.respond",
    "review.read",
    "audit.read",
    "analytics.read",
    "settings.manage",
  ],
  settings: { quietHoursStart: "19:00", quietHoursEnd: "08:00", reminderLeadMinutes: 120 },
};

const MEMBERS = [
  { id: "demo-priya", name: "Priya Menon", role: "manager" },
  { id: "demo-arun", name: "Arun Das", role: "lead" },
  { id: "demo-ravi", name: "Ravi Kumar", role: "employee" },
  { id: "demo-meera", name: "Meera Iyer", role: "auditor" },
];

const now = Date.now();
const at = (hours: number): string => new Date(now + hours * 3_600_000).toISOString();

interface DemoTracked {
  comments: Array<{ id: string; authorName: string; body: string; createdAt: string }>;
  activity: Array<{ id: string; summary: string; actorName: string; createdAt: string; reason: string | null }>;
  dependencies: Array<{ id: string; dependsOnTaskId: string; dependsOnTitle: string; dependsOnStatus: string }>;
}

function task(
  id: string,
  title: string,
  description: string,
  status: TaskStatus,
  priority: TaskDto["priority"],
  categoryKey: string | null,
  ownerId: string | null,
  dueAt: string | null,
  duePrecision: TaskDto["duePrecision"],
  extra: Partial<TaskDto> = {},
): TaskDto {
  const owner = MEMBERS.find((member) => member.id === ownerId) ?? null;
  return {
    id,
    branchId: BRANCH_ID,
    title,
    description,
    status,
    priority,
    categoryKey,
    ownerId,
    ownerName: owner?.name ?? null,
    unassigned: ownerId === null,
    blockedReason: null,
    dueAt,
    duePrecision,
    dueSourcePhrase: null,
    completedAt: null,
    version: 1,
    createdBy: "demo-priya",
    createdAt: at(-96),
    updatedAt: at(-24),
    isOverdue: false,
    dependencyCount: 0,
    blockedByCount: 0,
    ...extra,
  };
}

const tasks: TaskDto[] = [
  task("demo-task-1", "Collect pending KYC documents for the Sharma account", "Call the customer and collect the address proof before the file goes for review.", "open", "high", "kyc", "demo-ravi", at(30), "datetime"),
  task("demo-task-2", "Reconcile the vault count against the register", "Evening reconciliation, differencing to be signed by the manager.", "in_progress", "urgent", "cash", "demo-arun", at(4), "datetime"),
  task("demo-task-3", "Overdue: respond to the audit observation on cheque storage", "Audit observation 4.2 is past its response date.", "open", "urgent", "audit", "demo-priya", at(-26), "date", { dependencyCount: 1, blockedByCount: 1 }),
  task("demo-task-4", "Fix the cheque-book request backlog", "Three requests are stuck at the printer integration step.", "blocked", "high", "customer_service", "demo-ravi", at(52), "date", { blockedReason: "Waiting for the vendor to restore the printer integration." }),
  task("demo-task-5", "Hand over the locker key register for the evening shift", "Physical register and the digital entry must match at shift change.", "open", "normal", "cash", null, at(10), "datetime"),
  task("demo-task-6", "Confirm the new customer onboarding checklist", "Completed after the branch meeting.", "done", "normal", "customer_service", "demo-ravi", at(-50), "date", { completedAt: at(-48), version: 2 }),
  task("demo-task-7", "Cancel the duplicate stationery order", "Order raised twice by mistake.", "cancelled", "low", null, "demo-priya", at(-10), "date", { version: 2 }),
];

const tracked: Record<string, DemoTracked> = {
  "demo-task-1": {
    comments: [
      { id: "demo-comment-1", authorName: "Arun Das", body: "Customer said the document will be ready by Thursday.", createdAt: at(-20) },
    ],
    activity: [],
    dependencies: [],
  },
  "demo-task-3": {
    comments: [],
    activity: [],
    dependencies: [
      { id: "demo-dep-1", dependsOnTaskId: "demo-task-1", dependsOnTitle: "Collect pending KYC documents for the Sharma account", dependsOnStatus: "open" },
    ],
  },
};

const notifications: NotificationDto[] = [
  {
    id: "demo-notification-1",
    kind: "overdue",
    taskId: "demo-task-3",
    title: "Audit response is overdue",
    body: "“Overdue: respond to the audit observation on cheque storage” passed its due date.",
    createdAt: at(-2),
    readAt: null,
  },
];

let handover: {
  id: string;
  fromName: string;
  toName: string;
  status: string;
  scope?: string;
  note: string | null;
  tasks: Array<{ id: string; title: string }>;
} | null = null;

/* ---------------------------------------------------------------- recurring branch chores */

interface DemoTemplate {
  id: string;
  title: string;
  description: string;
  priority: TaskDto["priority"];
  categoryKey: string | null;
  ownerId: string | null;
  cadence: "daily" | "weekly";
  weekday: number | null;
  dueTime: string;
  active: boolean;
  lastRunOn: string | null;
  createdAt: string;
}

const todayDate = (): string => new Date().toISOString().slice(0, 10);

const templates: DemoTemplate[] = [
  {
    id: "demo-template-1",
    title: "Complete the branch opening checklist",
    description: "Shutter, alarm, cash box and the visitor register — before the doors open.",
    priority: "high",
    categoryKey: "customer_service",
    ownerId: "demo-ravi",
    cadence: "daily",
    weekday: null,
    dueTime: "09:15",
    active: true,
    lastRunOn: null,
    createdAt: at(-720),
  },
  {
    id: "demo-template-2",
    title: "Weekly review of the dormant account list",
    description: "Synthetic dormant accounts flagged for a second look.",
    priority: "normal",
    categoryKey: "audit",
    ownerId: "demo-arun",
    cadence: "weekly",
    weekday: 1,
    dueTime: "16:00",
    active: true,
    lastRunOn: null,
    createdAt: at(-960),
  },
];

/** Keys of chores already created in this session, so a second run makes no duplicates. */
const choreRuns = new Set<string>();

function templateDto(template: DemoTemplate): TaskTemplateDto {
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    priority: template.priority,
    categoryKey: template.categoryKey,
    ownerId: template.ownerId,
    ownerName: MEMBERS.find((member) => member.id === template.ownerId)?.name ?? null,
    cadence: template.cadence,
    weekday: template.weekday,
    dueTime: template.dueTime,
    active: template.active,
    lastRunOn: template.lastRunOn,
    createdAt: template.createdAt,
  };
}

let nextId = 1;
const newId = (prefix: string): string => `${prefix}-${nextId++}`;

function refresh(t: TaskDto): TaskDto {
  const overdue =
    t.dueAt !== null && t.status !== "done" && t.status !== "cancelled" && new Date(t.dueAt).getTime() < Date.now();
  return { ...t, isOverdue: overdue };
}

function counts(): DashboardResponse["counts"] {
  const live = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return {
    overdue: live.filter((t) => refresh(t).isOverdue).length,
    dueToday: live.filter((t) => t.dueAt !== null && new Date(t.dueAt) <= endOfToday && new Date(t.dueAt).getTime() >= Date.now()).length,
    blocked: live.filter((t) => t.status === "blocked").length,
    inProgress: live.filter((t) => t.status === "in_progress").length,
    mine: live.filter((t) => t.ownerId === DEMO_ACCOUNT.user.id).length,
    unassigned: live.filter((t) => t.unassigned).length,
  };
}

function activityFor(taskId: string): DemoTracked {
  const existing = tracked[taskId];
  if (existing) return existing;
  const created: DemoTracked = { comments: [], activity: [], dependencies: [] };
  tracked[taskId] = created;
  return created;
}

function findTask(id: string): TaskDto {
  const found = tasks.find((t) => t.id === id);
  if (!found) throw Object.assign(new Error("Task not found"), { demoStatus: 404 });
  return found;
}

function extract(text: string): ExtractResponse {
  const lower = text.toLowerCase();
  const owner = MEMBERS.find((member) => lower.includes(member.name.split(" ")[0]!.toLowerCase()));
  const title = text.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    draft: {
      title: title.charAt(0).toUpperCase() + title.slice(1),
      description: text.trim(),
      ownerName: owner?.name ?? null,
      duePhrase: lower.includes("tomorrow") ? "tomorrow" : null,
      dueAt: lower.includes("tomorrow") ? at(24) : null,
      duePrecision: lower.includes("tomorrow") ? "date" : null,
      priority: lower.includes("urgent") || lower.includes("today") ? "urgent" : "normal",
      categoryKey: null,
    },
    warnings: ["Created on this device in demo mode; nothing was sent to a server."],
    provider: "rules",
    requiresConfirmation: true,
    sensitiveDataDetected: false,
  };
}

/**
 * Handles the endpoints the app calls, entirely from memory. Returning `undefined` means "not
 * handled" and lets the caller surface the original network error instead of inventing a response.
 */
export function demoRequest(path: string, method: string, body: unknown): unknown | undefined {
  const [rawPath, rawQuery = ""] = path.split("?");
  const url = rawPath ?? "";
  const query = new URLSearchParams(rawQuery);
  const verb = method.toUpperCase();
  let match: RegExpMatchArray | null;

  if (verb === "GET" && url === "/api/v1/auth/users") {
    return {
      users: [{ ...DEMO_ACCOUNT.user, role: DEMO_ACCOUNT.role, branch: `${DEMO_ACCOUNT.branch.name} (demo)`, branchId: BRANCH_ID }],
    };
  }
  if (verb === "POST" && url === "/api/v1/auth/dev-login") return { token: "demo-session", me: DEMO_ACCOUNT };
  if (verb === "POST" && url === "/api/v1/auth/logout") return null;
  if (verb === "GET" && url === "/api/v1/me") return DEMO_ACCOUNT;

  if (verb === "GET" && url === "/api/v1/dashboard") {
    return {
      counts: counts(),
      upcoming: tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").slice(0, 5).map(refresh),
      teamLoad: MEMBERS.map((member) => ({
        ownerId: member.id,
        ownerName: member.name,
        open: tasks.filter((t) => t.ownerId === member.id && t.status !== "done" && t.status !== "cancelled").length,
        overdue: tasks.filter((t) => t.ownerId === member.id && refresh(t).isOverdue).length,
      })),
    } satisfies DashboardResponse;
  }

  if (verb === "GET" && url === "/api/v1/members") {
    return { items: MEMBERS };
  }

  if (verb === "GET" && url === "/api/v1/tasks") {
    let items = tasks.map(refresh);
    const filter = query.get("filter");
    if (query.get("scope") === "mine") items = items.filter((t) => t.ownerId === DEMO_ACCOUNT.user.id);
    if (filter === "due_today") {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      items = items.filter((t) => t.dueAt !== null && new Date(t.dueAt) <= end);
    }
    if (filter === "overdue") items = items.filter((t) => t.isOverdue);
    if (filter === "blocked") items = items.filter((t) => t.status === "blocked");
    const status = query.get("status");
    if (status) items = items.filter((t) => t.status === status);
    const search = query.get("q")?.trim().toLowerCase();
    if (search) {
      items = items.filter(
        (t) => t.title.toLowerCase().includes(search) || t.description.toLowerCase().includes(search),
      );
    }
    return { items, total: items.length, nextCursor: null };
  }

  if (verb === "POST" && url === "/api/v1/tasks") {
    const input = (body ?? {}) as { title?: string; description?: string; priority?: TaskDto["priority"]; ownerId?: string; unassigned?: boolean; dueAt?: string; duePrecision?: TaskDto["duePrecision"] };
    const created = task(
      newId("demo-task"),
      input.title ?? "Untitled task",
      input.description ?? "",
      "open",
      input.priority ?? "normal",
      null,
      input.unassigned ? null : (input.ownerId ?? DEMO_ACCOUNT.user.id),
      input.dueAt ?? null,
      input.dueAt ? (input.duePrecision ?? "date") : null,
      { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    );
    tasks.unshift(created);
    activityFor(created.id).activity.push({
      id: newId("demo-activity"),
      summary: `Created “${created.title}”`,
      actorName: DEMO_ACCOUNT.user.name,
      createdAt: new Date().toISOString(),
      reason: null,
    });
    return created;
  }

  if ((match = url.match(/^\/api\/v1\/tasks\/([^/]+)$/))) {
    const id = match[1]!;
    if (verb === "GET") return refresh(findTask(id));
    if (verb === "PATCH") {
      const target = findTask(id);
      const input = (body ?? {}) as { ownerId?: string | null; version?: number };
      if (input.ownerId !== undefined) {
        target.ownerId = input.ownerId;
        target.ownerName = MEMBERS.find((m) => m.id === input.ownerId)?.name ?? null;
        target.unassigned = input.ownerId === null;
      }
      target.version += 1;
      target.updatedAt = new Date().toISOString();
      return refresh(target);
    }
  }

  if ((match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/status$/)) && verb === "POST") {
    const target = findTask(match[1]!);
    const input = (body ?? {}) as { status: TaskStatus; reason?: string; blockedReason?: string };
    target.status = input.status;
    target.blockedReason = input.status === "blocked" ? (input.blockedReason ?? null) : null;
    target.completedAt = input.status === "done" ? new Date().toISOString() : null;
    target.version += 1;
    target.updatedAt = new Date().toISOString();
    activityFor(target.id).activity.unshift({
      id: newId("demo-activity"),
      summary: `Moved to ${input.status.replace("_", " ")}`,
      actorName: DEMO_ACCOUNT.user.name,
      createdAt: new Date().toISOString(),
      reason: input.reason ?? null,
    });
    return refresh(target);
  }

  if ((match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/comments$/))) {
    const id = match[1]!;
    if (verb === "GET") return { items: activityFor(id).comments };
    if (verb === "POST") {
      const created = {
        id: newId("demo-comment"),
        authorName: DEMO_ACCOUNT.user.name,
        body: ((body ?? {}) as { body?: string }).body ?? "",
        createdAt: new Date().toISOString(),
      };
      activityFor(id).comments.push(created);
      return { id: created.id };
    }
  }

  if ((match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/activity$/)) && verb === "GET") {
    const id = match[1]!;
    const events = activityFor(id).activity;
    return {
      items: events.length
        ? events
        : [
            {
              id: newId("demo-activity"),
              summary: `Created “${findTask(id).title}”`,
              actorName: DEMO_ACCOUNT.user.name,
              createdAt: findTask(id).createdAt,
              reason: null,
            },
          ],
    };
  }

  if ((match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/dependencies$/))) {
    const id = match[1]!;
    if (verb === "GET") return { blocking: activityFor(id).dependencies, blockedBy: [] };
    if (verb === "POST") {
      const dependsOnTaskId = ((body ?? {}) as { dependsOnTaskId?: string }).dependsOnTaskId ?? "";
      const dependency = findTask(dependsOnTaskId);
      activityFor(id).dependencies.push({
        id: newId("demo-dep"),
        dependsOnTaskId,
        dependsOnTitle: dependency.title,
        dependsOnStatus: dependency.status,
      });
      return { ok: true };
    }
  }

  if (verb === "POST" && url === "/api/v1/assistant/extract") {
    return extract(((body ?? {}) as { text?: string }).text ?? "");
  }

  if (verb === "GET" && url === "/api/v1/notifications") return { items: notifications };
  if ((match = url.match(/^\/api\/v1\/notifications\/([^/]+)\/ack$/)) && verb === "POST") {
    const found = notifications.find((n) => n.id === match![1]);
    if (found) found.readAt = new Date().toISOString();
    return null;
  }
  if (verb === "POST" && url === "/api/v1/notifications/read-all") {
    const unread = notifications.filter((n) => !n.readAt);
    for (const item of unread) item.readAt = new Date().toISOString();
    return { acknowledged: unread.length };
  }

  if (verb === "GET" && url === "/api/v1/audit/events") {
    return {
      items: tasks.slice(0, 8).map((t, index) => ({
        id: `demo-audit-${index}`,
        action: "task.create",
        entityType: "task",
        actorName: DEMO_ACCOUNT.user.name,
        occurredAt: t.createdAt,
        reason: null,
        hash: `${(index + 1).toString(16).padStart(10, "0")}…demo`,
      })),
    };
  }
  if (verb === "GET" && url === "/api/v1/audit/verify") {
    return { checked: tasks.length, brokenLinks: 0, tampered: 0, valid: true };
  }
  if (verb === "GET" && url === "/api/v1/audit/export.csv") {
    const lines = ["occurred_at,action,entity_type,entity_id,actor,reason,prev_hash,hash"];
    tasks.slice(0, 8).forEach((t, index) => {
      lines.push(
        [
          t.createdAt,
          "task.create",
          "task",
          t.id,
          DEMO_ACCOUNT.user.name,
          "",
          "",
          `${(index + 1).toString(16).padStart(10, "0")}…demo`,
        ].join(","),
      );
    });
    return `${lines.join("\r\n")}\r\n`;
  }

  if (verb === "GET" && url === "/api/v1/analytics/summary") {
    const done = tasks.filter((t) => t.completedAt);
    const durations = done.map((t) => (new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime()) / 3_600_000);
    const summary: AnalyticsSummary = {
      windowDays: 30,
      created: tasks.length,
      completed: done.length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
      reopened: 0,
      medianCompletionHours: durations.length ? durations.sort((a, b) => a - b)[0]! : null,
      onTimeRate: done.length
        ? done.filter((t) => t.dueAt && new Date(t.completedAt!) <= new Date(t.dueAt)).length / done.length
        : null,
      blockedNow: tasks.filter((t) => t.status === "blocked").length,
      byCategory: [
        { categoryKey: "audit", count: 2 },
        { categoryKey: "cash", count: 2 },
        { categoryKey: "customer_service", count: 2 },
        { categoryKey: "kyc", count: 1 },
      ],
    };
    return summary;
  }

  if (verb === "GET" && url === "/api/v1/templates") {
    return { items: templates.map(templateDto) };
  }
  if (verb === "POST" && url === "/api/v1/templates") {
    const input = (body ?? {}) as Partial<DemoTemplate>;
    const created: DemoTemplate = {
      id: newId("demo-template"),
      title: input.title ?? "Untitled chore",
      description: input.description ?? "",
      priority: input.priority ?? "normal",
      categoryKey: input.categoryKey ?? null,
      ownerId: input.ownerId ?? null,
      cadence: input.cadence ?? "daily",
      weekday: input.cadence === "weekly" ? (input.weekday ?? 1) : null,
      dueTime: input.dueTime ?? "09:00",
      active: true,
      lastRunOn: null,
      createdAt: new Date().toISOString(),
    };
    templates.unshift(created);
    return templateDto(created);
  }
  if ((match = url.match(/^\/api\/v1\/templates\/([^/]+)$/)) && verb === "PATCH") {
    const templateId = match[1]!;
    const target = templates.find((t) => t.id === templateId);
    if (!target) throw Object.assign(new Error("Chore not found"), { demoStatus: 404 });
    const input = (body ?? {}) as Partial<DemoTemplate>;
    Object.assign(target, input);
    if (input.cadence === "daily") target.weekday = null;
    return templateDto(target);
  }
  if (verb === "POST" && url === "/api/v1/templates/run") {
    const runDate = ((body ?? {}) as { date?: string }).date ?? todayDate();
    const weekday = new Date(`${runDate}T00:00:00.000Z`).getUTCDay();
    const created: TaskDto[] = [];
    let skipped = 0;
    for (const template of templates) {
      if (!template.active) continue;
      if (template.cadence === "weekly" && template.weekday !== weekday) continue;
      const key = `${template.id}:${runDate}`;
      if (choreRuns.has(key)) {
        skipped += 1;
        continue;
      }
      choreRuns.add(key);
      template.lastRunOn = runDate;
      const occurrence = refresh(
        task(
          newId("demo-task"),
          template.title,
          template.description,
          "open",
          template.priority,
          template.categoryKey,
          template.ownerId,
          new Date(`${runDate}T${template.dueTime}:00`).toISOString(),
          "datetime",
          { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ),
      );
      tasks.unshift(occurrence);
      created.push(occurrence);
    }
    return { date: runDate, created: created.length, skipped, items: created };
  }

  if (verb === "POST" && url === "/api/v1/tasks/bulk-reassign") {
    const input = (body ?? {}) as { taskIds?: string[]; ownerId?: string | null };
    const ownerId = input.ownerId ?? null;
    let updated = 0;
    for (const id of input.taskIds ?? []) {
      const target = tasks.find((t) => t.id === id);
      if (!target) continue;
      target.ownerId = ownerId;
      target.ownerName = MEMBERS.find((member) => member.id === ownerId)?.name ?? null;
      target.unassigned = ownerId === null;
      target.version += 1;
      target.updatedAt = new Date().toISOString();
      updated += 1;
    }
    return { updated, skipped: (input.taskIds ?? []).length - updated, taskIds: input.taskIds ?? [] };
  }

  if (verb === "GET" && url === "/api/v1/handovers") return { items: handover ? [handover] : [] };
  if (verb === "POST" && url === "/api/v1/handovers") {
    const input = (body ?? {}) as { toUserId?: string; taskIds?: string[]; scope?: string; note?: string };
    const to = MEMBERS.find((m) => m.id === input.toUserId);
    const shiftTaskIds =
      input.scope === "shift"
        ? tasks
            .filter(
              (t) =>
                t.ownerId === DEMO_ACCOUNT.user.id &&
                (t.status === "open" || t.status === "in_progress" || t.status === "blocked"),
            )
            .map((t) => t.id)
        : (input.taskIds ?? []);
    handover = {
      id: newId("demo-handover"),
      fromName: DEMO_ACCOUNT.user.name,
      toName: to?.name ?? "Someone",
      status: "proposed",
      scope: input.scope ?? "tasks",
      note: input.note ?? null,
      tasks: shiftTaskIds.map((id) => ({ id, title: tasks.find((t) => t.id === id)?.title ?? "" })),
    };
    return { id: handover.id };
  }
  if ((match = url.match(/^\/api\/v1\/handovers\/([^/]+)\/respond$/)) && verb === "POST") {
    if (handover) handover.status = ((body ?? {}) as { decision?: string }).decision === "accept" ? "accepted" : "declined";
    return { id: match[1] };
  }

  if (verb === "POST" && url === "/api/v1/sync/operations") {
    const operations = ((body ?? {}) as { operations?: Array<{ id: string }> }).operations ?? [];
    return { results: operations.map((operation) => ({ id: operation.id, status: "applied" as const })) };
  }

  return undefined;
}
