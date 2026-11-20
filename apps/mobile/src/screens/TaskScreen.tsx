import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import * as ImagePicker from "expo-image-picker";

import {
  allowedTransitions,
  can,
  canChangeStatus,
  canEditTask,
  reasonRequiredFor,
  statusLabels,
  type ChecklistItemDto,
  type ChecklistResponse,
  type MeResponse,
  type TaskDto,
  type TaskStatus,
} from "@bankbuddy/contracts";

import { ApiFailure, api, enqueueOperation, newClientId, saveEvidenceOffline } from "../api";
import { writeChecklistStep } from "../checklistSync";
import { cacheKeys, recall, remember } from "../offlineCache";
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
  const [checklist, setChecklist] = useState<ChecklistResponse | null>(null);
  const [step, setStep] = useState("");
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
  // Photo evidence, already turned into data URLs because an <Image> tag cannot send the bearer token.
  const [photos, setPhotos] = useState<Record<string, string>>({});

  const loadPhotos = useCallback(async (items: ChecklistItemDto[]) => {
    const entries = await Promise.all(
      items
        .filter((item) => item.attachmentId)
        .map(async (item) => {
          try {
            const file = await api.attachment(item.attachmentId!);
            return [item.id, `data:${file.contentType};base64,${file.dataBase64}`] as const;
          } catch {
            return null;
          }
        }),
    );
    const next: Record<string, string> = {};
    for (const entry of entries) if (entry) next[entry[0]] = entry[1];
    // A file:// entry is a photo still waiting in the offline queue; once the server has the step's
    // photo it replaces the held file.
    setPhotos((current) => {
      const held: Record<string, string> = {};
      for (const [id, uri] of Object.entries(current)) if (uri.startsWith("file:")) held[id] = uri;
      return { ...held, ...next };
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [taskResponse, checklistResponse, commentsResponse, activityResponse, dependencyResponse] =
        await Promise.all([
          api.task(taskId),
          api.checklist(taskId),
          api.comments(taskId),
          api.activity(taskId),
          api.dependencies(taskId),
        ]);
      setTask(taskResponse);
      setChecklist(checklistResponse);
      setComments(commentsResponse.items);
      setActivity(activityResponse.items);
      setDependencies(dependencyResponse);
      void loadPhotos(checklistResponse.items);
      // A copy for the next time this task is opened without a connection.
      void remember(cacheKeys.task(taskId), taskResponse);
      void remember(cacheKeys.checklist(taskId), checklistResponse);
    } catch (failure) {
      const cached = await recall<TaskDto>(cacheKeys.task(taskId));
      if (cached) {
        setTask(cached.value);
        const cachedChecklist = await recall<ChecklistResponse>(cacheKeys.checklist(taskId));
        if (cachedChecklist) {
          setChecklist(cachedChecklist.value);
          void loadPhotos(cachedChecklist.value.items);
        }
        setMessage("Showing the last copy saved on this phone. Changes need a connection.");
      } else {
        setMessage(failure instanceof Error ? failure.message : "Could not load the task");
      }
    }
  }, [loadPhotos, taskId]);

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

  /**
   * Checklist writes are the most repeated action in the app, so a tick made without a connection is
   * queued and shown immediately instead of being lost. The queue replays it exactly once.
   */
  const queueStep = async (
    kind: "checklist.add" | "checklist.update" | "checklist.remove",
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await enqueueOperation({ id: newClientId(), kind, payload, at: new Date().toISOString() });
  };

  /** Applies a queued write to the checklist on screen, keeping its done/total in step. */
  const editLocally = (change: (items: ChecklistItemDto[]) => ChecklistItemDto[]): void => {
    setChecklist((current) => {
      if (!current) return current;
      const items = change(current.items);
      return { items, done: items.filter((entry) => entry.done).length, total: items.length };
    });
  };

  const toggleStep = async (item: ChecklistItemDto): Promise<void> => {
    if (!task) return;
    setMessage(null);
    try {
      const write = await writeChecklistStep({
        send: () => api.updateChecklistItem(task.id, item.id, { done: !item.done }),
        queue: () => queueStep("checklist.update", { taskId: task.id, itemId: item.id, done: !item.done }),
      });
      if (write.queued) {
        editLocally((items) =>
          items.map((entry) =>
            entry.id === item.id
              ? { ...entry, done: !item.done, completedAt: !item.done ? new Date().toISOString() : null }
              : entry,
          ),
        );
        setMessage("Offline — the tick is saved on this phone and will sync.");
        return;
      }
      setChecklist(await api.checklist(task.id));
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not update the checklist");
    }
  };

  const addStep = async (): Promise<void> => {
    if (!task || step.trim().length === 0) return;
    setMessage(null);
    const title = step.trim();
    try {
      const write = await writeChecklistStep({
        send: () => api.addChecklistItem(task.id, title),
        queue: () => queueStep("checklist.add", { taskId: task.id, title }),
      });
      if (write.queued) {
        editLocally((items) => [
          ...items,
          {
            id: `local-${Date.now()}`,
            taskId: task.id,
            title,
            done: false,
            position: items.length,
            completedAt: null,
            createdAt: new Date().toISOString(),
            attachmentId: null,
          },
        ]);
        setStep("");
        setMessage("Offline — the step is saved on this phone and will sync.");
        return;
      }
      setStep("");
      setChecklist(await api.checklist(task.id));
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not add the step");
    }
  };

  const removeStep = async (itemId: string): Promise<void> => {
    if (!task) return;
    setMessage(null);
    try {
      const write = await writeChecklistStep({
        send: () => api.removeChecklistItem(task.id, itemId),
        queue: () => queueStep("checklist.remove", { taskId: task.id, itemId }),
      });
      if (write.queued) {
        editLocally((items) => items.filter((entry) => entry.id !== itemId));
        setMessage("Offline — the removal is saved on this phone and will sync.");
        return;
      }
      setChecklist(await api.checklist(task.id));
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not remove the step");
    }
  };

  /**
   * Photo evidence for a checklist step. The camera result is downscaled by quality and sent as
   * base64; the server caps the decoded size, so a huge picture fails with a readable message rather
   * than a broken upload.
   */
  const takePhoto = async (item: ChecklistItemDto): Promise<void> => {
    if (!task) return;
    setMessage(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setMessage("Camera access is needed to attach a photo.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.4,
        base64: true,
        exif: false,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      const dataBase64 = asset?.base64;
      if (!dataBase64) {
        setMessage("That photo could not be read from the camera.");
        return;
      }
      const contentType = asset?.mimeType === "image/png" ? "image/png" : "image/jpeg";
      setBusy(true);
      const write = await writeChecklistStep({
        send: () => api.addAttachment(task.id, { checklistItemId: item.id, contentType, dataBase64 }),
        // Without a connection the bytes stay on this phone and the upload joins the offline queue.
        queue: async () => {
          const held = await saveEvidenceOffline({ taskId: task.id, itemId: item.id, contentType, dataBase64 });
          setPhotos((current) => ({ ...current, [item.id]: held.uri }));
        },
      });
      if (write.queued) {
        setMessage("Offline — the photo is saved on this phone and will upload when you sync.");
        return;
      }
      // Reloading also refetches the new photo, so the thumbnail comes from the server's copy.
      await load();
      onChanged();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not attach the photo");
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
  // Only unfinished blockers hold work back; a done dependency is history, not a gate.
  const openBlockers = dependencies.blocking.filter(
    (dependency) => !["done", "cancelled", "archived"].includes(dependency.dependsOnStatus),
  );

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

      <Card>
        <View style={styles.headerRow}>
          <Text style={styles.sectionTitle}>Checklist</Text>
          {checklist && checklist.total > 0 ? (
            <Badge
              label={`${checklist.done}/${checklist.total}`}
              color={checklist.done === checklist.total ? colors.mint : colors.muted}
            />
          ) : null}
        </View>
        {checklist && checklist.total > 0 ? (
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${Math.round((checklist.done / checklist.total) * 100)}%` }]}
            />
          </View>
        ) : null}
        {checklist && checklist.items.length > 0 ? (
          checklist.items.map((item) => (
            <View key={item.id} style={{ gap: spacing.xs }}>
              <View style={styles.stepRow}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: item.done, disabled: !mayEdit || busy }}
                  accessibilityLabel={item.title}
                  disabled={!mayEdit || busy}
                  onPress={() => void toggleStep(item)}
                  style={styles.stepToggle}
                >
                  <View style={[styles.checkbox, item.done ? styles.checkboxDone : null]}>
                    {item.done ? <Text style={styles.checkboxMark}>✓</Text> : null}
                  </View>
                  <Text style={[styles.body, item.done ? styles.stepDone : null]}>{item.title}</Text>
                </Pressable>
                {/* A step that has not reached the server has no id to attach a photo to yet. */}
                {mayEdit && !item.id.startsWith("local-") ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Take a photo for ${item.title}`}
                    hitSlop={8}
                    disabled={busy}
                    onPress={() => void takePhoto(item)}
                  >
                    <Text style={styles.camera}>📷</Text>
                  </Pressable>
                ) : null}
                {mayEdit ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.title}`}
                    hitSlop={10}
                    onPress={() => void removeStep(item.id)}
                  >
                    <Text style={styles.removeStep}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
              {photos[item.id] ? (
                <Pressable
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`Photo attached — ${item.title}`}
                  onPress={() => void takePhoto(item)}
                >
                  <Image source={{ uri: photos[item.id] }} style={styles.photo} />
                </Pressable>
              ) : item.attachmentId ? (
                <Text style={styles.hint}>Photo attached</Text>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.hint}>No steps yet.</Text>
        )}
        {mayEdit ? (
          <View style={{ gap: spacing.sm }}>
            <Field label="Add a step" value={step} onChangeText={setStep} placeholder="One checkable step" />
            <Button
              label="Add a step"
              variant="ghost"
              onPress={() => void addStep()}
              loading={busy}
              disabled={step.trim().length === 0}
            />
          </View>
        ) : null}
      </Card>

      {mayChangeStatus && transitions.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Move it on</Text>
          {openBlockers.length > 0 ? (
            <Text style={{ color: colors.amber, fontSize: 12 }}>
              Waiting on {openBlockers.map((blocker) => blocker.dependsOnTitle).join(", ")} — starting or
              finishing this task is refused until they close.
            </Text>
          ) : null}
          <View style={styles.chipRow}>
            {transitions.map((next) => {
              const heldBack = openBlockers.length > 0 && (next === "in_progress" || next === "done");
              return (
                <Chip
                  key={next}
                  label={heldBack ? `${statusLabels[next]} · blocked` : statusLabels[next]}
                  active={pending === next}
                  onPress={() =>
                    heldBack
                      ?                         setMessage(
                          `Waiting on ${openBlockers.map((blocker) => blocker.dependsOnTitle).join(", ")}.`,
                        )
                      : setPending(next === pending ? null : next)
                  }
                  color={heldBack ? colors.muted : (statusColor[next] ?? colors.mint)}
                />
              );
            })}
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
        <Field
          label="Add a comment"
          value={comment}
          onChangeText={setComment}
          multiline
          hint="Write @Name to notify that person without leaving the task."
        />
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
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.mint },
  stepRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stepToggle: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 36 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  checkboxDone: { backgroundColor: colors.mintDark, borderColor: colors.mint },
  checkboxMark: { color: colors.mint, fontSize: 13, fontWeight: "800", lineHeight: 15 },
  stepDone: { color: colors.muted, textDecorationLine: "line-through" },
  removeStep: { color: colors.muted, fontSize: 15, paddingHorizontal: spacing.sm },
  camera: { fontSize: 17, paddingHorizontal: 4 },
  photo: { width: 96, height: 96, borderRadius: 10, marginLeft: spacing.xl, backgroundColor: colors.surfaceRaised },
});
