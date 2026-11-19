import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import {
  can,
  permissionActions,
  type MeResponse,
  type PermissionAction,
  type Role,
} from "@bankbuddy/contracts";
import type { Queryable } from "@bankbuddy/db";
import type { Database } from "@bankbuddy/db";

import { ApiError } from "./http.ts";

export interface Identity {
  userId: string;
  branchId: string;
  workspaceId: string;
  role: Role;
  name: string;
  email: string;
  branchName: string;
  timezone: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

interface SessionRow {
  user_id: string;
  branch_id: string;
  workspace_id: string;
  role: Role;
  name: string;
  email: string;
  branch_name: string;
  timezone: string;
  revoked_at: string | null;
}

export async function resolveSession(database: Database, token: string): Promise<Identity | null> {
  const rows = await database.query<SessionRow>(
    `select s.user_id, s.branch_id, b.workspace_id, m.role,
            u.name, u.email, b.name as branch_name, b.timezone, s.revoked_at
       from sessions s
       join users u on u.id = s.user_id
       join branches b on b.id = s.branch_id
       join memberships m on m.branch_id = s.branch_id and m.user_id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows.rows[0];
  if (!row || row.revoked_at) return null;

  return {
    userId: row.user_id,
    branchId: row.branch_id,
    workspaceId: row.workspace_id,
    role: row.role,
    name: row.name,
    email: row.email,
    branchName: row.branch_name,
    timezone: row.timezone,
  };
}

export function authentication(database: Database) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.header("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) {
        next(ApiError.unauthenticated());
        return;
      }
      const identity = await resolveSession(database, match[1]!.trim());
      if (!identity) {
        next(ApiError.unauthenticated());
        return;
      }
      req.identity = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireIdentity(req: Request): Identity {
  if (!req.identity) throw ApiError.unauthenticated();
  return req.identity;
}

export function assertPermission(identity: Identity, action: PermissionAction): void {
  if (!can(identity.role, action)) {
    throw ApiError.forbidden(`role_${identity.role}_cannot_${action.replaceAll(".", "_")}`);
  }
}

export function requirePermission(req: Request, action: PermissionAction): Identity {
  const identity = requireIdentity(req);
  if (!can(identity.role, action)) {
    throw ApiError.forbidden(`role_${identity.role}_cannot_${action.replaceAll(".", "_")}`);
  }
  return identity;
}

export function permissionsFor(role: Role): PermissionAction[] {
  return permissionActions.filter((action) => can(role, action));
}

export function meResponse(identity: Identity, settings: {
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  reminder_lead_minutes: number;
}): MeResponse {
  return {
    user: { id: identity.userId, name: identity.name, email: identity.email },
    workspace: { id: identity.workspaceId, name: "BankBuddy Pilot Workspace (synthetic)" },
    branch: { id: identity.branchId, name: identity.branchName, timezone: identity.timezone },
    role: identity.role,
    permissions: permissionsFor(identity.role),
    settings: {
      quietHoursStart: settings.quiet_hours_start,
      quietHoursEnd: settings.quiet_hours_end,
      reminderLeadMinutes: settings.reminder_lead_minutes,
    },
  };
}

/**
 * Development sign-in: no password, synthetic users only, never enabled in production.
 *
 * A user can belong to more than one branch (the workspace admin does), so the branch is part of the
 * sign-in choice: `/auth/users` lists one row per membership and the client sends that `branchId` back.
 * Without it, the first membership is used, which would silently sign in to the wrong branch.
 */
export async function devLogin(
  database: Database,
  email: string,
  branchId?: string | null,
): Promise<{ token: string; identity: Identity }> {
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(404, "not_found", "Not available");
  }

  const rows = await database.query<{ id: string; name: string; email: string; branch_id: string }>(
    `select u.id, u.name, u.email, m.branch_id
       from users u
       join memberships m on m.user_id = u.id
      where lower(u.email) = lower($1)
        and ($2::uuid is null or m.branch_id = $2::uuid)
      order by m.created_at
      limit 1`,
    [email, branchId ?? null],
  );
  const user = rows.rows[0];
  if (!user) throw ApiError.notFound("User");

  const token = newToken();
  await database.query(
    `insert into sessions (token_hash, user_id, branch_id, device_label) values ($1, $2, $3, $4)`,
    [hashToken(token), user.id, user.branch_id, "android"],
  );
  const identity = await resolveSession(database, token);
  if (!identity) throw new ApiError(500, "session_failed", "Could not create a session");
  return { token, identity };
}

export async function listDevUsers(
  database: Database,
): Promise<Array<{ email: string; name: string; role: string; branch: string; branchId: string }>> {
  const rows = await database.query<{
    email: string;
    name: string;
    role: string;
    branch: string;
    branch_id: string;
  }>(
    `select u.email, u.name, m.role, b.name as branch, m.branch_id
       from users u
       join memberships m on m.user_id = u.id
       join branches b on b.id = m.branch_id
      order by b.name, m.role, u.name`,
  );
  return rows.rows.map((row) => ({
    email: row.email,
    name: row.name,
    role: row.role,
    branch: row.branch,
    branchId: row.branch_id,
  }));
}

export function touchSession(database: Database, token: string): void {
  void database
    .query("update sessions set last_seen_at = now() where token_hash = $1 and revoked_at is null", [hashToken(token)])
    .catch(() => undefined);
}

export async function revokeSession(database: Database, token: string): Promise<void> {
  await database.query("update sessions set revoked_at = now() where token_hash = $1", [hashToken(token)]);
}

export type { Queryable };
