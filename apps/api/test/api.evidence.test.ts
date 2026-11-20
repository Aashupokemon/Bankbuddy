import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { openTestDatabase, type Database } from "@bankbuddy/db";

import { migrate } from "../../../packages/db/src/migrate.ts";
import { seed } from "../../../packages/db/src/seed.ts";
import { createApp } from "../src/app.ts";

/**
 * The 007-era behaviours: queued checklist writes, photo evidence, dependency gates, bulk edits,
 * comment mentions and the extra analytics. Kept in their own file so the main API suite stays a
 * readable index of the endpoint contract.
 */

let database: Database;
let server: import("node:http").Server;
let baseUrl: string;

interface Account {
  token: string;
  userId: string;
}

const accounts: Record<string, Account> = {};

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
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
  const account: Account = { token: response.json.token, userId: response.json.me.user.id };
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
  await login("ravi@alpha.example");
});

after(async () => {
  server.close();
  await database.close();
});

function syncOperation(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { id: randomUUID(), kind, at: new Date().toISOString(), payload };
}

test("checklist ticks replay through the offline sync endpoint exactly once", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Offline checklist replay", ownerId: manager.userId },
  });
  const taskId = created.json.id as string;

  const add = syncOperation("checklist.add", { taskId, title: "Count the keys" });
  const first = await api("/api/v1/sync/operations", {
    method: "POST",
    token: manager.token,
    body: { operations: [add] },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.results[0].status, "applied");

  const replay = await api("/api/v1/sync/operations", {
    method: "POST",
    token: manager.token,
    body: { operations: [add] },
  });
  assert.equal(replay.json.results[0].status, "replayed", "the same client id is applied at most once");

  const list = await api(`/api/v1/tasks/${taskId}/checklist`, { token: manager.token });
  assert.equal(list.json.total, 1, "the replayed add did not duplicate the step");
  const itemId = list.json.items[0].id as string;

  const update = syncOperation("checklist.update", { taskId, itemId, done: true });
  const toggled = await api("/api/v1/sync/operations", {
    method: "POST",
    token: manager.token,
    body: { operations: [update] },
  });
  assert.equal(toggled.json.results[0].status, "applied");
  assert.equal((await api(`/api/v1/tasks/${taskId}/checklist`, { token: manager.token })).json.done, 1);

  const remove = syncOperation("checklist.remove", { taskId, itemId });
  await api("/api/v1/sync/operations", { method: "POST", token: manager.token, body: { operations: [remove] } });
  assert.equal(
    (await api(`/api/v1/tasks/${taskId}/checklist`, { token: manager.token })).json.total,
    0,
    "a queued removal is applied like an online one",
  );
});

test("photo evidence attaches to a step and comes back as its original bytes", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Vault count with evidence", ownerId: manager.userId },
  });
  const taskId = created.json.id as string;
  const step = await api(`/api/v1/tasks/${taskId}/checklist`, {
    method: "POST",
    token: manager.token,
    body: { title: "Photograph the empty vault" },
  });

  const bytes = Buffer.from("synthetic-photo-bytes");
  const attached = await api(`/api/v1/tasks/${taskId}/attachments`, {
    method: "POST",
    token: manager.token,
    body: { checklistItemId: step.json.id, contentType: "image/jpeg", dataBase64: bytes.toString("base64") },
  });
  assert.equal(attached.status, 201, attached.text);
  assert.equal(attached.json.byteSize, bytes.length);

  const list = await api(`/api/v1/tasks/${taskId}/checklist`, { token: manager.token });
  assert.equal(list.json.items[0].attachmentId, attached.json.id, "the step is marked as evidenced");

  const content = await api(`/api/v1/attachments/${attached.json.id}/content`, { token: manager.token });
  assert.equal(content.status, 200);
  assert.equal(Buffer.from(content.json.dataBase64, "base64").toString(), "synthetic-photo-bytes");

  const replaced = await api(`/api/v1/tasks/${taskId}/attachments`, {
    method: "POST",
    token: manager.token,
    body: {
      checklistItemId: step.json.id,
      contentType: "image/png",
      dataBase64: Buffer.from("second").toString("base64"),
    },
  });
  assert.equal(replaced.json.id, attached.json.id, "a step holds one photo, replaced rather than stacked");
  assert.equal((await api(`/api/v1/tasks/${taskId}/attachments`, { token: manager.token })).json.items.length, 1);

  const tooBig = await api(`/api/v1/tasks/${taskId}/attachments`, {
    method: "POST",
    token: manager.token,
    body: {
      checklistItemId: step.json.id,
      contentType: "image/jpeg",
      dataBase64: Buffer.alloc(720_000, 7).toString("base64"),
    },
  });
  assert.equal(tooBig.status, 413, "an oversized photo is refused with a readable status");
});

