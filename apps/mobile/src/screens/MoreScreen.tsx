import { useCallback, useEffect, useState } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";

import { can, type AnalyticsSummary, type DashboardResponse, type MeResponse, type NotificationDto } from "@bankbuddy/contracts";

import {
  api,
  dismissConflict,
  flushQueue,
  isDemoMode,
  listConflicts,
  retryConflict,
  subscribeQueue,
} from "../api";
import { ensureNotificationPermission, syncReminders } from "../notifications";
import { disableAppLock, enableAppLock, isAppLockEnabled } from "../security";
import { colors, spacing } from "../theme";
import { Badge, Button, Card, Chip, Empty, Heading } from "../ui";

interface Handover {
  id: string;
  fromName: string;
  toName: string;
  status: string;
  scope: string;
  note: string | null;
  tasks: Array<{ id: string; title: string }>;
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  actorName: string | null;
  occurredAt: string;
  reason: string | null;
  hash: string;
}

interface ConflictRow {
  id: string;
  kind: string;
  at: string;
  title: string;
  taskId: string | null;
}

export default function MoreScreen({
  me,
  onSignOut,
  onOpenTask,
  onOpenTemplates,
  onOpenShift,
}: {
  me: MeResponse;
  onSignOut: () => void;
  onOpenTask: (id: string) => void;
  onOpenTemplates: () => void;
  onOpenShift: () => void;
}): React.JSX.Element {
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditCheck, setAuditCheck] = useState<{ checked: number; valid: boolean } | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [teamLoad, setTeamLoad] = useState<DashboardResponse["teamLoad"]>([]);
  const [windowDays, setWindowDays] = useState(30);
  const [queue, setQueue] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockOn, setLockOn] = useState(false);
  const [scheduled, setScheduled] = useState<number | null>(null);

  const canReadAudit = can(me.role, "audit.read");
  const canReadAnalytics = can(me.role, "analytics.read");

  useEffect(() => {
    void isAppLockEnabled().then(setLockOn);
  }, []);

  const load = useCallback(async () => {
    try {
      const [notificationResponse, handoverResponse] = await Promise.all([api.notifications(), api.handovers()]);
      setNotifications(notificationResponse.items);
      setHandovers(handoverResponse.items);
      setConflicts(
        (await listConflicts().catch(() => [])).map((item) => ({
          id: item.operation.id,
          kind: item.operation.kind.replace(".", " "),
          at: item.at,
          title:
            typeof item.operation.payload.title === "string"
              ? item.operation.payload.title
              : "A change captured offline",
          taskId: typeof item.operation.payload.taskId === "string" ? item.operation.payload.taskId : null,
        })),
      );
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not load notifications");
    }

    if (canReadAudit) {
      try {
        const auditResponse = await api.audit({ limit: "20" });
        setAudit(auditResponse.items);
      } catch {
        setAudit([]);
      }
    }

    try {
      const dashboard = await api.dashboard();
      setTeamLoad(dashboard.teamLoad);
    } catch {
      setTeamLoad([]);
    }
  }, [canReadAudit]);

  useEffect(() => {
    void load();
  }, [load]);

  // Changing the window refetches only the summary, not the notifications and handovers above it.
  useEffect(() => {
    if (!canReadAnalytics) return;
    void api
      .analytics(windowDays)
      .then(setAnalytics)
      .catch(() => setAnalytics(null));
  }, [canReadAnalytics, windowDays]);

  useEffect(() => subscribeQueue(setQueue), []);

  const verify = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.auditVerify();
      setAuditCheck({ checked: result.checked, valid: result.valid });
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not verify the audit trail");
    } finally {
      setBusy(false);
    }
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await flushQueue();
      setQueue(result.remaining);
      setMessage(
        result.applied === 0 && result.conflicts === 0 && result.rejected === 0
          ? "Nothing waiting to sync."
          : `Synced ${result.applied} change(s), ${result.conflicts} conflict(s), ${result.rejected} rejected.`,
      );
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Still offline");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async (): Promise<void> => {
    setBusy(true);
    try {
      const csv = await api.auditCsv();
      // The share sheet is how a branch manager gets the trail off the phone without a laptop.
      await Share.share({ title: "BankBuddy audit trail", message: csv });
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not export the audit trail");
    } finally {
      setBusy(false);
    }
  };

  const respond = async (id: string, decision: "accept" | "decline"): Promise<void> => {
    setBusy(true);
    try {
      await api.respondHandover(id, decision);
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not respond");
    } finally {
      setBusy(false);
    }
  };

  const ack = async (id: string): Promise<void> => {
    try {
      await api.acknowledge(id);
      setNotifications(await api.notifications().then((response) => response.items));
    } catch {
      // ignore
    }
  };

  /**
   * Re-applies a change that lost a version race. The task is re-read first so the write carries the
   * version the server actually has; without that, retrying would only conflict again.
   */
  const keepMine = async (conflict: ConflictRow): Promise<void> => {
    setBusy(true);
    try {
      let overrides: Record<string, unknown> = {};
      if (conflict.taskId && conflict.kind.includes("update")) {
        const fresh = await api.task(conflict.taskId);
        overrides = { version: fresh.version };
      }
      const result = await retryConflict(conflict.id, overrides);
      setMessage(
        result
          ? `Re-applied on top of the latest version (${result.applied} applied, ${result.conflicts} still conflicting).`
          : "That change is no longer waiting.",
      );
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not re-apply the change");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Android notifications are opt-in: the permission is only asked for when someone presses this, and
   * the branch's quiet hours are applied when the reminders are scheduled.
   */
  const enableReminders = async (): Promise<void> => {
    setBusy(true);
    try {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        setMessage("Notifications are blocked for BankBuddy. Allow them in Android settings first.");
        return;
      }
      const list = await api.tasks({ limit: 50 });
      const count = await syncReminders(list.items, me.settings);
      setScheduled(count);
      setMessage(
        count === 0
          ? "No upcoming due dates to remind you about."
          : `${count} reminder(s) scheduled, quiet hours ${me.settings.quietHoursStart ?? "—"}–${me.settings.quietHoursEnd ?? "—"}.`,
      );
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not schedule reminders");
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async (): Promise<void> => {
    if (lockOn) {
      await disableAppLock();
      setLockOn(false);
      return;
    }
    const result = await enableAppLock();
    setMessage(result.ok ? null : (result.message ?? "Could not turn the lock on."));
    setLockOn(result.ok);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={{ gap: 2 }}>
        <Heading>More</Heading>
        <Text style={styles.subtitle}>
          {me.branch.name} · {me.role.replace("_", " ")}
          {isDemoMode() ? " · demo data on this device" : ""}
        </Text>
      </View>

      {message ? (
        <Card style={{ borderColor: colors.amber }}>
          <Text style={{ color: colors.amber, fontSize: 13 }}>{message}</Text>
        </Card>
      ) : null}

      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Offline queue</Text>
          <Badge label={`${queue} pending`} color={queue > 0 ? colors.amber : colors.muted} />
        </View>
        <Text style={styles.hint}>Changes captured without a connection are replayed exactly once.</Text>
        <Button label={busy ? "Working…" : "Sync now"} variant="ghost" onPress={() => void sync()} loading={busy} />
      </Card>

      {conflicts.length > 0 ? (
        <Card style={{ borderColor: colors.danger }}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Changes that did not merge</Text>
            <Badge label={`${conflicts.length}`} color={colors.danger} />
          </View>
          <Text style={styles.hint}>
            Someone else changed these tasks while this phone was offline. Nothing was overwritten — you choose
            which version wins.
          </Text>
          {conflicts.map((conflict) => (
            <View key={conflict.id} style={{ gap: spacing.sm }}>
              <Text style={styles.body}>{conflict.title}</Text>
              <Text style={styles.hint}>
                {conflict.kind} · {new Date(conflict.at).toLocaleString()}
              </Text>
              <View style={styles.actionRow}>
                <Button label="Keep mine" onPress={() => void keepMine(conflict)} loading={busy} />
                <Button
                  label="Use theirs"
                  variant="ghost"
                  onPress={() => {
                    void dismissConflict(conflict.id).then(() => load());
                  }}
                />
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Notifications</Text>
        {notifications.length === 0 ? <Empty>Nothing new.</Empty> : null}
        {notifications.slice(0, 10).map((item) => (
          <View key={item.id} style={styles.notificationRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.body, item.readAt ? { color: colors.muted } : null]}>{item.title}</Text>
              <Text style={styles.hint}>{item.body}</Text>
            </View>
            {item.readAt ? null : <Button label="Dismiss" variant="ghost" onPress={() => void ack(item.id)} />}
          </View>
        ))}
        {notifications.some((item) => !item.readAt) ? (
          <Button
            label="Mark all read"
            variant="ghost"
            onPress={() => void api.acknowledgeAll().then(() => load())}
          />
        ) : null}
      </Card>

      {teamLoad.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Team load</Text>
          <Text style={styles.hint}>
            Open work per person, for spotting an overloaded desk — not a scoreboard.
          </Text>
          {teamLoad.slice(0, 8).map((row) => (
            <Bar
              key={row.ownerId ?? "unassigned"}
              label={row.ownerName ?? "Unassigned"}
              value={row.open}
              peak={Math.max(...teamLoad.map((entry) => entry.open), 1)}
              trailing={`${row.open} open${row.overdue > 0 ? ` · ${row.overdue} late` : ""}`}
            />
          ))}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Shift change</Text>
        <Text style={styles.hint}>
          Recurring chores for the branch, and moving a whole shift of work to someone else.
        </Text>
        <Button label="Branch chores" variant="ghost" onPress={onOpenTemplates} />
        <Button label="Handover and bulk reassign" variant="ghost" onPress={onOpenShift} />
        {handovers.length === 0 ? <Empty>No handovers yet.</Empty> : null}
        {handovers.slice(0, 5).map((handover) => (
          <View key={handover.id} style={{ gap: spacing.sm }}>
            <Text style={styles.body}>
              {handover.fromName} → {handover.toName} · {handover.status}
              {handover.scope === "shift" ? " · whole shift" : ""}
            </Text>
            <Text style={styles.hint}>{handover.tasks.map((task) => task.title).join(", ")}</Text>
            {handover.status === "proposed" && handover.toName === me.user.name ? (
              <View style={styles.actionRow}>
                <Button label="Accept" onPress={() => void respond(handover.id, "accept")} loading={busy} />
                <Button label="Decline" variant="danger" onPress={() => void respond(handover.id, "decline")} loading={busy} />
              </View>
            ) : null}
            {handover.tasks[0] ? (
              <Button label="Open the task" variant="ghost" onPress={() => onOpenTask(handover.tasks[0]!.id)} />
            ) : null}
          </View>
        ))}
      </Card>

      {analytics ? (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Last {analytics.windowDays} days</Text>
            <View style={styles.actionRow}>
              {[7, 30, 90].map((days) => (
                <Chip
                  key={days}
                  label={`${days}d`}
                  active={windowDays === days}
                  onPress={() => setWindowDays(days)}
                />
              ))}
            </View>
          </View>
          <View style={styles.statRow}>
            <Stat label="Created" value={String(analytics.created)} />
            <Stat label="Completed" value={String(analytics.completed)} />
            <Stat label="Reopened" value={String(analytics.reopened)} />
            <Stat label="Blocked now" value={String(analytics.blockedNow)} />
          </View>
          <Text style={styles.hint}>
            Median time to complete:{" "}
            {analytics.medianCompletionHours === null ? "—" : `${analytics.medianCompletionHours.toFixed(1)} h`} · On
            time: {analytics.onTimeRate === null ? "—" : `${Math.round(analytics.onTimeRate * 100)}%`}
          </Text>
          <Text style={styles.hint}>
            Checklist steps done on finished work:{" "}
            {analytics.checklistCompletionRate === null
              ? "—"
              : `${Math.round(analytics.checklistCompletionRate * 100)}%`}{" "}
            · Handover answered in:{" "}
            {analytics.medianHandoverHours === null ? "—" : `${analytics.medianHandoverHours.toFixed(1)} h`}
          </Text>
          {analytics.byCategory.length > 0 ? (
            <View style={{ gap: spacing.xs }}>
              <Text style={styles.hint}>Work created, by category</Text>
              {analytics.byCategory.slice(0, 6).map((row) => (
                <Bar
                  key={row.categoryKey ?? "uncategorised"}
                  label={row.categoryKey ? row.categoryKey.replace(/_/g, " ") : "uncategorised"}
                  value={row.count}
                  peak={Math.max(...analytics.byCategory.map((entry) => entry.count), 1)}
                  trailing={String(row.count)}
                />
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}

      {canReadAudit ? (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Audit trail</Text>
            {auditCheck ? (
              <Badge
                label={
                  auditCheck.valid
                    ? `${auditCheck.checked} chain intact`
                    : "verified: FAILED"
                }
                color={auditCheck.valid ? colors.mint : colors.danger}
              />
            ) : null}
          </View>
          <Button label="Verify chain again" variant="ghost" onPress={() => void verify()} loading={busy} />
          <Button label="Export CSV" variant="ghost" onPress={() => void exportCsv()} loading={busy} />
          {auditCheck && !auditCheck.valid ? (
            <Text style={{ color: colors.danger, fontSize: 13 }}>
              Chain verification failed — investigate before trusting this log.
            </Text>
          ) : null}
          {audit.length === 0 ? <Empty>No audit entries visible.</Empty> : null}
          {audit.slice(0, 8).map((entry) => (
            <View key={entry.id} style={{ gap: 1 }}>
              <Text style={styles.body}>{entry.action}</Text>
              <Text style={styles.hint}>
                {entry.actorName ?? "system"} · {new Date(entry.occurredAt).toLocaleString()} ·{" "}
                {entry.hash.slice(0, 10)}…
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Phone reminders</Text>
          {scheduled === null ? null : <Badge label={`${scheduled} scheduled`} color={colors.mint} />}
        </View>
        <Text style={styles.hint}>
          Android alerts {me.settings.reminderLeadMinutes} minutes before a due time, moved outside quiet hours.
        </Text>
        <Button label="Turn on task reminders" variant="ghost" onPress={() => void enableReminders()} loading={busy} />
      </Card>

      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>App lock</Text>
          <Badge label={lockOn ? "on" : "off"} color={lockOn ? colors.mint : colors.muted} />
        </View>
        <Text style={styles.hint}>
          Ask for this phone's fingerprint or face unlock when the app opens. The session is still held by
          the device, not by the lock.
        </Text>
        <Button
          label={lockOn ? "Turn app lock off" : "Turn app lock on"}
          variant={lockOn ? "danger" : "ghost"}
          onPress={() => void toggleLock()}
        />
      </Card>

      <Button label="Sign out" variant="danger" onPress={onSignOut} />
      <Text style={styles.footnote}>BankBuddy pilot · synthetic data only · not bank-approved</Text>
    </ScrollView>
  );
}

/** One bar per row, used by both the team load and the category breakdown. */
function Bar({
  label,
  value,
  peak,
  trailing,
}: {
  label: string;
  value: number;
  peak: number;
  trailing: string;
}): React.JSX.Element {
  return (
    <View style={styles.loadRow}>
      <Text style={[styles.hint, styles.loadLabel]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.loadTrack}>
        <View style={[styles.loadFill, { width: `${Math.round((value / peak) * 100)}%` }]} />
      </View>
      <Text style={styles.hint}>{trailing}</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.hint}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  subtitle: { color: colors.muted, fontSize: 13, textTransform: "capitalize" },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.text, fontSize: 14 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  notificationRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  actionRow: { flexDirection: "row", gap: spacing.sm },
  statRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.lg },
  stat: { gap: 2, minWidth: 70 },
  statValue: { color: colors.mint, fontSize: 20, fontWeight: "800" },
  loadRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  loadLabel: { width: 110, textTransform: "capitalize" },
  loadTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  loadFill: { height: 6, borderRadius: 3, backgroundColor: colors.blue },
  footnote: { color: colors.muted, fontSize: 11, textAlign: "center", paddingVertical: spacing.md },
});
