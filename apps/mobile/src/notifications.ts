/**
 * Real Android reminders, not just rows in the notifications list.
 *
 * Everything the server knows about a due date is already on the device after the board loads, so
 * reminders are scheduled locally: that works with no push service, no FCM key and no connection at
 * the moment the reminder fires. The branch's quiet hours are honoured by moving a reminder that
 * would land inside them to the end of the window, and every reminder is cancelled and rebuilt on
 * each resync so a task that moved does not leave a stale alert behind.
 */

import * as Notifications from "expo-notifications";

import type { MeResponse, TaskDto } from "@bankbuddy/contracts";

const CHANNEL_ID = "reminders";
const DEDUPE_PREFIX = "task-reminder:";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Minutes since midnight for "HH:MM", or null when the value is missing or malformed. */
function minuteOfDay(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Quiet hours may wrap midnight, which is the normal case for a branch (19:00 → 08:00). */
export function inQuietHours(date: Date, start: string | null, end: string | null): boolean {
  const from = minuteOfDay(start);
  const to = minuteOfDay(end);
  if (from === null || to === null || from === to) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The first instant at or after `date` that is outside the quiet window. */
export function quietEnd(date: Date, start: string | null, end: string | null): Date {
  if (!inQuietHours(date, start, end)) return date;
  const to = minuteOfDay(end);
  if (to === null) return date;
  const candidate = new Date(date);
  candidate.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (candidate.getTime() <= date.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return true;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

async function prepareChannel(): Promise<void> {
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Task reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
    });
  } catch {
    // Older Android versions have no channels; scheduling still works.
  }
}

/**
 * Replaces every scheduled reminder with one per open task that has a due date.
 * Returns how many were scheduled, so the UI can say whether reminders are actually on.
 */
export async function syncReminders(
  tasks: TaskDto[],
  settings: Pick<MeResponse["settings"], "quietHoursStart" | "quietHoursEnd" | "reminderLeadMinutes">,
  now: Date = new Date(),
): Promise<number> {
  try {
    await prepareChannel();
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return 0;

    await Notifications.cancelAllScheduledNotificationsAsync();

    let scheduled = 0;
    for (const task of tasks) {
      if (!task.dueAt) continue;
      if (task.status === "done" || task.status === "cancelled" || task.status === "archived") continue;

      const due = new Date(task.dueAt);
      if (Number.isNaN(due.getTime())) continue;

      const lead = Math.max(settings.reminderLeadMinutes, 0) * 60_000;
      const at = quietEnd(new Date(due.getTime() - lead), settings.quietHoursStart, settings.quietHoursEnd);
      // A reminder for something already past is noise; the overdue count on the board covers it.
      if (at.getTime() <= now.getTime()) continue;

      await Notifications.scheduleNotificationAsync({
        identifier: `${DEDUPE_PREFIX}${task.id}`,
        content: {
          title: task.isOverdue ? "Task is overdue" : "Task due soon",
          body: task.title,
          data: { taskId: task.id },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: at,
          channelId: CHANNEL_ID,
        },
      });
      scheduled += 1;
    }
    return scheduled;
  } catch {
    return 0;
  }
}

export async function cancelReminders(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // Nothing scheduled, or notifications are unavailable in this build.
  }
}
