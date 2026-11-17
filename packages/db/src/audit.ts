import type { Queryable } from "./driver.ts";

export interface AuditInput {
  branchId: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Appends one audit row. The hash chain and the append-only guarantee are enforced by triggers in
 * the database (003_audit.sql), so this helper cannot be bypassed by a caller that forgets them.
 */
export async function writeAudit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `insert into audit_events (branch_id, actor_id, action, entity_type, entity_id, before, after, reason)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      input.branchId,
      input.actorId,
      input.action,
      input.entityType,
      input.entityId,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
    ],
  );
}
