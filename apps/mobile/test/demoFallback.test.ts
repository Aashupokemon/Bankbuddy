import assert from "node:assert/strict";
import { test } from "node:test";

import { DEMO_ACCOUNT, demoRequest } from "../src/demo.ts";
import { ApiFailure, createApiClient, type ApiClientOptions } from "../src/http.ts";

/**
 * The demo fallback is what keeps the app usable on a phone with no route to the API, so these
 * tests pin down two things: the bundled data really answers the board and task screens with the
 * shapes they read, and the transport decides whether the fallback happens at all.
 */

function client(overrides: Partial<ApiClientOptions> = {}) {
  return createApiClient({
    baseUrl: "http://10.0.2.2:8787",
    demo: demoRequest,
    getToken: async () => null,
    // Offline by default: nothing should reach a real address from a test.
    fetchImpl: (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch,
    ...overrides,
  });
}

const TASK_STATUSES = new Set(["open", "in_progress", "blocked", "done", "cancelled"]);

test("demo data answers the board's requests with the shapes it renders", async () => {
  const app = client();

  const dashboard = await app.api.dashboard();
  for (const key of ["overdue", "dueToday", "blocked", "inProgress", "mine", "unassigned"] as const) {
    assert.equal(typeof dashboard.counts[key], "number", `counts.${key} is a number`);
  }
  assert.ok(dashboard.upcoming.length > 0, "the board has cards to show");
  for (const item of dashboard.upcoming) {
    assert.ok(item.id, "every card has an id to open");
    assert.ok(item.title.length > 0);
    assert.ok(TASK_STATUSES.has(item.status), `unexpected status ${item.status}`);
    assert.ok(Array.isArray(dashboard.teamLoad));
  }

  const list = await app.api.tasks({ limit: 30 });
  assert.equal(list.items.length, list.total);
  assert.equal(list.nextCursor, null);
  assert.ok(list.items.every((item) => item.branchId === DEMO_ACCOUNT.branch.id));
});

test("demo data answers every request the task screen makes for a task", async () => {
  const app = client();

  const task = await app.api.task("demo-task-3");
  assert.equal(task.id, "demo-task-3");
  assert.equal(task.branchId, DEMO_ACCOUNT.branch.id);
  assert.equal(typeof task.version, "number");
  assert.ok(task.dependencyCount > 0 && task.blockedByCount > 0);

  const comments = await app.api.comments("demo-task-1");
  assert.ok(comments.items.length > 0);
  assert.ok(comments.items.every((comment) => comment.id && comment.authorName && comment.createdAt));

  // A task with no recorded history still gets at least its creation event, as the live API does.
  const activity = await app.api.activity("demo-task-2");
  assert.ok(activity.items.length > 0);
  assert.ok(activity.items.every((event) => event.id && event.summary && event.createdAt));

  const dependencies = await app.api.dependencies("demo-task-3");
  assert.equal(dependencies.blocking.length, 1);
  assert.equal(dependencies.blocking[0]?.dependsOnTaskId, "demo-task-1");
  assert.ok(dependencies.blocking[0]!.dependsOnTitle.length > 0);
  assert.deepEqual(dependencies.blockedBy, []);
});

test("dev-login returns the demo account and the sign-in list can reach it", async () => {
  const app = client();

  const session = await app.api.login("priya@alpha.example", DEMO_ACCOUNT.branch.id);
  assert.equal(session.token, "demo-session");
  assert.deepEqual(session.me, DEMO_ACCOUNT);
  assert.equal(session.me.role, "manager");
  assert.ok(session.me.permissions.includes("task.update.any"));

  const users = await app.api.devUsers();
  assert.equal(users.users.length, 1);
  assert.equal(users.users[0]?.branchId, DEMO_ACCOUNT.branch.id);
  assert.match(users.users[0]!.branch, /demo/);
});

test("demo data does not invent an answer for a path it does not know", () => {
  assert.equal(demoRequest("/api/v1/unknown-endpoint", "GET", undefined), undefined);
  assert.equal(demoRequest("/api/v1/dashboard", "DELETE", undefined), undefined);
});

test("a transport failure falls back to demo data", async () => {
  const calls: string[] = [];
  const app = client({
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new TypeError("Network request failed");
    }) as typeof fetch,
  });

  const dashboard = await app.api.dashboard();

  assert.deepEqual(calls, ["http://10.0.2.2:8787/api/v1/dashboard"]);
  assert.equal(app.isDemoMode(), true);
  assert.ok(dashboard.upcoming.length > 0, "the board is populated from bundled data");
});

test("demo data answers the chore and shift screens", async () => {
  const app = client();

  const templates = await app.api.templates();
  assert.ok(templates.items.length > 0, "a fresh demo has chores to show");
  assert.ok(templates.items.every((template) => template.cadence === "daily" || template.weekday !== null));

  // Wednesday: only the daily chore is due, and a second run creates nothing.
  const wednesday = "2026-12-09";
  const first = await app.api.runTemplates(wednesday);
  assert.equal(first.created, 1);
  assert.equal(first.items[0]?.duePrecision, "datetime");
  const second = await app.api.runTemplates(wednesday);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);

  const board = await app.api.tasks({ limit: 50 });
  const picked = board.items.slice(0, 2).map((task) => task.id);
  const moved = await app.api.bulkReassign(picked, "demo-arun");
  assert.equal(moved.updated, 2);
  assert.equal((await app.api.task(picked[0]!)).ownerId, "demo-arun");

  const handover = await app.api.handoverShift("demo-arun");
  assert.ok(handover.id);
  const handovers = await app.api.handovers();
  assert.equal(handovers.items[0]?.scope, "shift");
});

test("an HTTP error from a reachable API is surfaced instead of falling back", async () => {
  const app = client({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ title: "Branch not found", code: "branch_not_found" }), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      })) as typeof fetch,
  });

  await assert.rejects(
    () => app.api.dashboard(),
    (error: unknown) => {
      assert.ok(error instanceof ApiFailure, "the failure keeps its HTTP status");
      assert.equal(error.status, 404);
      assert.equal(error.code, "branch_not_found");
      assert.equal(error.message, "Branch not found");
      return true;
    },
  );

  assert.equal(app.isDemoMode(), false, "a reachable server never switches the app to demo data");
});

test("a non-JSON error body still surfaces as ApiFailure", async () => {
  const app = client({
    fetchImpl: (async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
  });

  await assert.rejects(
    () => app.api.dashboard(),
    (error: unknown) => {
      assert.ok(error instanceof ApiFailure, "an HTML error page must not become a raw SyntaxError");
      assert.equal(error.status, 502);
      assert.equal(error.code, "error");
      assert.equal(error.message, "Request failed (502)");
      return true;
    },
  );

  // An HTTP error from a reachable server still surfaces; only transport failures use demo data.
  assert.equal(app.isDemoMode(), false);
});
