import { z } from "zod";

/* ------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------- */

export const taskStatuses = ["open", "in_progress", "blocked", "done", "cancelled", "archived"] as const;
export const taskPriorities = ["low", "normal", "high", "urgent"] as const;
export const roles = ["employee", "lead", "manager", "workspace_admin", "auditor"] as const;
export const duePrecisions = ["date", "datetime"] as const;

export const TaskStatus = z.enum(taskStatuses);
export const TaskPriority = z.enum(taskPriorities);
export const Role = z.enum(roles);
export const DuePrecision = z.enum(duePrecisions);

export type TaskStatus = z.infer<typeof TaskStatus>;
export type TaskPriority = z.infer<typeof TaskPriority>;
export type Role = z.infer<typeof Role>;
export type DuePrecision = z.infer<typeof DuePrecision>;

export const priorityRank: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const statusLabels: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

/* ------------------------------------------------------------------------------------------
 * State machine, encoded as data
 * ---------------------------------------------------------------------------------------- */

/**
 * Allowed transitions. Reopening a terminal state is permitted here but gated by role in the API.
 */
export const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["open", "blocked", "done", "cancelled"],
  blocked: ["open", "in_progress", "cancelled"],
  done: ["open", "archived"],
  cancelled: ["open", "archived"],
  archived: ["open"],
};

/** Transitions that must carry a reason. */
export const reasonRequiredFor: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["cancelled"],
  in_progress: ["cancelled"],
  blocked: ["cancelled"],
  done: ["open"],
  cancelled: ["open"],
  archived: ["open"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  return allowedTransitions[from].includes(to);
}

/** Only managers and admins may reopen archived or cancelled work. */
export function transitionNeedsManager(from: TaskStatus, to: TaskStatus): boolean {
  return (from === "archived" || from === "cancelled") && to === "open";
}

/* ------------------------------------------------------------------------------------------
 * Permission matrix, encoded once for both the API and the Android client
 * ---------------------------------------------------------------------------------------- */

export const permissionActions = [
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
  "membership.manage",
] as const;

export type PermissionAction = (typeof permissionActions)[number];

const DENY_ALL: Record<PermissionAction, boolean> = Object.fromEntries(
  permissionActions.map((action) => [action, false]),
) as Record<PermissionAction, boolean>;

const MATRIX: Record<Role, Record<PermissionAction, boolean>> = {
  employee: {
    ...DENY_ALL,
    "task.read.own": true,
    "task.create": true,
    "task.update.own": true,
    "task.status.own": true,
    "comment.create": true,
    "handover.respond": true,
  },
  lead: {
    ...DENY_ALL,
    "task.read.own": true,
    "task.read.branch": true,
    "task.create": true,
    "task.update.own": true,
    "task.update.any": true,
    "task.status.own": true,
    "task.status.any": true,
    "task.assign": true,
    "comment.create": true,
    "dependency.manage": true,
    "handover.propose": true,
    "handover.respond": true,
    "review.read": true,
  },
  manager: {
    ...DENY_ALL,
    "task.read.own": true,
    "task.read.branch": true,
    "task.create": true,
    "task.update.own": true,
    "task.update.any": true,
    "task.status.own": true,
    "task.status.any": true,
    "task.assign": true,
    "task.archive": true,
    "comment.create": true,
    "dependency.manage": true,
    "handover.propose": true,
    "handover.respond": true,
    "review.read": true,
    "audit.read": true,
    "analytics.read": true,
    "settings.manage": true,
  },
  workspace_admin: {
    ...DENY_ALL,
    "task.read.own": true,
    "task.read.branch": true,
    "task.create": true,
    "task.update.own": true,
    "task.update.any": true,
    "task.status.own": true,
    "task.status.any": true,
    "task.assign": true,
    "task.archive": true,
    "comment.create": true,
    "dependency.manage": true,
    "handover.propose": true,
    "handover.respond": true,
    "review.read": true,
    "audit.read": true,
    "analytics.read": true,
    "settings.manage": true,
    "membership.manage": true,
  },
  auditor: {
    ...DENY_ALL,
    "task.read.own": true,
    "task.read.branch": true,
    "review.read": true,
    "audit.read": true,
    "analytics.read": true,
  },
};

export function can(role: Role, action: PermissionAction): boolean {
  return MATRIX[role][action];
}

/** True when the actor may modify the task's fields (not its status). */
export function canEditTask(
  role: Role,
  actorId: string,
  task: { owner_id: string | null; created_by: string },
): boolean {
  if (can(role, "task.update.any")) return true;
  if (!can(role, "task.update.own")) return false;
  return task.owner_id === actorId || task.created_by === actorId;
}

export function canChangeStatus(
  role: Role,
  actorId: string,
  task: { owner_id: string | null; created_by: string },
): boolean {
  if (can(role, "task.status.any")) return true;
  if (!can(role, "task.status.own")) return false;
  return task.owner_id === actorId || task.created_by === actorId;
}

/* ------------------------------------------------------------------------------------------
 * Request payloads
 * ---------------------------------------------------------------------------------------- */

const isoDateTime = z.string().datetime({ offset: true });

