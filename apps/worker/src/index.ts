/**
 * Reminder worker.
 *
 * Two passes per tick:
 *   1. generate — materialises one reminder row per (task, occurrence) with a unique dedupe key, so a
 *      double run cannot duplicate a nudge;
 *   2. deliver — turns due reminders into notifications, honouring the branch's quiet hours, skipping
 *      holidays, recording attempts and leaving failures retryable.
 */
import { addDays, resolveWallTime, wallTimeOf } from "@bankbuddy/date";
import { openDatabase, type Database } from "@bankbuddy/db";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 30_000);

function minutesOfDay(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function inQuietHours(now: Date, timeZone: string, start: string | null, end: string | null): boolean {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === null || to === null) return false;
  const wall = wallTimeOf(now, timeZone);
  const minutes = wall.hour * 60 + wall.minute;
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function nextQuietEnd(now: Date, timeZone: string, end: string | null): Date {
  const to = minutesOfDay(end);
  if (to === null) return new Date(now.getTime() + 15 * 60_000);
  const hour = Math.floor(to / 60);
  const minute = to % 60;

  const wall = wallTimeOf(now, timeZone);
  const sameDay = resolveWallTime({ ...wall, hour, minute, second: 0 }, timeZone).instant;
  if (sameDay && sameDay.getTime() > now.getTime()) return sameDay;

  const tomorrowWall = wallTimeOf(addDays(now, 1, timeZone), timeZone);
  const tomorrow = resolveWallTime({ ...tomorrowWall, hour, minute, second: 0 }, timeZone).instant;
  return tomorrow ?? new Date(now.getTime() + 15 * 60_000);
}

export async function generateReminders(database: Database): Promise<number> {
  const dueSoon = await database.query(
    `insert into reminders (branch_id, task_id, kind, dedupe_key, scheduled_for, task_version_at_schedule)
     select t.branch_id, t.id, 'due_soon',
            'due:' || t.id::text || ':' || to_char(t.due_at at time zone b.timezone, 'YYYY-MM-DD HH24:MI'),
            t.due_at - (bs.reminder_lead_minutes || ' minutes')::interval,
            t.version
       from tasks t
       join branches b on b.id = t.branch_id
       join branch_settings bs on bs.branch_id = t.branch_id
      where t.deleted_at is null
        and t.status in ('open', 'in_progress', 'blocked')
        and t.due_at is not null
        and t.due_at > now()
     on conflict (dedupe_key) do nothing`,
  );

  const overdue = await database.query(
    `insert into reminders (branch_id, task_id, kind, dedupe_key, scheduled_for, task_version_at_schedule)
     select t.branch_id, t.id, 'overdue_daily',
            'overdue:' || t.id::text || ':' || ((now() at time zone b.timezone)::date)::text,
            now(),
            t.version
       from tasks t
       join branches b on b.id = t.branch_id
      where t.deleted_at is null
        and t.status in ('open', 'in_progress', 'blocked')
        and t.due_at is not null
        and t.due_at < now()
        and not exists (
          select 1 from holidays h
           where h.branch_id = t.branch_id
             and h.day = (now() at time zone b.timezone)::date
        )
     on conflict (dedupe_key) do nothing`,
  );

  return dueSoon.rowCount + overdue.rowCount;
}

export async function deliverReminders(database: Database): Promise<number> {
  const pending = await database.query<{
    id: string;
    branch_id: string;
    task_id: string;
    kind: string;
    dedupe_key: string;
    scheduled_for: Date | string;
    attempts: number;
    title: string;
    owner_id: string | null;
    timezone: string;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
  }>(
    `select r.id, r.branch_id, r.task_id, r.kind, r.dedupe_key, r.scheduled_for, r.attempts,
            t.title, t.owner_id, b.timezone, bs.quiet_hours_start, bs.quiet_hours_end
       from reminders r
       join tasks t on t.id = r.task_id
       join branches b on b.id = r.branch_id
       join branch_settings bs on bs.branch_id = r.branch_id
      where r.sent_at is null
        and r.scheduled_for <= now()
        and r.attempts < 3
        and t.deleted_at is null
        and t.status in ('open', 'in_progress', 'blocked')
      order by r.scheduled_for asc
      limit 50`,
  );

  let delivered = 0;
  for (const reminder of pending.rows) {
    const now = new Date();
    try {
      if (inQuietHours(now, reminder.timezone, reminder.quiet_hours_start, reminder.quiet_hours_end)) {
        await database.query("update reminders set scheduled_for = $2 where id = $1", [
          reminder.id,
          nextQuietEnd(now, reminder.timezone, reminder.quiet_hours_end).toISOString(),
        ]);
        continue;
      }

      const recipients = reminder.owner_id
        ? [reminder.owner_id]
        : (
            await database.query<{ user_id: string }>(
              `select user_id from memberships
                where branch_id = $1 and role in ('lead', 'manager', 'workspace_admin')`,
              [reminder.branch_id],
            )
          ).rows.map((r) => r.user_id);

      for (const userId of recipients) {
        await database.query(
          `insert into notifications (branch_id, user_id, task_id, kind, title, body, dedupe_key)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (dedupe_key) do nothing`,
          [
            reminder.branch_id,
            userId,
            reminder.task_id,
            reminder.kind,
            reminder.kind === "due_soon" ? "Task due soon" : "Task overdue",
            reminder.title,
            `${reminder.dedupe_key}:${userId}`,
          ],
        );
      }

      await database.query("update reminders set sent_at = now(), last_error = null where id = $1", [reminder.id]);
      delivered += 1;
    } catch (error) {
      await database.query("update reminders set attempts = attempts + 1, last_error = $2 where id = $1", [
        reminder.id,
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  return delivered;
}

export async function runOnce(database: Database): Promise<{ generated: number; delivered: number }> {
  const generated = await generateReminders(database);
  const delivered = await deliverReminders(database);
  return { generated, delivered };
}

async function main(): Promise<void> {
  const database = await openDatabase();
  console.log(`[worker] reminders running every ${POLL_MS}ms`);

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    try {
      const result = await runOnce(database);
      if (result.generated || result.delivered) {
        console.log(`[worker] generated ${result.generated}, delivered ${result.delivered}`);
      }
    } catch (error) {
      console.error("[worker] tick failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  await database.close();
  process.exit(0);
}

if (process.argv[1]?.includes("worker")) {
  await main();
}