test("a task cannot start while something it depends on is still open", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const blocker = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Close the day book first", ownerId: manager.userId },
  });
  const dependent = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "File the reconciliation after that", ownerId: manager.userId },
  });
  const link = await api(`/api/v1/tasks/${dependent.json.id}/dependencies`, {
    method: "POST",
    token: manager.token,
    body: { dependsOnTaskId: blocker.json.id },
  });
  assert.equal(link.status, 201, link.text);

  const refused = await api(`/api/v1/tasks/${dependent.json.id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: dependent.json.version, status: "in_progress" },
  });
  assert.equal(refused.status, 422, refused.text);
  assert.match(refused.json.title, /depends on/i);

  const closed = await api(`/api/v1/tasks/${blocker.json.id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: blocker.json.version, status: "done" },
  });
  assert.equal(closed.status, 200, closed.text);

  const allowed = await api(`/api/v1/tasks/${dependent.json.id}/status`, {
    method: "POST",
    token: manager.token,
    body: { version: dependent.json.version, status: "in_progress" },
  });
  assert.equal(allowed.status, 200, allowed.text);
});

test("bulk edit changes priority, category and status, and reports refusals per task", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const employee = accounts["ravi@alpha.example"]!;
  const one = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Bulk edit one", ownerId: manager.userId },
  });
  const two = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Bulk edit two", ownerId: manager.userId },
  });

  const forbidden = await api("/api/v1/tasks/bulk-update", {
    method: "POST",
    token: employee.token,
    body: { taskIds: [one.json.id], priority: "urgent" },
  });
  assert.equal(forbidden.status, 403, "only leads and managers change work in bulk");

  const updated = await api("/api/v1/tasks/bulk-update", {
    method: "POST",
    token: manager.token,
    body: { taskIds: [one.json.id, two.json.id], priority: "high", status: "in_progress" },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.updated, 2);
  assert.equal(updated.json.errors.length, 0);

  const fresh = await api(`/api/v1/tasks/${one.json.id}`, { token: manager.token });
  assert.equal(fresh.json.priority, "high");
  assert.equal(fresh.json.status, "in_progress");

  const mixed = await api("/api/v1/tasks/bulk-update", {
    method: "POST",
    token: manager.token,
    body: { taskIds: [two.json.id, randomUUID()], priority: "low" },
  });
  assert.equal(mixed.json.updated, 1);
  assert.equal(mixed.json.errors.length, 1, "an unknown id is reported, not silently ignored");
});

test("an @mention in a comment notifies the person named", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const ravi = accounts["ravi@alpha.example"]!;
  const created = await api("/api/v1/tasks", {
    method: "POST",
    token: manager.token,
    body: { title: "Mention test task", ownerId: manager.userId },
  });
  const taskId = created.json.id as string;

  const comment = await api(`/api/v1/tasks/${taskId}/comments`, {
    method: "POST",
    token: manager.token,
    body: { body: "@Ravi Kumar please confirm the vault count this evening." },
  });
  assert.equal(comment.status, 201, comment.text);

  const inbox = await api("/api/v1/notifications", { token: ravi.token });
  const mention = inbox.json.items.find((item: { kind: string }) => item.kind === "mentioned");
  assert.ok(mention, "the mentioned member receives a notification row");
  assert.equal(mention.taskId, taskId);

  await api(`/api/v1/tasks/${taskId}/comments`, {
    method: "POST",
    token: manager.token,
    body: { body: "No mention in this one." },
  });
  const again = await api("/api/v1/notifications", { token: ravi.token });
  assert.equal(
    again.json.items.filter((item: { kind: string }) => item.kind === "mentioned").length,
    1,
    "a comment without a mention notifies nobody",
  );
});

test("analytics reports checklist completion and handover latency", async () => {
  const manager = accounts["priya@alpha.example"]!;
  const summary = await api("/api/v1/analytics/summary?windowDays=30", { token: manager.token });
  assert.equal(summary.status, 200, summary.text);
  assert.ok("checklistCompletionRate" in summary.json);
  assert.ok("medianHandoverHours" in summary.json);
  assert.ok(
    summary.json.checklistCompletionRate === null ||
      (summary.json.checklistCompletionRate >= 0 && summary.json.checklistCompletionRate <= 1),
    "the rate is a proportion or null, never a NaN",
  );
});