export const createTaskSchema = z.object({
  title: z.string().trim().min(3, "Give the task a title of at least 3 characters").max(200),
  description: z.string().trim().max(5000).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  unassigned: z.boolean().optional(),
  priority: TaskPriority.default("normal"),
  categoryKey: z.string().trim().min(1).max(60).optional(),
  dueAt: isoDateTime.nullable().optional(),
  duePrecision: DuePrecision.optional(),
  dueSourcePhrase: z.string().trim().max(200).optional(),
  clientId: z.string().trim().max(120).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    version: z.number().int().nonnegative(),
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    priority: TaskPriority.optional(),
    categoryKey: z.string().trim().min(1).max(60).nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    unassigned: z.boolean().optional(),
    dueAt: isoDateTime.nullable().optional(),
    duePrecision: DuePrecision.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 1, { message: "Nothing to update" });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const transitionTaskSchema = z.object({
  version: z.number().int().nonnegative(),
  status: TaskStatus,
  reason: z.string().trim().max(500).optional(),
  blockedReason: z.string().trim().max(500).optional(),
});
export type TransitionTaskInput = z.infer<typeof transitionTaskSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(4000),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const createDependencySchema = z.object({
  dependsOnTaskId: z.string().uuid(),
});
export type CreateDependencyInput = z.infer<typeof createDependencySchema>;

export const proposeHandoverSchema = z.object({
  toUserId: z.string().uuid(),
  taskIds: z.array(z.string().uuid()).min(1).max(100),
  note: z.string().trim().max(500).optional(),
});
export type ProposeHandoverInput = z.infer<typeof proposeHandoverSchema>;

export const respondHandoverSchema = z.object({
  decision: z.enum(["accept", "decline"]),
  note: z.string().trim().max(500).optional(),
});
export type RespondHandoverInput = z.infer<typeof respondHandoverSchema>;

export const updateSettingsSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  reminderLeadMinutes: z.number().int().min(0).max(10080).optional(),
  weeklyOverdueDay: z.number().int().min(0).max(6).optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const categorySchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, "Use lower_snake_case keys"),
  label: z.string().trim().min(2).max(60),
});
export type CategoryInput = z.infer<typeof categorySchema>;

/* ------------------------------------------------------------------------------------------
 * Assistant extraction
 * ---------------------------------------------------------------------------------------- */

export const extractRequestSchema = z.object({
  text: z.string().trim().min(3, "Say a little more").max(2000),
  timeZone: z.string().min(1).max(64).optional(),
});
export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const extractionDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000),
  ownerName: z.string().trim().max(120).nullable(),
  duePhrase: z.string().trim().max(120).nullable(),
  dueAt: isoDateTime.nullable(),
  duePrecision: DuePrecision.nullable(),
  priority: TaskPriority,
  categoryKey: z.string().trim().max(60).nullable(),
});
export type ExtractionDraft = z.infer<typeof extractionDraftSchema>;

export const extractResponseSchema = z.object({
  draft: extractionDraftSchema,
  warnings: z.array(z.string()),
  provider: z.enum(["rules", "ai", "none"]),
  requiresConfirmation: z.literal(true),
  sensitiveDataDetected: z.boolean(),
});
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

/* ------------------------------------------------------------------------------------------
 * Offline sync
 * ---------------------------------------------------------------------------------------- */

export const syncOperationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["task.create", "task.update", "task.transition", "comment.create"]),
  at: isoDateTime.optional(),
  payload: z.record(z.unknown()),
});
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncRequestSchema = z.object({
  operations: z.array(syncOperationSchema).max(50),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const syncResultSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["applied", "replayed", "conflict", "rejected"]),
  detail: z.string().optional(),
  taskId: z.string().uuid().optional(),
  serverVersion: z.number().int().optional(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

/* ------------------------------------------------------------------------------------------
 * Response shapes
 * ---------------------------------------------------------------------------------------- */

export interface MeResponse {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
  branch: { id: string; name: string; timezone: string };
  role: Role;
  permissions: PermissionAction[];
  settings: { quietHoursStart: string | null; quietHoursEnd: string | null; reminderLeadMinutes: number };
}

export interface TaskDto {
  id: string;
  branchId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  categoryKey: string | null;
  ownerId: string | null;
  ownerName: string | null;
  unassigned: boolean;
  blockedReason: string | null;
  dueAt: string | null;
  duePrecision: DuePrecision | null;
  dueSourcePhrase: string | null;
  completedAt: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  isOverdue: boolean;
  dependencyCount: number;
  blockedByCount: number;
}

export interface TaskListResponse {
  items: TaskDto[];
  total: number;
  nextCursor: string | null;
}

export interface ActivityEvent {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  kind: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

export interface DashboardResponse {
  counts: Record<"dueToday" | "overdue" | "blocked" | "inProgress" | "mine" | "unassigned", number>;
  upcoming: TaskDto[];
  teamLoad: Array<{ ownerId: string | null; ownerName: string | null; open: number; overdue: number }>;
}

export interface AnalyticsSummary {
  windowDays: number;
  created: number;
  completed: number;
  cancelled: number;
  reopened: number;
  medianCompletionHours: number | null;
  onTimeRate: number | null;
  blockedNow: number;
  byCategory: Array<{ categoryKey: string | null; count: number }>;
}

export interface NotificationDto {
  id: string;
  kind: string;
  taskId: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  prevHash: string | null;
  hash: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  errors?: Array<{ path: string; message: string }>;
  current?: unknown;
}

export const statusFilterValues = ["all", "mine", "team", "due_today", "overdue", "blocked"] as const;
export type StatusFilter = (typeof statusFilterValues)[number];
