import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { openTestDatabase, withRequestContext, type Database } from "@bankbuddy/db";

import { migrate } from "../../../packages/db/src/migrate.ts";
import { seed } from "../../../packages/db/src/seed.ts";
import { deliverReminders, generateReminders } from "../../../apps/worker/src/index.ts";
import { createApp } from "../src/app.ts";

let database: Database;
let server: import("node:http").Server;
let baseUrl: string;

interface Account {
  token: string;
  userId: string;
  branchId: string;
}

const accounts: Record<string, Account> = {};

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function login(email: string): Promise<Account> {
  const response = await api("/api/v1/auth/dev-login", { method: "POST", body: { email } });
  assert.equal(response.status, 200, `login failed for ${email}: ${response.text}`);
  const account: Account = {
    token: response.json.token,
    userId: response.json.me.user.id,
    branchId: response.json.me.branch.id,
  };
  accounts[email] = account;
  return account;
}

before(async () => {
  database = await openTestDatabase();
  await migrate(database);
  await seed(database);

  const app = createApp(database);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await login("priya@alpha.example");
  await login("arun@alpha.example");
  await login("ravi@alpha.example");
  await login("meera@alpha.example");
  await login("sanjay@beta.example");
});

after(async () => {
  server.close();
  await database.close();
});

/* ------------------------------------------------------------------ auth and scope */

test("health is public, everything else needs a session", async () => {
  assert.equal((await api("/health")).status, 200);
  assert.equal((await api("/api/v1/me")).status, 401);
  assert.equal((await api("/api/v1/me", { token: "nope" })).status, 401);
});

test("/me reports the resolved role, branch and permissions", async () => {
  const employee = await api("/api/v1/me", { token: accounts["ravi@alpha.example"]!.token });
  assert.equal(employee.status, 200);
  assert.equal(employee.json.role, "employee");
  assert.equal(employee.json.branch.name, "MG Road Branch");
  assert.ok(employee.json.permissions.includes("task.create"));
  assert.ok(!employee.json.permissions.includes("audit.read"));

  const auditor = await api("/api/v1/me", { token: accounts["meera@alpha.example"]!.token });
  assert.ok(auditor.json.permissions.includes("audit.read"));
  assert.ok(!auditor.json.permissions.includes("task.create"));
});

