import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { can, type MeResponse, type TaskTemplateDto } from "@bankbuddy/contracts";

import { api } from "../api";
import { colors, radius, spacing } from "../theme";
import { Badge, Button, Card, Chip, Empty, Field, Heading } from "../ui";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const cadenceLabel = (template: TaskTemplateDto): string =>
  template.cadence === "daily"
    ? `Every day at ${template.dueTime}`
    : `${WEEKDAYS[template.weekday ?? 0]} at ${template.dueTime}`;

/**
 * Recurring branch chores. A template is a definition, so creating one does not put anything on the
 * board until "Create today's chores" runs (or a manager's daily run does).
 */
export default function TemplatesScreen({
  me,
  onBack,
  onChanged,
}: {
  me: MeResponse;
  onBack: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [templates, setTemplates] = useState<TaskTemplateDto[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState(1);
  const [dueTime, setDueTime] = useState("09:15");
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const canManage = can(me.role, "task.assign");

  const load = useCallback(async () => {
    try {
      const [templateResponse, memberResponse] = await Promise.all([api.templates(), api.members()]);
      setTemplates(templateResponse.items);
      setMembers(memberResponse.items.map((member) => ({ id: member.id, name: member.name })));
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not load recurring chores");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runToday = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.runTemplates();
      setMessage(
        result.created === 0
          ? "Today's chores were already created."
          : `Created ${result.created} chore(s) for today.`,
      );
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not create today's chores");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (template: TaskTemplateDto): Promise<void> => {
    setBusy(true);
    try {
      await api.updateTemplate(template.id, { active: !template.active });
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not update the chore");
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.createTemplate({
        title: title.trim(),
        cadence,
        dueTime,
        ...(cadence === "weekly" ? { weekday } : {}),
        ...(ownerId ? { ownerId } : {}),
      });
      setTitle("");
      setMessage("Chore saved. It will appear on the board the next time chores are created.");
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not save the chore");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Button label="← Back" variant="ghost" onPress={onBack} />
      <Heading>Branch chores</Heading>
      <Text style={styles.hint}>
        Daily and weekly chores that become ordinary tasks on the board. Running them twice in one day creates
        nothing twice.
      </Text>

      {message ? (
        <Card style={{ borderColor: colors.amber }}>
          <Text style={{ color: colors.amber, fontSize: 13 }}>{message}</Text>
        </Card>
      ) : null}

      {canManage ? (
        <Button label={busy ? "Working…" : "Create today's chores"} onPress={() => void runToday()} loading={busy} />
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Chores</Text>
        {loading ? <ActivityIndicator color={colors.mint} /> : null}
        {!loading && templates.length === 0 ? <Empty>No recurring chores yet.</Empty> : null}
        {templates.map((template) => (
          <View key={template.id} style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.body}>{template.title}</Text>
              <Text style={styles.hint}>
                {cadenceLabel(template)} · {template.ownerName ?? "Unassigned"}
                {template.lastRunOn ? ` · last created ${template.lastRunOn}` : ""}
              </Text>
            </View>
            <Badge label={template.active ? "Active" : "Paused"} color={template.active ? colors.mint : colors.muted} />
            {canManage ? (
              <Button
                label={template.active ? "Pause" : "Resume"}
                variant="ghost"
                onPress={() => void toggle(template)}
                loading={busy}
              />
            ) : null}
          </View>
        ))}
      </Card>

      {canManage ? (
        <Card>
          <Text style={styles.sectionTitle}>New chore</Text>
          <Field label="Title" value={title} onChangeText={setTitle} placeholder="Reconcile the vault count" />
          <View style={styles.chipRow}>
            <Chip label="Daily" active={cadence === "daily"} onPress={() => setCadence("daily")} />
            <Chip label="Weekly" active={cadence === "weekly"} onPress={() => setCadence("weekly")} />
          </View>
          {cadence === "weekly" ? (
            <View style={styles.chipRow}>
              {WEEKDAYS.map((label, index) => (
                <Chip key={label} label={label} active={weekday === index} onPress={() => setWeekday(index)} />
              ))}
            </View>
          ) : null}
          <Field
            label="Due time"
            value={dueTime}
            onChangeText={setDueTime}
            placeholder="09:15"
            keyboardType="numbers-and-punctuation"
            hint="Branch time, 24-hour HH:MM."
          />
          <Text style={styles.label}>Owner</Text>
          <View style={styles.chipRow}>
            <Chip label="Unassigned" active={ownerId === null} onPress={() => setOwnerId(null)} />
            {members.map((member) => (
              <Chip
                key={member.id}
                label={member.name.split(" ")[0]!}
                active={ownerId === member.id}
                onPress={() => setOwnerId(member.id)}
              />
            ))}
          </View>
          <Button
            label={busy ? "Saving…" : "Save chore"}
            onPress={() => void add()}
            disabled={title.trim().length < 3 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)}
            loading={busy}
          />
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.text, fontSize: 14, fontWeight: "600" },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  label: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    borderRadius: radius.sm,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});

/** Kept here so the screen can render a pressable task row without importing the board. */
export function SelectableRow({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={title}
      onPress={onPress}
      style={[styles.row, { paddingVertical: spacing.sm }]}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: selected ? colors.mint : colors.border,
          backgroundColor: selected ? `${colors.mint}33` : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.mint, fontSize: 13, fontWeight: "800" }}>{selected ? "✓" : ""}</Text>
      </View>
      <Text style={[styles.body, { flex: 1 }]} numberOfLines={2}>
        {title}
      </Text>
    </Pressable>
  );
}
