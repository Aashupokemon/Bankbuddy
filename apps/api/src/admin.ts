import type {
  AnalyticsSummary,
  AuditEventDto,
  CategoryInput,
  NotificationDto,
  UpdateSettingsInput,
} from "@bankbuddy/contracts";
import type { Queryable } from "@bankbuddy/db";
import { writeAudit } from "@bankbuddy/db";

import { ApiError } from "./http.ts";
import { assertPermission, type Identity } from "./auth.ts";

/* ------------------------------------------------------------------------------------------ *
 * Audit
 * ---------------------------------------------------------------------------------------- */

export interface AuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  limit?: number;
  cursor?: string | null;
}

export async function listAuditEvents(
  db: Queryable,
  identity: Identity,
  query: AuditQuery,
): Promise<{ items: AuditEventDto[]; total: number; nextCursor: string | null }> {
  assertPermission(identity, "audit.read");
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) || 0 : 0;

  const where = ["a.branch_id = $1"];
  const params: unknown[] = [identity.branchId];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace("$?", `$${params.length}`));
  };
  if (query.action) add("a.action = $?", query.action);
  if (query.entityType) add("a.entity_type = $?", query.entityType);
  if (query.entityId) add("a.entity_id = $?", query.entityId);
  if (query.actorId) add("a.actor_id = $?", query.actorId);

  const clause = where.join(" and ");
  const total = await db.query<{ count: string }>(`select count(*)::text as count from audit_events a where ${clause}`, params);
  const rows = await db.query<{
    id: string;
    occurred_at: Date | string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    reason: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    prev_hash: string | null;
    hash: string;
  }>(
    `select a.id, a.occurred_at, a.actor_id, u.name as actor_name, a.action, a.entity_type, a.entity_id,
            a.reason, a.before, a.after, a.prev_hash, a.hash
       from audit_events a
       left join users u on u.id = a.actor_id
      where ${clause}
      order by a.seq desc
      limit ${limit} offset ${offset}`,
    params,
  );

  // Reading audit is itself an audited action.
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "audit.read",
    entityType: "audit_events",
    entityId: null,
    after: { filter: { action: query.action ?? null, entityType: query.entityType ?? null }, limit },
  });

  const totalCount = Number(total.rows[0]?.count ?? 0);
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id ?? "",
      reason: row.reason,
      before: row.before,
      after: row.after,
      prevHash: row.prev_hash,
      hash: row.hash,
    })),
    total: totalCount,
    nextCursor:
      offset + rows.rows.length < totalCount ? Buffer.from(String(offset + rows.rows.length)).toString("base64url") : null,
  };
}

const CHAIN_PAYLOAD = `
  coalesce(prev_hash, '') || '|' ||
  coalesce(branch_id::text, '') || '|' ||
  coalesce(actor_id::text, '') || '|' ||
  action || '|' ||
  entity_type || '|' ||
  coalesce(entity_id::text, '') || '|' ||
  coalesce(before::text, '') || '|' ||
  coalesce(after::text, '') || '|' ||
  coalesce(reason, '') || '|' ||
  occurred_at::text
`;

