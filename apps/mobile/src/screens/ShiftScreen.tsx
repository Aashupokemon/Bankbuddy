import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { can, taskPriorities, type MeResponse, type TaskDto, type TaskPriority, type TaskStatus } from "@bankbuddy/contracts";

import { api } from "../api";
import { colors, spacing } from "../theme";
import { Badge, Button, Card, Chip, Empty, Heading } from "../ui";
import { SelectableRow } from "./TemplatesScreen";

const ACTIONABLE = new Set(["open", "in_progress", "blocked"]);

/**
 * Bulk reassignment and whole-shift handover. Managers pick tasks and a person; anyone who may hand
 * work over can offer the entire open shift in one step, which the receiver still has to accept.
 */
export default function ShiftScreen({
  me,
  onBack,
  onChanged,
}: {
  me: MeResponse;
  onBack: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const [confirmingShift, setConfirmingShift] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canAssign = can(me.role, "task.assign");
  const canHandOver = can(me.role, "handover.propose");
  const canEditAny = can(me.role, "task.update.any");

  // Categories actually in use, rather than a settings screen nobody opens during a shift change.
  const categories = [...new Set(tasks.map((task) => task.categoryKey).filter((key): key is string => Boolean(key)))];

  const load = useCallback(async () => {
    try {
      const [taskResponse, memberResponse] = await Promise.all([
        api.tasks({ limit: 100 }),
        api.members(),
      ]);
      setTasks(taskResponse.items.filter((task) => ACTIONABLE.has(task.status)));
      setMembers(memberResponse.items.filter((member) => member.id !== me.user.id));
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not load the team");
    } finally {
      setLoading(false);
    }
  }, [me.user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reassign = async (ownerId: string | null): Promise<void> => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const result = await api.bulkReassign([...selected], ownerId);
      setMessage(
        ownerId === null
          ? `Left ${result.updated} task(s) unassigned.`
          : `Moved ${result.updated} task(s) to ${members.find((member) => member.id === ownerId)?.name ?? "them"}.`,
      );
      setSelected(new Set());
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not reassign the tasks");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Bulk priority, category and status. Status goes through the same rules as a single change, so the
   * server reports per-task refusals (an open dependency, a missing reason) instead of the batch
   * silently skipping them.
   */
  const bulkEdit = async (change: {
    priority?: TaskPriority;
    categoryKey?: string | null;
    status?: TaskStatus;
  }): Promise<void> => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const result = await api.bulkUpdate({ taskIds: [...selected], ...change });
      setMessage(
        result.errors.length === 0
          ? `Changed ${result.updated} task(s).`
          : `Changed ${result.updated} task(s); ${result.errors.length} were refused (${result.errors[0]!.message}).`,
      );
      setSelected(new Set());
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not change the tasks");
    } finally {
      setBusy(false);
    }
  };

  const handOverShift = async (): Promise<void> => {
    if (!target) return;
    if (!confirmingShift) {
      setConfirmingShift(true);
      return;
    }
    setBusy(true);
    try {
      await api.handoverShift(target);
      setMessage(
        `Handed the shift to ${members.find((member) => member.id === target)?.name ?? "them"}. Nothing moves until they accept.`,
      );
      setConfirmingShift(false);
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not hand over the shift");
    } finally {
      setBusy(false);
    }
  };

  const mine = tasks.filter((task) => task.ownerId === me.user.id).length;
  const targetName = members.find((member) => member.id === target)?.name ?? "someone";
  const pickedName = members.find((member) => member.id === target)?.name.split(" ")[0] ?? null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Button label="← Back" variant="ghost" onPress={onBack} />
      <Heading>Shift handover</Heading>
      <Text style={styles.hint}>
        Move work between people at shift change. A whole-shift handover transfers nothing until the person
        receiving it accepts.
      </Text>

      {message ? (
        <Card style={{ borderColor: colors.amber }}>
          <Text style={{ color: colors.amber, fontSize: 13 }}>{message}</Text>
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Who receives it</Text>
        <View style={styles.chipRow}>
          {members.map((member) => (
            <Chip
              key={member.id}
              label={member.name}
              active={target === member.id}
              onPress={() => {
                setTarget(member.id);
                setConfirmingShift(false);
              }}
            />
          ))}
        </View>
        {members.length === 0 && !loading ? <Empty>No other people in this branch.</Empty> : null}
      </Card>

      {canHandOver ? (
        <Card>
          <Text style={styles.sectionTitle}>Whole shift</Text>
          <Text style={styles.hint}>
            Offers every open, in-progress or blocked task you own ({mine} right now). Use it when you leave at
            the end of a shift.
          </Text>
          <Button
            label={
              confirmingShift
                ? `Tap again to hand over to ${targetName.split(" ")[0]}`
                : `Hand my shift to ${targetName.split(" ")[0] ?? "someone"}`
            }
            variant={confirmingShift ? "primary" : "ghost"}
            disabled={!target || mine === 0}
            loading={busy}
            onPress={() => void handOverShift()}
          />
        </Card>
      ) : null}

      {canAssign ? (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Bulk reassign</Text>
            <Badge label={`${selected.size} selected`} color={selected.size ? colors.mint : colors.muted} />
          </View>
          <Text style={styles.hint}>
            Pick tasks, then send them all to one person or leave them unassigned for the next shift to pick up.
          </Text>
          <View style={styles.actionRow}>
            <Button
              label={pickedName ? `Send to ${pickedName}` : "Send to…"}
              disabled={!target || selected.size === 0}
              loading={busy}
              onPress={() => void reassign(target)}
            />
            <Button
              label="Leave unassigned"
              variant="ghost"
              disabled={selected.size === 0}
              loading={busy}
              onPress={() => void reassign(null)}
            />
          </View>
        </Card>
      ) : null}

      {canEditAny ? (
        <Card>
          <Text style={styles.sectionTitle}>Bulk priority, category and status</Text>
          <Text style={styles.hint}>Applies to the {selected.size} selected task(s).</Text>
          <View style={styles.chipRow}>
            {taskPriorities.map((priority) => (
              <Chip
                key={priority}
                label={priority}
                onPress={() => void bulkEdit({ priority })}
                color={priority === "urgent" ? colors.danger : colors.mint}
              />
            ))}
          </View>
          <View style={styles.chipRow}>
            {categories.map((key) => (
              <Chip key={key} label={key.replace(/_/g, " ")} onPress={() => void bulkEdit({ categoryKey: key })} />
            ))}
            <Chip label="no category" onPress={() => void bulkEdit({ categoryKey: null })} />
          </View>
          <View style={styles.chipRow}>
            <Chip label="Start" onPress={() => void bulkEdit({ status: "in_progress" })} />
            <Chip label="Done" onPress={() => void bulkEdit({ status: "done" })} />
            <Chip label="Blocked" onPress={() => void bulkEdit({ status: "blocked" })} />
          </View>
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Open work</Text>
        {loading ? <ActivityIndicator color={colors.mint} /> : null}
        {!loading && tasks.length === 0 ? <Empty>Nothing open in this branch.</Empty> : null}
        {tasks.map((task) => (
          <SelectableRow
            key={task.id}
            title={`${task.title} · ${task.ownerName ?? (task.unassigned ? "Unassigned" : "No owner")}`}
            selected={selected.has(task.id)}
            onPress={() => toggle(task.id)}
          />
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  actionRow: { gap: spacing.sm },
});
