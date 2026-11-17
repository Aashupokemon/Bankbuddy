import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { can, type MeResponse, type NotificationDto } from "@bankbuddy/contracts";

import { api, flushQueue, queuedCount } from "../api";
import { colors, spacing } from "../theme";
import { Badge, Button, Card, Empty, Heading } from "../ui";

interface Handover {
  id: string;
  fromName: string;
  toName: string;
  status: string;
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

export default function MoreScreen({
  me,
  onSignOut,
  onOpenTask,
}: {
  me: MeResponse;
  onSignOut: () => void;
  onOpenTask: (id: string) => void;
}): React.JSX.Element {
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditCheck, setAuditCheck] = useState<{ checked: number; valid: boolean } | null>(null);
  const [analytics, setAnalytics] = useState<{
    created: number;
    completed: number;
    reopened: number;
    blockedNow: number;
    medianCompletionHours: number | null;
    onTimeRate: number | null;
  } | null>(null);
  const [queue, setQueue] = useState(queuedCount());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canReadAudit = can(me.role, "audit.read");
  const canReadAnalytics = can(me.role, "analytics.read");

  const load = useCallback(async () => {
    try {
      const [notificationResponse, handoverResponse] = await Promise.all([api.notifications(), api.handovers()]);
      setNotifications(notificationResponse.items);
      setHandovers(handoverResponse.items);
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
    if (canReadAnalytics) {
      try {
        setAnalytics(await api.analytics());
      } catch {
        setAnalytics(null);
      }
    }
  }, [canReadAnalytics, canReadAudit]);

  useEffect(() => {
    void load();
  }, [load]);

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
        result.applied === 0 && result.conflicts === 0
          ? "Nothing waiting to sync."
          : `Synced ${result.applied} change(s), ${result.conflicts} conflict(s).`,
      );
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Still offline");
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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={{ gap: 2 }}>
        <Heading>More</Heading>
        <Text style={styles.subtitle}>
          {me.branch.name} · {me.role.replace("_", " ")}
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

      <Card>
        <Text style={styles.sectionTitle}>Handovers</Text>
        {handovers.length === 0 ? <Empty>No handovers yet.</Empty> : null}
        {handovers.slice(0, 5).map((handover) => (
          <View key={handover.id} style={{ gap: spacing.sm }}>
            <Text style={styles.body}>
              {handover.fromName} → {handover.toName} · {handover.status}
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
          <Text style={styles.sectionTitle}>Last {analytics.created >= 0 ? "30" : "30"} days</Text>
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
        </Card>
      ) : null}

      {canReadAudit ? (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Audit trail</Text>
            <Button label="Verify chain" variant="ghost" onPress={() => void verify()} loading={busy} />
          </View>
          {auditCheck ? (
            <Text style={{ color: auditCheck.valid ? colors.mint : colors.danger, fontSize: 13 }}>
              {auditCheck.valid
                ? `${auditCheck.checked} entries verified, chain intact.`
                : "Chain verification failed — investigate before trusting this log."}
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

      <Button label="Sign out" variant="danger" onPress={onSignOut} />
      <Text style={styles.footnote}>
        BankBuddy pilot · synthetic data only · not bank-approved
      </Text>
    </ScrollView>
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
  footnote: { color: colors.muted, fontSize: 11, textAlign: "center", paddingVertical: spacing.md },
});