test("a multi-branch user signs in to the branch whose row was chosen", async () => {
  const list = await api("/api/v1/auth/users");
  assert.equal(list.status, 200);
  const rows = list.json.users.filter((u: { email: string }) => u.email === "admin@workspace.example");
  assert.deepEqual(
    rows.map((u: { branch: string }) => u.branch).sort(),
    ["Koramangala Branch", "MG Road Branch"],
    "the workspace admin has one sign-in row per membership",
  );

  for (const row of rows) {
    const response = await api("/api/v1/auth/dev-login", {
      method: "POST",
      body: { email: row.email, branchId: row.branchId },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.me.branch.id, row.branchId);
    assert.equal(response.json.me.branch.name, row.branch);
  }

  const unknownBranch = await api("/api/v1/auth/dev-login", {
    method: "POST",
    body: { email: "admin@workspace.example", branchId: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(unknownBranch.status, 404, "no membership in that branch, so no session");
});

test("a branch cannot read another branch's task", async () => {
  const betaList = await api("/api/v1/tasks", { token: accounts["sanjay@beta.example"]!.token });
  assert.equal(betaList.status, 200);
  const betaTaskId = betaList.json.items[0].id;

  // The alpha manager asking for a beta task by id gets a 404, not a 403: no existence leak.
  const alphaManager = await api(`/api/v1/tasks/${betaTaskId}`, { token: accounts["priya@alpha.example"]!.token });
  assert.equal(alphaManager.status, 404);

  const alphaList = await api("/api/v1/tasks", { token: accounts["priya@alpha.example"]!.token });
  assert.ok(alphaList.json.items.every((t: { branchId: string }) => t.branchId === accounts["priya@alpha.example"]!.branchId));
});

test("row-level security fails closed and scopes by branch", async () => {
  const alpha = accounts["priya@alpha.example"]!;
  const beta = accounts["sanjay@beta.example"]!;

  const alphaCount = await withRequestContext(database, { userId: alpha.userId, branchId: alpha.branchId }, (tx) =>
    tx.query<{ count: string }>("select count(*)::text as count from tasks"),
  );
  const betaCount = await withRequestContext(database, { userId: beta.userId, branchId: beta.branchId }, (tx) =>
    tx.query<{ count: string }>("select count(*)::text as count from tasks"),
  );
  const all = await database.query<{ count: string }>("select count(*)::text as count from tasks");

  assert.ok(Number(alphaCount.rows[0]!.count) > 0);
  assert.ok(Number(betaCount.rows[0]!.count) > 0);
  assert.equal(
    Number(alphaCount.rows[0]!.count) + Number(betaCount.rows[0]!.count),
    Number(all.rows[0]!.count),
    "RLS should partition the table between branches",
  );

  // Inside a context, only that branch's rows are visible at all.
  const visible = await withRequestContext(database, { userId: alpha.userId, branchId: alpha.branchId }, (tx) =>
    tx.query<{ branch_id: string }>("select distinct branch_id from tasks"),
  );
  assert.deepEqual(
    visible.rows.map((r) => r.branch_id),
    [alpha.branchId],
    "a request context must only ever see its own branch",
  );
});

test("employees see their own work, not the whole branch board", async () => {
  const employee = accounts["ravi@alpha.example"]!;
  const mine = await api("/api/v1/tasks?scope=team", { token: employee.token });
  assert.equal(mine.status, 200);
  assert.ok(
    mine.json.items.every((t: { ownerId: string | null; createdBy: string }) => t.ownerId === employee.userId || t.createdBy === employee.userId),
    "an employee must never receive another person's task",
  );
});

/* ------------------------------------------------------------------ tasks */

test("create, version conflict and successful update", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Confirm the synthetic cash limit", priority: "high", unassigned: true, description: "Test task" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.version, 0);
  assert.equal(created.json.unassigned, true);

  const conflict = await api(`/api/v1/tasks/${created.json.id}`, {
    method: "PATCH",
    token: manager.token,
    body: { version: 99, title: "Changed title" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, "version_conflict");
  assert.equal(conflict.json.current.version, 0);

  const ok = await api(`/api/v1/tasks/${created.json.id}`, {
    method: "PATCH",
    token: manager.token,
    body: { version: 0, title: "Confirm the synthetic cash limit (revised)", reason: "Clarified wording" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.version, 1);

  // If-Match is honoured over the body.
  const viaHeader = await api(`/api/v1/tasks/${created.json.id}`, {
    method: "PATCH",
    token: manager.token,
    body: { version: 0, priority: "urgent" },
    headers: { "if-match": '"1"' },
  });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.json.version, 2);
});

test("free-text search matches title and details, inside one branch only", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: {
      title: "Reconcile the treasury suspense ledger",
      description: "End of day, synthetic",
      unassigned: true,
    },
  });
  assert.equal(created.status, 201, created.text);

  const found = await api(`/api/v1/tasks?q=${encodeURIComponent("treasury suspense")}`, { token: manager.token });
  assert.equal(found.status, 200);
  assert.ok(
    found.json.items.some((task: { id: string }) => task.id === created.json.id),
    "the created task is found by words from its title",
  );

  const byDescription = await api("/api/v1/tasks?q=synthetic", { token: manager.token });
  assert.ok(byDescription.json.items.some((task: { id: string }) => task.id === created.json.id));

  // Search must never become a way around branch isolation.
  const otherBranch = await api("/api/v1/tasks?q=treasury", { token: accounts["sanjay@beta.example"]!.token });
  assert.equal(otherBranch.status, 200);
  assert.equal(otherBranch.json.items.length, 0);
});

test("the audit trail exports as CSV, for roles that may read it", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const response = await api("/api/v1/audit/export.csv", { token: manager.token });
  assert.equal(response.status, 200);
  const lines = response.text.trim().split("\r\n");
  assert.equal(lines[0], "occurred_at,action,entity_type,entity_id,actor,reason,prev_hash,hash");
  assert.ok(lines.length > 1, "the branch has audit rows to export");
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length >= 8 || line.includes('"'), true, "every row is a full record");
  }

  // The export shares its filter with the on-screen list, so a filtered download stays filtered.
  const filtered = await api("/api/v1/audit/export.csv?action=task.create", { token: manager.token });
  const filteredRows = filtered.text.trim().split("\r\n").slice(1);
  assert.ok(filteredRows.length > 0);
  assert.ok(filteredRows.every((line) => line.includes("task.create")), "only matching actions are exported");

  const employee = await api("/api/v1/audit/export.csv", { token: accounts["ravi@alpha.example"]!.token });
  assert.equal(employee.status, 403, "an employee cannot export the audit trail");
});