/** Recomputes the hash chain inside the database, using the same expression the trigger used. */
export async function verifyAuditChain(
  db: Queryable,
  branchId: string,
): Promise<{ checked: number; brokenLinks: number; tampered: number; valid: boolean }> {
  const result = await db.query<{ checked: string; broken_links: string; tampered: string }>(
    `with ordered as (
       select *, lag(hash) over (partition by branch_id order by seq) as expected_prev
         from audit_events
        where branch_id = $1
     )
     select count(*)::text as checked,
            count(*) filter (where prev_hash is distinct from expected_prev)::text as broken_links,
            count(*) filter (where hash <> encode(sha256(convert_to(${CHAIN_PAYLOAD}, 'UTF8')), 'hex'))::text as tampered
       from ordered`,
    [branchId],
  );
  const row = result.rows[0];
  const brokenLinks = Number(row?.broken_links ?? 0);
  const tampered = Number(row?.tampered ?? 0);
  return {
    checked: Number(row?.checked ?? 0),
    brokenLinks,
    tampered,
    valid: brokenLinks === 0 && tampered === 0,
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Analytics
 * ---------------------------------------------------------------------------------------- */

export async function analyticsSummary(db: Queryable, identity: Identity, windowDays = 30): Promise<AnalyticsSummary> {
  const days = Math.min(Math.max(windowDays, 1), 365);

  const totals = await db.query<{
    created: string;
    completed: string;
    cancelled: string;
    median_hours: string | null;
    on_time: string | null;
    completed_with_due: string | null;
    blocked_now: string;
  }>(
    `select
       count(*) filter (where created_at >= now() - ($2 || ' days')::interval)::text as created,
       count(*) filter (where completed_at >= now() - ($2 || ' days')::interval)::text as completed,
       count(*) filter (where status = 'cancelled' and updated_at >= now() - ($2 || ' days')::interval)::text as cancelled,
       percentile_cont(0.5) within group (order by extract(epoch from completed_at - created_at) / 3600)
         filter (where completed_at is not null and completed_at >= now() - ($2 || ' days')::interval)::text as median_hours,
       count(*) filter (where completed_at is not null and due_at is not null and completed_at <= due_at)::text as on_time,
       count(*) filter (where completed_at is not null and due_at is not null)::text as completed_with_due,
       count(*) filter (where status = 'blocked')::text as blocked_now
     from tasks
     where branch_id = $1 and deleted_at is null`,
    [identity.branchId, String(days)],
  );
  const row = totals.rows[0];

  const reopened = await db.query<{ count: string }>(
    `select count(*)::text as count
       from task_events
      where branch_id = $1
        and kind = 'status_changed'
        and after->>'status' = 'open'
        and before->>'status' in ('done','cancelled')
        and created_at >= now() - ($2 || ' days')::interval`,
    [identity.branchId, String(days)],
  );

  const byCategory = await db.query<{ category_key: string | null; count: string }>(
    `select category_key, count(*)::text as count
       from tasks
      where branch_id = $1 and deleted_at is null and created_at >= now() - ($2 || ' days')::interval
      group by category_key
      order by count(*) desc`,
    [identity.branchId, String(days)],
  );

  const onTime = Number(row?.on_time ?? 0);
  const withDue = Number(row?.completed_with_due ?? 0);

  return {
    windowDays: days,
    created: Number(row?.created ?? 0),
    completed: Number(row?.completed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    reopened: Number(reopened.rows[0]?.count ?? 0),
    medianCompletionHours: row?.median_hours ? Number(row.median_hours) : null,
    onTimeRate: withDue > 0 ? onTime / withDue : null,
    blockedNow: Number(row?.blocked_now ?? 0),
    byCategory: byCategory.rows.map((r) => ({ categoryKey: r.category_key, count: Number(r.count) })),
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Settings, categories, members
 * ---------------------------------------------------------------------------------------- */

export async function getSettings(db: Queryable, identity: Identity) {
  const rows = await db.query<{
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    reminder_lead_minutes: number;
    weekly_overdue_day: number;
  }>("select quiet_hours_start, quiet_hours_end, reminder_lead_minutes, weekly_overdue_day from branch_settings where branch_id = $1", [
    identity.branchId,
  ]);
  const row = rows.rows[0];
  return {
    timezone: identity.timezone,
    quietHoursStart: row?.quiet_hours_start ?? null,
    quietHoursEnd: row?.quiet_hours_end ?? null,
    reminderLeadMinutes: row?.reminder_lead_minutes ?? 60,
    weeklyOverdueDay: row?.weekly_overdue_day ?? 0,
  };
}

export async function updateSettings(db: Queryable, identity: Identity, input: UpdateSettingsInput) {
  assertPermission(identity, "settings.manage");
  const before = await getSettings(db, identity);

  await db.query(
    `update branch_settings
        set quiet_hours_start = coalesce($2::time, quiet_hours_start),
            quiet_hours_end = coalesce($3::time, quiet_hours_end),
            reminder_lead_minutes = coalesce($4, reminder_lead_minutes),
            weekly_overdue_day = coalesce($5, weekly_overdue_day),
            updated_at = now()
      where branch_id = $1`,
    [
      identity.branchId,
      (input.quietHoursStart ?? null) as string | null,
      (input.quietHoursEnd ?? null) as string | null,
      input.reminderLeadMinutes ?? null,
      input.weeklyOverdueDay ?? null,
    ],
  );

  if (input.timezone) {
    await db.query("update branches set timezone = $2 where id = $1", [identity.branchId, input.timezone]);
  }

  const after = await getSettings(db, identity);
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "settings.update",
    entityType: "branch_settings",
    entityId: identity.branchId,
    before,
    after,
  });
  return after;
}

export async function listCategories(db: Queryable, identity: Identity) {
  const rows = await db.query<{ key: string; label: string }>(
    "select key, label from categories where branch_id = $1 order by label",
    [identity.branchId],
  );
  return rows.rows;
}

export async function createCategory(db: Queryable, identity: Identity, input: CategoryInput) {
  assertPermission(identity, "settings.manage");
  await db.query(
    `insert into categories (branch_id, key, label) values ($1,$2,$3)
     on conflict (branch_id, key) do update set label = excluded.label`,
    [identity.branchId, input.key, input.label],
  );
  await writeAudit(db, {
    branchId: identity.branchId,
    actorId: identity.userId,
    action: "category.upsert",
    entityType: "category",
    entityId: null,
    after: { key: input.key, label: input.label },
  });
  return { key: input.key, label: input.label };
}

export async function listMembers(db: Queryable, identity: Identity) {
  const rows = await db.query<{ id: string; name: string; role: string }>(
    `select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id
      where m.branch_id = $1 order by u.name`,
    [identity.branchId],
  );
  return rows.rows;
}

/* ------------------------------------------------------------------------------------------ *
 * Notifications
 * ---------------------------------------------------------------------------------------- */

export async function listNotifications(db: Queryable, identity: Identity): Promise<NotificationDto[]> {
  const rows = await db.query<{
    id: string;
    kind: string;
    task_id: string | null;
    title: string;
    body: string;
    created_at: Date | string;
    read_at: Date | string | null;
  }>(
    `select id, kind, task_id, title, body, created_at, read_at
       from notifications
      where branch_id = $1 and user_id = $2
      order by created_at desc
      limit 50`,
    [identity.branchId, identity.userId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    taskId: row.task_id,
    title: row.title,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
  }));
}

export async function acknowledgeNotification(db: Queryable, identity: Identity, id: string): Promise<void> {
  const updated = await db.query(
    "update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null",
    [id, identity.userId],
  );
  if (updated.rowCount === 0) {
    const exists = await db.query("select 1 from notifications where id = $1 and user_id = $2", [id, identity.userId]);
    if (exists.rowCount === 0) throw ApiError.notFound("Notification");
  }
}

export async function acknowledgeAll(db: Queryable, identity: Identity): Promise<number> {
  const updated = await db.query(
    "update notifications set read_at = now() where user_id = $1 and read_at is null returning id",
    [identity.userId],
  );
  return updated.rowCount;
}

export async function taskActivity(db: Queryable, identity: Identity, taskId: string) {
  const rows = await db.query<{
    id: string;
    actor_id: string | null;
    actor_name: string | null;
    kind: string;
    summary: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string | null;
    created_at: Date | string;
  }>(
    `select e.id, e.actor_id, u.name as actor_name, e.kind, e.summary, e.before, e.after, e.reason, e.created_at
       from task_events e
       left join users u on u.id = e.actor_id
      where e.branch_id = $1 and e.task_id = $2
      order by e.created_at asc`,
    [identity.branchId, taskId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    taskId,
    actorId: row.actor_id ?? "",
    actorName: row.actor_name ?? "System",
    kind: row.kind,
    summary: row.summary,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
