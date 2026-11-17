import express, { type Request, type Response } from "express";

import {
  categorySchema,
  createCommentSchema,
  createDependencySchema,
  createTaskSchema,
  proposeHandoverSchema,
  respondHandoverSchema,
  taskStatuses,
  transitionTaskSchema,
  updateSettingsSchema,
  updateTaskSchema,
  type TaskStatus,
} from "@bankbuddy/contracts";
import type { Database, Queryable } from "@bankbuddy/db";
import { withRequestContext } from "@bankbuddy/db";

import {
  analyticsSummary,
  acknowledgeAll,
  acknowledgeNotification,
  createCategory,
  getSettings,
  listAuditEvents,
  listCategories,
  listMembers,
  listNotifications,
  taskActivity,
  updateSettings,
  verifyAuditChain,
} from "./admin.ts";
import { extractDraft } from "./assistant.ts";
import {
  authentication,
  devLogin,
  listDevUsers,
  meResponse,
  requireIdentity,
  revokeSession,
  type Identity,
} from "./auth.ts";
import {
  addComment,
  addDependency,
  listComments,
  listDependencies,
  listHandovers,
  proposeHandover,
  removeDependency,
  respondHandover,
} from "./collaboration.ts";
import { ApiError, errorHandler, ifMatchVersion, parseBody, route } from "./http.ts";
import { runSync } from "./sync.ts";
import {
  createTask,
  dashboard,
  getTaskRow,
  listTasks,
  mapTask,
  softDeleteTask,
  transitionTask,
  updateTask,
} from "./tasks.ts";

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listOf(value: unknown): string[] | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