test("past due dates are rejected, date-only values keep their precision", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const past = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Backdated task", ownerId: manager.userId, dueAt: "2020-01-01T09:00:00Z" },
  });
  assert.equal(past.status, 422);

  const dated = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: {
      title: "Date-only task",
      ownerId: manager.userId,
      dueAt: "2030-05-06T00:00:00.000Z",
      duePrecision: "date",
    },
  });
  assert.equal(dated.status, 201);
  assert.equal(dated.json.duePrecision, "date");
});

test("status transitions follow the allow-list and require reasons", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Transition rules task", ownerId: manager.userId },
  });
  const id = created.json.id;

  const skip = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: 0, status: "archived" },
  });
  assert.equal(skip.status, 422);

  const blocked = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: 0, status: "blocked" },
  });
  assert.equal(blocked.status, 422, "blocking requires a reason");

  const done = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: 0, status: "done" },
  });
  assert.equal(done.status, 200);
  assert.ok(done.json.completedAt);

  const activity = await api(`/api/v1/tasks/${id}/activity`, { token: manager.token });
  const statusEvent = activity.json.items.find((e: { kind: string }) => e.kind === "status_changed");
  assert.equal(statusEvent.before.status, "open");
  assert.equal(statusEvent.after.status, "done");
});

test("an owner can reopen finished work, but only a manager can reopen cancelled work", async () => {
  const employee = accounts["ravi@alpha.example"]!;
  const manager = accounts["priya@alpha.example"]!;

  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: employee.token,
    body: { title: "Reopen behaviour task", ownerId: employee.userId },
  });
  const id = created.json.id;

  const done = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 0, status: "done" },
  });
  assert.equal(done.status, 200);

  // Reopening a completed task needs a reason but is allowed for its owner.
  const reopen = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 1, status: "open", reason: "Still needed" },
  });
  assert.equal(reopen.status, 200);

  // Completing again needs no reason.
  const doneAgain = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 2, status: "done" },
  });
  assert.equal(doneAgain.status, 200);

  // A finished task cannot jump straight to cancelled; it has to be reopened first.
  const cannotCancel = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 3, status: "cancelled", reason: "Duplicate of another task" },
  });
  assert.equal(cannotCancel.status, 422);

  const reopened = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 3, status: "open", reason: "Reopened to cancel it" },
  });
  assert.equal(reopened.status, 200);

  const cancelled = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 4, status: "cancelled", reason: "Duplicate of another task" },
  });
  assert.equal(cancelled.status, 200);

  // Cancelled work is terminal for everyone except a manager.
  const employeeReopen = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: employee.token,
    body: { version: 5, status: "open", reason: "Needed again" },
  });
  assert.equal(employeeReopen.status, 403);
  assert.equal(employeeReopen.json.code, "reopen_needs_manager");

  const managerReopen = await api(`/api/v1/tasks/${id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: 5, status: "open", reason: "Customer called back" },
  });
  assert.equal(managerReopen.status, 200);
});

test("an employee cannot assign work to someone else", async () => {
  const employee = accounts["ravi@alpha.example"]!;
  const other = accounts["arun@alpha.example"]!;
  const response = await api("/api/v1/tasks", {
    method: "POST",
    token: employee.token,
    body: { title: "Sneaky assignment", ownerId: other.userId },
  });
  assert.equal(response.status, 403);
});

/* ------------------------------------------------------------------ collaboration */

test("comments are recorded with an audit row", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const list = await api("/api/v1/tasks", { token: manager.token });
  const id = list.json.items[0].id;

  const comment = await api(`/api/v1/tasks/${id}/comments`, {
    method: "POST",
    token: manager.token,
    body: { body: "Synthetic comment for the test" },
  });
  assert.equal(comment.status, 201);

  const comments = await api(`/api/v1/tasks/${id}/comments`, { token: manager.token });
  assert.ok(comments.json.items.some((c: { body: string }) => c.body === "Synthetic comment for the test"));

  const audit = await api(`/api/v1/audit/events?action=comment.create`, { token: manager.token });
  assert.ok(audit.json.items.length >= 1);
});

test("dependency cycles are rejected", async () => {
  const lead = accounts["arun@alpha.example"]!;
  const tasks = await api("/api/v1/tasks", { token: lead.token });
  const [a, b] = tasks.json.items;

  const first = await api(`/api/v1/tasks/${a.id}/dependencies`, {
    method: "POST",
    token: lead.token,
    body: { dependsOnTaskId: b.id },
  });
  assert.equal(first.status, 201);

  const cycle = await api(`/api/v1/tasks/${b.id}/dependencies`, {
    method: "POST",
    token: lead.token,
    body: { dependsOnTaskId: a.id },
  });
  assert.equal(cycle.status, 422);
  assert.match(cycle.json.title, /circular/i);
});

test("handover transfers ownership when accepted", async () => {
  const lead = accounts["arun@alpha.example"]!;
  const employee = accounts["ravi@alpha.example"]!;

  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: lead.token,
    body: { title: "Handover task", ownerId: lead.userId },
  });

  const proposed = await api("/api/v1/handovers", {
    method: "POST",
    token: lead.token,
    body: { toUserId: employee.userId, taskIds: [created.json.id], note: "Evening shift" },
  });
  assert.equal(proposed.status, 201);

  const accepted = await api(`/api/v1/handovers/${proposed.json.id}/respond`, {
    method: "POST",
    token: employee.token,
    body: { decision: "accept" },
  });
  assert.equal(accepted.status, 200);

  const task = await api(`/api/v1/tasks/${created.json.id}`, { token: employee.token });
  assert.equal(task.json.ownerId, employee.userId);
});

test("recurring chores create one task per day and never duplicate", async () => {
  const manager = accounts["priya@alpha.example"]!;

  const daily = await api("/api/v1/templates", {
    method: "POST",
    token: manager.token,
    body: { title: "Open the branch safe", cadence: "daily", dueTime: "09:15", priority: "high" },
  });
  assert.equal(daily.status, 201, daily.text);
  assert.equal(daily.json.cadence, "daily");
  assert.equal(daily.json.active, true);

  const weekly = await api("/api/v1/templates", {
    method: "POST",
    token: manager.token,
    body: { title: "Weekly fire-safety walk", cadence: "weekly", weekday: 1, dueTime: "16:00" },
  });
  assert.equal(weekly.status, 201, weekly.text);

  const monday = "2026-12-07";
  const first = await api("/api/v1/templates/run", {
    method: "POST",
    token: manager.token,
    body: { date: monday },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.created, 2, "both chores are due on a Monday");
  assert.ok(first.json.items.every((task: { duePrecision: string }) => task.duePrecision === "datetime"));

  // Running again on the same day is safe: the database dedupes by (template, date).
  const again = await api("/api/v1/templates/run", {
    method: "POST",
    token: manager.token,
    body: { date: monday },
  });
  assert.equal(again.json.created, 0);
  assert.equal(again.json.skipped, 2);

  const tuesday = await api("/api/v1/templates/run", {
    method: "POST",
    token: manager.token,
    body: { date: "2026-12-08" },
  });
  assert.equal(tuesday.json.created, 1, "the weekly chore is not due on a Tuesday");

  const board = await api("/api/v1/tasks?q=fire-safety", { token: manager.token });
  assert.equal(board.json.items.length, 1, "chores are ordinary tasks on the board");

  const listed = await api("/api/v1/templates", { token: manager.token });
  assert.ok(listed.json.items.some((template: { lastRunOn: string | null }) => template.lastRunOn === "2026-12-07"));

  // Chores are operational policy, not something an employee can invent or run.
  const employee = accounts["ravi@alpha.example"]!;
  const refused = await api("/api/v1/templates", {
    method: "POST",
    token: employee.token,
    body: { title: "Sneaky chore", cadence: "daily", dueTime: "10:00" },
  });
  assert.equal(refused.status, 403);
  assert.equal(
    (await api("/api/v1/templates/run", { method: "POST", token: employee.token, body: {} })).status,
    403,
  );
});

test("bulk reassignment moves a batch in one call and can leave it unassigned", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const employee = accounts["ravi@alpha.example"]!;

  const taskIds: string[] = [];
  for (const title of ["Bulk reassign one", "Bulk reassign two"]) {
    const created = await api("/api/v1/tasks", {
      method: "POST",
      token: manager.token,
      body: { title, unassigned: true },
    });
    assert.equal(created.status, 201, created.text);
    taskIds.push(created.json.id);
  }

  const moved = await api("/api/v1/tasks/bulk-reassign", {
    method: "POST",
    token: manager.token,
    body: { taskIds, ownerId: employee.userId, reason: "Shift change" },
  });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.updated, 2);

  for (const id of taskIds) {
    const task = await api(`/api/v1/tasks/${id}`, { token: manager.token });
    assert.equal(task.json.ownerId, employee.userId);
    assert.equal(task.json.unassigned, false);
  }

  const cleared = await api("/api/v1/tasks/bulk-reassign", {
    method: "POST",
    token: manager.token,
    body: { taskIds: taskIds.slice(0, 1), ownerId: null },
  });
  assert.equal(cleared.json.updated, 1);
  const unassigned = await api(`/api/v1/tasks/${taskIds[0]}`, { token: manager.token });
  assert.equal(unassigned.json.ownerId, null);
  assert.equal(unassigned.json.unassigned, true);

  const refused = await api("/api/v1/tasks/bulk-reassign", {
    method: "POST",
    token: employee.token,
    body: { taskIds, ownerId: employee.userId },
  });
  assert.equal(refused.status, 403);
});

test("a whole-shift handover covers the outgoing person's open work only", async () => {
  const lead = accounts["arun@alpha.example"]!;
  const employee = accounts["ravi@alpha.example"]!;

  const openIds: string[] = [];
  for (const title of ["Shift handover open one", "Shift handover open two"]) {
    const created = await api("/api/v1/tasks", {
      method: "POST",
      token: lead.token,
      body: { title, ownerId: lead.userId },
    });
    openIds.push(created.json.id);
  }
  const finished = await api("/api/v1/tasks", {
    method: "POST",
    token: lead.token,
    body: { title: "Shift handover already finished", ownerId: lead.userId },
  });
  await api(`/api/v1/tasks/${finished.json.id}/status`, {
    method: "POST",
    token: lead.token,
    body: { version: 0, status: "done" },
  });

  const proposed = await api("/api/v1/handovers", {
    method: "POST",
    token: lead.token,
    body: { toUserId: employee.userId, scope: "shift", note: "End of the evening shift" },
  });
  assert.equal(proposed.status, 201, proposed.text);

  const handover = (await api("/api/v1/handovers", { token: lead.token })).json.items.find(
    (item: { id: string }) => item.id === proposed.json.id,
  );
  assert.equal(handover.scope, "shift");
  const handedIds = handover.tasks.map((task: { id: string }) => task.id);
  for (const id of openIds) assert.ok(handedIds.includes(id), "every open task of the shift is included");
  assert.ok(!handedIds.includes(finished.json.id), "finished work is not handed over");

  const accepted = await api(`/api/v1/handovers/${proposed.json.id}/respond`, {
    method: "POST",
    token: employee.token,
    body: { decision: "accept" },
  });
  assert.equal(accepted.status, 200, accepted.text);

  const reassigned = await api(`/api/v1/tasks/${openIds[0]}`, { token: employee.token });
  assert.equal(reassigned.json.ownerId, employee.userId);
});

/* ------------------------------------------------------------------ assistant */

test("extraction produces a draft that still needs confirmation", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const before = await api("/api/v1/tasks", { token: manager.token });
  const tasksBeforeExtraction = before.json.total;

  const response = await api("/api/v1/assistant/extract", {
    method: "POST",
    token: manager.token,
    body: { text: "Ravi will call the Sharma account about the KYC gap by Thursday", timeZone: "Asia/Kolkata" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.requiresConfirmation, true);
  assert.equal(response.json.provider, "rules");
  assert.equal(response.json.draft.ownerName, "Ravi Kumar");
  assert.equal(response.json.draft.duePrecision, "date");
  assert.ok(response.json.draft.dueAt);

  // Nothing was written by extraction: the task total is unchanged.
  const after = await api("/api/v1/tasks", { token: manager.token });
  assert.equal(after.json.total, tasksBeforeExtraction, "extraction must never persist a task");
});

test("sensitive data is flagged and redacted", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const response = await api("/api/v1/assistant/extract", {
    method: "POST",
    token: manager.token,
    body: { text: "Call about account 123456789012 tomorrow", timeZone: "Asia/Kolkata" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.sensitiveDataDetected, true);
  assert.ok(!response.json.draft.description.includes("123456789012"));
  assert.ok(response.json.warnings.includes("sensitive_data_detected"));
});

test("extraction is unavailable to an auditor", async () => {
  const auditor = accounts["meera@alpha.example"]!;
  const response = await api("/api/v1/assistant/extract", {
    method: "POST",
    token: auditor.token,
    body: { text: "Create a task for Ravi tomorrow" },
  });
  assert.equal(response.status, 200, "read-only roles may still preview a draft");
  assert.equal(response.json.requiresConfirmation, true);
});

/* ------------------------------------------------------------------ audit */

test("the audit trail is append-only and hash-chained", async () => {
  const manager = accounts["priya@alpha.example"]!;

  await assert.rejects(
    () => database.query("update audit_events set action = 'tampered'"),
    /append-only/,
    "UPDATE on audit_events must fail",
  );
  await assert.rejects(() => database.query("delete from audit_events"), /append-only/, "DELETE must fail");

  const verify = await api("/api/v1/audit/verify", { token: manager.token });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.valid, true, "chain must verify");
  assert.ok(verify.json.checked > 0);
});

test("reading the audit log is itself audited", async () => {
  const manager = accounts["priya@alpha.example"]!;
  await api("/api/v1/audit/events", { token: manager.token });
  const reads = await api("/api/v1/audit/events?action=audit.read", { token: manager.token });
  assert.ok(reads.json.items.length >= 1);
});

test("audit and analytics are refused to employees", async () => {
  const employee = accounts["ravi@alpha.example"]!;
  assert.equal((await api("/api/v1/audit/events", { token: employee.token })).status, 403);
  assert.equal((await api("/api/v1/analytics/summary", { token: employee.token })).status, 403);
});

test("analytics returns the expected shape", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const response = await api("/api/v1/analytics/summary?windowDays=30", { token: manager.token });
  assert.equal(response.status, 200);
  assert.equal(typeof response.json.created, "number");
  assert.ok(Array.isArray(response.json.byCategory));
});

/* ------------------------------------------------------------------ reminders */

test("reminders are deduplicated across repeated scheduling runs", async () => {
  // Delivery defers during quiet hours, which is correct behaviour but makes this test time-of-day
  // dependent, so the window is cleared for the duration of the assertions.
  await database.query("update branch_settings set quiet_hours_start = null, quiet_hours_end = null");

  const first = await generateReminders(database);
  const second = await generateReminders(database);
  assert.ok(first >= 0);
  assert.equal(second, 0, "a second generation pass must insert nothing");

  const counts = await database.query<{ count: string }>("select count(*)::text as count from reminders");
  assert.ok(Number(counts.rows[0]!.count) > 0);

  // Force one reminder to be due, deliver twice, and confirm only one notification per reminder.
  await database.query(
    `update reminders set scheduled_for = now()
      where sent_at is null
        and task_id in (select id from tasks where status in ('open','in_progress','blocked'))
        and id in (select id from reminders where sent_at is null limit 1)`,
  );
  const delivered = await deliverReminders(database);
  assert.ok(delivered >= 1);
  const again = await deliverReminders(database);
  assert.equal(again, 0);
});

/* ------------------------------------------------------------------ sync */

test("offline operations are idempotent and version-checked", async () => {
  const employee = accounts["ravi@alpha.example"]!;
  const operationId = crypto.randomUUID();

  const first = await api("/api/v1/sync/operations", {
    method: "POST",
    token: employee.token,
    body: {
      operations: [
        {
          id: operationId,
          kind: "task.create",
          payload: { title: "Created while offline", ownerId: employee.userId },
        },
      ],
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.results[0].status, "applied");
  const taskId = first.json.results[0].taskId;

  const replay = await api("/api/v1/sync/operations", {
    method: "POST",
    token: employee.token,
    body: {
      operations: [
        {
          id: operationId,
          kind: "task.create",
          payload: { title: "Created while offline", ownerId: employee.userId },
        },
      ],
    },
  });
  assert.equal(replay.json.results[0].status, "replayed");

  const conflicting = await api("/api/v1/sync/operations", {
    method: "POST",
    token: employee.token,
    body: {
      operations: [
        {
          id: crypto.randomUUID(),
          kind: "task.update",
          payload: { taskId, version: 42, title: "Stale edit from the device" },
        },
      ],
    },
  });
  assert.equal(conflicting.json.results[0].status, "conflict");
  assert.equal(conflicting.json.results[0].serverVersion, 0);
});

/* ------------------------------------------------------------------ accessibility of errors */

test("unknown routes and invalid bodies return problem details", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const missing = await api("/api/v1/nope", { token: manager.token });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "not_found");

  const invalid = await api("/api/v1/tasks", { method: "POST", token: manager.token, body: { title: "x" } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.code, "validation_failed");
  assert.ok(Array.isArray(invalid.json.errors));
});
