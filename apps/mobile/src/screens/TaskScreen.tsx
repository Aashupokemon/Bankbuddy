import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  allowedTransitions,
  can,
  canChangeStatus,
  canEditTask,
  reasonRequiredFor,
  statusLabels,
  type MeResponse,
  type TaskDto,
  type TaskStatus,
} from "@bankbuddy/contracts";

import { ApiFailure, api } from "../api";
import { colors, priorityColor, spacing, statusColor } from "../theme";
import { Badge, Button, Card, Chip, Field, Heading } from "../ui";

interface Comment {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

interface Activity {
  id: string;
  summary: string;
  actorName: string;
  createdAt: string;
  reason: string | null;
}

interface Dependency {
  id: string;
  dependsOnTaskId: string;
  dependsOnTitle: string;
  dependsOnStatus: string;
}

export default function TaskScreen({
  me,
  taskId,
  onBack,
  onChanged,
}: {
  me: MeResponse;
  taskId: string;
  onBack: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [task, setTask] = useState<TaskDto | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [dependencies, setDependencies] = useState<{ blocking: Dependency[]; blockedBy: Dependency[] }>({
    blocking: [],
    blockedBy: [],
  });
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [blockedReason, setBlockedReason] = useState("");
  const [pending, setPending] = useState<TaskStatus | null>(null);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [linking, setLinking] = useState(false);
  const [candidates, setCandidates] = useState<TaskDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [taskResponse, commentsResponse, activityResponse, dependencyResponse] = await Promise.all([
        api.task(taskId),
        api.comments(taskId),
        api.activity(taskId),
        api.dependencies(taskId),
      ]);
      setTask(taskResponse);
      setComments(commentsResponse.items);
      setActivity(activityResponse.items);
      setDependencies(dependencyResponse);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not load the task");
    }
  }, [taskId]);

  useEffect(() => {
    void load();
    api
      .members()
      .then((response) => setMembers(response.items))
      .catch(() => setMembers([]));
  }, [load]);

  const changeStatus = async (status: TaskStatus): Promise<void> => {
    if (!task) return;
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.transition(task.id, {
        version: task.version,
        status,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(status === "blocked" ? { blockedReason: blockedReason.trim() || reason.trim() } : {}),
      });
      setTask(updated);
      setReason("");
      setBlockedReason("");
      setPending(null);
      await load();
      onChanged();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === "version_conflict") {
        setMessage("Someone else changed this task. Reloading the latest version.");
        await load();
      } else {
        setMessage(failure instanceof Error ? failure.message : "Could not change the status");
      }
    } finally {
      setBusy(false);
    }
  };

  const addComment = async (): Promise<void> => {
    if (!task || comment.trim().length === 0) return;
    setBusy(true);
    try {
      await api.addComment(task.id, comment.trim());
      setComment("");
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not add the comment");
    } finally {
      setBusy(false);
    }
  };

  const assign = async (ownerId: string): Promise<void> => {
    if (!task) return;
    setBusy(true);
    try {
      const updated = await api.updateTask(task.id, { version: task.version, ownerId });
      setTask(updated);
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not reassign the task");
    } finally {
      setBusy(false);
    }
  };

  const handOver = async (toUserId: string): Promise<void> => {
    if (!task) return;
    setBusy(true);
    try {
      await api.proposeHandover(task.id, toUserId);
      setMessage("Handover proposed. It moves once the other person accepts.");
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not propose the handover");
    } finally {
      setBusy(false);
    }
  };

  const openLinker = async (): Promise<void> => {
    setLinking(true);
    try {
      const response = await api.tasks({ limit: 30 });
      setCandidates(response.items.filter((item) => item.id !== taskId));
    } catch {
      setCandidates([]);
    }
  };

  const link = async (dependsOnTaskId: string): Promise<void> => {
    if (!task) return;
    setBusy(true);
    try {
      await api.addDependency(task.id, dependsOnTaskId);
      setLinking(false);
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not link the task");
    } finally {
      setBusy(false);
    }
  };

  if (!task) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mint} />
        {message ? <Text style={{ color: colors.danger, fontSize: 13 }}>{message}</Text> : null}
      </View>
    );
  }

  const transitions = allowedTransitions[task.status];
  const mayChangeStatus = canChangeStatus(me.role, me.user.id, {
    owner_id: task.ownerId,
    created_by: task.createdBy,
  });
  const mayEdit = canEditTask(me.role, me.user.id, { owner_id: task.ownerId, created_by: task.createdBy });
  const mayAssign = can(me.role, "task.assign");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Button label="← Back to the board" variant="ghost" onPress={onBack} />

      <View style={{ gap: spacing.sm }}>
        <View style={styles.headerRow}>
          <Heading>{task.title}</Heading>
          <Badge label={task.priority} color={priorityColor[task.priority] ?? colors.muted} />
        </View>
        <View style={styles.metaRow}>
          <Badge label={statusLabels[task.status]} color={statusColor[task.status] ?? colors.muted} />
          <Text style={styles.meta}>Owner: {task.ownerName ?? (task.unassigned ? "Unassigned" : "—")}</Text>
          <Text style={styles.meta}>
            Due:{" "}
            {task.dueAt
              ? task.duePrecision === "date"
                ? new Date(task.dueAt).toLocaleDateString()
                : new Date(task.dueAt).toLocaleString()
              : "none"}
          </Text>
          <Text style={styles.meta}>v{task.version}</Text>
        </View>
        {task.blockedReason ? <Text style={{ color: colors.danger, fontSize: 13 }}>Blocked: {task.blockedReason}</Text> : null}
      </View>

      {message ? (
        <Card style={{ borderColor: colors.amber }}>
          <Text style={{ color: colors.amber, fontSize: 13 }}>{message}</Text>
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>Details</Text>
        <Text style={styles.body}>{task.description || "No details yet."}</Text>
      </Card>

      {mayChangeStatus && transitions.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Move it on</Text>
          <View style={styles.chipRow}>
            {transitions.map((next) => (
              <Chip
                key={next}
                label={statusLabels[next]}
                active={pending === next}
                onPress={() => setPending(next === pending ? null : next)}
                color={statusColor[next] ?? colors.mint}
              />
            ))}
          </View>

          {pending ? (
            <View style={{ gap: spacing.sm }}>
              {reasonRequiredFor[task.status].includes(pending) ? (
                <Field
                  label="Why?"
                  value={reason}
                  onChangeText={setReason}
                  placeholder="A reason is required for this change"
                />
              ) : null}
              {pending === "blocked" ? (
                <Field
                  label="What is blocking it?"
                  value={blockedReason}
                  onChangeText={setBlockedReason}
                  placeholder="Keep it non-sensitive"
                />
              ) : null}
              <Button
                label={`Move to ${statusLabels[pending]}`}
                onPress={() => void changeStatus(pending)}
                loading={busy}
              />
            </View>
          ) : null}
        </Card>
      ) : null}

      {mayAssign ? (
        <Card>
          <Text style={styles.sectionTitle}>Reassign</Text>
          <View style={styles.chipRow}>
            {members.map((member) => (
              <Chip key={member.id} label={member.name} onPress={() => void assign(member.id)} />
            ))}
          </View>
          {(mayEdit || mayAssign) && members.some((m) => m.id !== me.user.id) ? (
            <>
              <Text style={styles.sectionTitle}>Hand over the shift</Text>
              <View style={styles.chipRow}>
                {members
                  .filter((member) => member.id !== me.user.id)
                  .map((member) => (
                    <Chip key={`ho-${member.id}`} label={`→ ${member.name}`} onPress={() => void handOver(member.id)} />
                  ))}
              </View>
              <Text style={styles.hint}>The other person has to accept before ownership moves.</Text>
            </>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <View style={styles.headerRow}>
          <Text style={styles.sectionTitle}>Depends on</Text>
          <Button label={linking ? "Cancel" : "Link a task"} variant="ghost" onPress={() => (linking ? setLinking(false) : void openLinker())} />
        </View>
        {dependencies.blocking.length === 0 ? (
          <Text style={styles.hint}>Nothing blocking this task.</Text>
        ) : (
          dependencies.blocking.map((dependency) => (
            <Text key={dependency.id} style={styles.body}>
              · {dependency.dependsOnTitle} ({dependency.dependsOnStatus.replace("_", " ")})
            </Text>
          ))
        )}
        {dependencies.blockedBy.length > 0 ? (
          <Text style={styles.hint}>
            This task blocks {dependencies.blockedBy.length} other task(s).
          </Text>
        ) : null}
        {linking ? (
          <View style={{ gap: spacing.sm }}>
            {candidates.slice(0, 8).map((candidate) => (
              <Chip key={candidate.id} label={candidate.title.slice(0, 40)} onPress={() => void link(candidate.id)} />
            ))}
          </View>
        ) : null}
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>Comments</Text>
        {comments.length === 0 ? <Text style={styles.hint}>No comments yet.</Text> : null}
        {comments.map((item) => (
          <View key={item.id} style={{ gap: 2 }}>
            <Text style={styles.commentMeta}>
              {item.authorName} · {new Date(item.createdAt).toLocaleString()}
            </Text>
            <Text style={styles.body}>{item.body}</Text>
          </View>
        ))}
        <Field label="Add a comment" value={comment} onChangeText={setComment} multiline />
        <Button label="Post comment" onPress={() => void addComment()} loading={busy} />
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>History</Text>
        {activity.map((event) => (
          <View key={event.id} style={{ gap: 1 }}>
            <Text style={styles.body}>{event.summary}</Text>
            <Text style={styles.commentMeta}>
              {event.actorName} · {new Date(event.createdAt).toLocaleString()}
              {event.reason ? ` · “${event.reason}”` : ""}
            </Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, backgroundColor: colors.background },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, alignItems: "center" },
  meta: { color: colors.muted, fontSize: 12 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  commentMeta: { color: colors.muted, fontSize: 11 },
});