export function createApp(database: Database): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", req.header("origin") ?? "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type,if-match");
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  /**
   * Runs a handler inside one transaction whose branch/user context drives row-level security.
   */
  const scoped = async <T>(
    req: Request,
    fn: (tx: Queryable, identity: Identity) => Promise<T>,
  ): Promise<T> => {
    const identity = requireIdentity(req);
    return withRequestContext(
      database,
      { userId: identity.userId, branchId: identity.branchId },
      (tx) => fn(tx, identity),
    );
  };

  const body = (req: Request, res: Response, payload: unknown, status = 200): void => {
    res.status(status).json(payload);
  };

  /* ---------------------------------------------------------------- authentication (public) */

  app.get(
    "/api/v1/auth/users",
    route(async (_req, res) => {
      if (process.env.NODE_ENV === "production") throw ApiError.notFound();
      body(_req, res, { users: await listDevUsers(database) });
    }),
  );

  app.post(
    "/api/v1/auth/dev-login",
    route(async (req, res) => {
      const email = queryString((req.body as { email?: unknown })?.email);
      if (!email) throw ApiError.validation("Email is required", [{ path: "email", message: "Required" }]);
      const result = await devLogin(database, email);
      const settings = await scoped(
        { ...req, identity: result.identity } as Request,
        async (tx, identity) => getSettings(tx, identity),
      );
      body(req, res, { token: result.token, me: meResponse(result.identity, {
        quiet_hours_start: settings.quietHoursStart,
        quiet_hours_end: settings.quietHoursEnd,
        reminder_lead_minutes: settings.reminderLeadMinutes,
      }) });
    }),
  );

  app.use("/api/v1", authentication(database));

  app.post(
    "/api/v1/auth/logout",
    route(async (req, res) => {
      const header = req.header("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match) await revokeSession(database, match[1]!.trim());
      res.status(204).end();
    }),
  );

  /* ---------------------------------------------------------------- me, members, dashboard */

  app.get(
    "/api/v1/me",
    route(async (req, res) => {
      const payload = await scoped(req, async (tx, identity) => {
        const settings = await getSettings(tx, identity);
        return meResponse(identity, {
          quiet_hours_start: settings.quietHoursStart,
          quiet_hours_end: settings.quietHoursEnd,
          reminder_lead_minutes: settings.reminderLeadMinutes,
        });
      });
      body(req, res, payload);
    }),
  );

  app.get(
    "/api/v1/members",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => listMembers(tx, identity)) });
    }),
  );

  app.get(
    "/api/v1/dashboard",
    route(async (req, res) => {
      body(req, res, await scoped(req, (tx, identity) => dashboard(tx, identity)));
    }),
  );

  /* ---------------------------------------------------------------- tasks */

  app.get(
    "/api/v1/tasks",
    route(async (req, res) => {
      const statuses = listOf(req.query.status)?.filter((s): s is TaskStatus =>
        (taskStatuses as readonly string[]).includes(s),
      );
      const filter = queryString(req.query.filter);
      const payload = await scoped(req, (tx, identity) =>
        listTasks(tx, identity, {
          ...(queryString(req.query.scope) ? { scope: queryString(req.query.scope) as "mine" | "team" | "all" } : {}),
          ...(statuses?.length ? { status: statuses } : {}),
          ...(filter === "due_today" || filter === "overdue" || filter === "blocked" ? { filter } : {}),
          ...(req.query.ownerId !== undefined
            ? { ownerId: queryString(req.query.ownerId) ?? null }
            : {}),
          ...(queryString(req.query.categoryKey) ? { categoryKey: queryString(req.query.categoryKey)! } : {}),
          ...(listOf(req.query.priority) ? { priority: listOf(req.query.priority)! } : {}),
          ...(queryString(req.query.q) ? { q: queryString(req.query.q)! } : {}),
          ...(queryString(req.query.cursor) ? { cursor: queryString(req.query.cursor)! } : {}),
          ...(queryString(req.query.sort) ? { sort: queryString(req.query.sort) as "due" | "updated" | "created" } : {}),
          ...(queryString(req.query.limit) ? { limit: Number(queryString(req.query.limit)) } : {}),
        }),
      );
      body(req, res, payload);
    }),
  );

  app.post(
    "/api/v1/tasks",
    route(async (req, res) => {
      const input = parseBody(createTaskSchema, req.body);
      const created = await scoped(req, (tx, identity) => createTask(tx, identity, input));
      res.status(201).setHeader("etag", `"${created.version}"`).json(created);
    }),
  );

  app.get(
    "/api/v1/tasks/:id",
    route(async (req, res) => {
      const payload = await scoped(req, async (tx, identity) => {
        const row = await getTaskRow(tx, identity, String(req.params.id));
        return mapTask(row, identity.timezone);
      });
      body(req, res, payload);
    }),
  );

  app.patch(
    "/api/v1/tasks/:id",
    route(async (req, res) => {
      const parsed = parseBody(updateTaskSchema, req.body);
      const headerVersion = ifMatchVersion(req);
      const input = headerVersion === null ? parsed : { ...parsed, version: headerVersion };
      const updated = await scoped(req, (tx, identity) => updateTask(tx, identity, String(req.params.id), input));
      res.setHeader("etag", `"${updated.version}"`).json(updated);
    }),
  );

  app.delete(
    "/api/v1/tasks/:id",
    route(async (req, res) => {
      await scoped(req, (tx, identity) => softDeleteTask(tx, identity, String(req.params.id)));
      res.status(204).end();
    }),
  );

  app.post(
    "/api/v1/tasks/:id/status",
    route(async (req, res) => {
      const parsed = parseBody(transitionTaskSchema, req.body);
      const headerVersion = ifMatchVersion(req);
      const input = headerVersion === null ? parsed : { ...parsed, version: headerVersion };
      const updated = await scoped(req, (tx, identity) => transitionTask(tx, identity, String(req.params.id), input));
      res.setHeader("etag", `"${updated.version}"`).json(updated);
    }),
  );

  app.get(
    "/api/v1/tasks/:id/activity",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => taskActivity(tx, identity, String(req.params.id))) });
    }),
  );

  app.get(
    "/api/v1/tasks/:id/comments",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => listComments(tx, identity, String(req.params.id))) });
    }),
  );

  app.post(
    "/api/v1/tasks/:id/comments",
    route(async (req, res) => {
      const input = parseBody(createCommentSchema, req.body);
      const comment = await scoped(req, (tx, identity) => addComment(tx, identity, String(req.params.id), input));
      res.status(201).json(comment);
    }),
  );

  app.get(
    "/api/v1/tasks/:id/dependencies",
    route(async (req, res) => {
      body(req, res, await scoped(req, (tx, identity) => listDependencies(tx, identity, String(req.params.id))));
    }),
  );

  app.post(
    "/api/v1/tasks/:id/dependencies",
    route(async (req, res) => {
      const input = parseBody(createDependencySchema, req.body);
      await scoped(req, (tx, identity) => addDependency(tx, identity, String(req.params.id), input.dependsOnTaskId));
      res.status(201).json({ ok: true });
    }),
  );

  app.delete(
    "/api/v1/tasks/:id/dependencies/:dependencyId",
    route(async (req, res) => {
      await scoped(req, (tx, identity) =>
        removeDependency(tx, identity, String(req.params.id), String(req.params.dependencyId)),
      );
      res.status(204).end();
    }),
  );

  /* ---------------------------------------------------------------- handover */

  app.get(
    "/api/v1/handovers",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => listHandovers(tx, identity)) });
    }),
  );

  app.post(
    "/api/v1/handovers",
    route(async (req, res) => {
      const input = parseBody(proposeHandoverSchema, req.body);
      const handover = await scoped(req, (tx, identity) => proposeHandover(tx, identity, input));
      res.status(201).json(handover);
    }),
  );

  app.post(
    "/api/v1/handovers/:id/respond",
    route(async (req, res) => {
      const input = parseBody(respondHandoverSchema, req.body);
      const handover = await scoped(req, (tx, identity) => respondHandover(tx, identity, String(req.params.id), input));
      body(req, res, handover);
    }),
  );

  /* ---------------------------------------------------------------- assistant */

  app.post(
    "/api/v1/assistant/extract",
    route(async (req, res) => {
      const payload = await scoped(req, (tx, identity) => extractDraft(tx, identity, req.body ?? {}));
      body(req, res, payload);
    }),
  );

  /* ---------------------------------------------------------------- notifications */

  app.get(
    "/api/v1/notifications",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => listNotifications(tx, identity)) });
    }),
  );

  app.post(
    "/api/v1/notifications/read-all",
    route(async (req, res) => {
      const count = await scoped(req, (tx, identity) => acknowledgeAll(tx, identity));
      body(req, res, { acknowledged: count });
    }),
  );

  app.post(
    "/api/v1/notifications/:id/ack",
    route(async (req, res) => {
      await scoped(req, (tx, identity) => acknowledgeNotification(tx, identity, String(req.params.id)));
      res.status(204).end();
    }),
  );

  /* ---------------------------------------------------------------- audit, analytics, settings */

  app.get(
    "/api/v1/audit/events",
    route(async (req, res) => {
      const payload = await scoped(req, (tx, identity) =>
        listAuditEvents(tx, identity, {
          ...(queryString(req.query.action) ? { action: queryString(req.query.action)! } : {}),
          ...(queryString(req.query.entityType) ? { entityType: queryString(req.query.entityType)! } : {}),
          ...(queryString(req.query.entityId) ? { entityId: queryString(req.query.entityId)! } : {}),
          ...(queryString(req.query.actorId) ? { actorId: queryString(req.query.actorId)! } : {}),
          ...(queryString(req.query.cursor) ? { cursor: queryString(req.query.cursor)! } : {}),
          ...(queryString(req.query.limit) ? { limit: Number(queryString(req.query.limit)) } : {}),
        }),
      );
      body(req, res, payload);
    }),
  );

  app.get(
    "/api/v1/audit/verify",
    route(async (req, res) => {
      const result = await scoped(req, async (tx, identity) => {
        const { assertPermission } = await import("./auth.ts");
        assertPermission(identity, "audit.read");
        return verifyAuditChain(tx, identity.branchId);
      });
      body(req, res, result);
    }),
  );

  app.get(
    "/api/v1/analytics/summary",
    route(async (req, res) => {
      const windowDays = Number(queryString(req.query.windowDays) ?? 30);
      const payload = await scoped(req, async (tx, identity) => {
        const { assertPermission } = await import("./auth.ts");
        assertPermission(identity, "analytics.read");
        return analyticsSummary(tx, identity, windowDays);
      });
      body(req, res, payload);
    }),
  );

  app.get(
    "/api/v1/settings",
    route(async (req, res) => {
      body(req, res, await scoped(req, (tx, identity) => getSettings(tx, identity)));
    }),
  );

  app.patch(
    "/api/v1/settings",
    route(async (req, res) => {
      const input = parseBody(updateSettingsSchema, req.body);
      body(req, res, await scoped(req, (tx, identity) => updateSettings(tx, identity, input)));
    }),
  );

  app.get(
    "/api/v1/categories",
    route(async (req, res) => {
      body(req, res, { items: await scoped(req, (tx, identity) => listCategories(tx, identity)) });
    }),
  );

  app.post(
    "/api/v1/categories",
    route(async (req, res) => {
      const input = parseBody(categorySchema, req.body);
      const created = await scoped(req, (tx, identity) => createCategory(tx, identity, input));
      res.status(201).json(created);
    }),
  );

  /* ---------------------------------------------------------------- offline sync */

  app.post(
    "/api/v1/sync/operations",
    route(async (req, res) => {
      const identity = requireIdentity(req);
      body(req, res, { results: await runSync(database, identity, req.body) });
    }),
  );

  app.use((_req, res) => {
    res.status(404).type("application/problem+json").json({
      type: "https://bankbuddy.example/problems/not_found",
      title: "No such endpoint",
      status: 404,
      code: "not_found",
    });
  });

  app.use(errorHandler);
  return app;
}
