import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { taskPriorities, type ExtractResponse, type MeResponse, type TaskPriority } from "@bankbuddy/contracts";

import { ApiFailure, api, queueOperation } from "../api";
import { colors, spacing } from "../theme";
import { Badge, Button, Card, Chip, Field, Heading } from "../ui";

function newId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

interface Member {
  id: string;
  name: string;
  role: string;
}

export default function CreateScreen({
  me,
  onCreated,
}: {
  me: MeResponse;
  onCreated: (taskId?: string) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"capture" | "form">("capture");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<ExtractResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(me.user.id);
  const [dueText, setDueText] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");

  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    api
      .members()
      .then((response) => setMembers(response.items))
      .catch(() => setMembers([{ id: me.user.id, name: me.user.name, role: me.role }]));
  }, [me.user.id, me.user.name, me.role]);

  const extract = useCallback(async () => {
    if (text.trim().length < 3) {
      setMessage("Say a little more so the draft has something to work with.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await api.extract(text.trim());
      setDraft(response);
      setTitle(response.draft.title);
      setDescription(response.draft.description);
      setPriority(response.draft.priority);
      const owner = members.find((member) => member.name === response.draft.ownerName);
      setOwnerId(owner?.id ?? null);
      setDueText(response.draft.dueAt ? response.draft.dueAt.slice(0, 10) : "");
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Could not read that sentence");
    } finally {
      setBusy(false);
    }
  }, [members, text]);

  const confirm = useCallback(async () => {
    setBusy(true);
    setMessage(null);

    const payload = {
      title: title.trim(),
      description: description.trim() || title.trim(),
      priority,
      ...(ownerId ? { ownerId } : { unassigned: true }),
      ...(dueText ? { dueAt: `${dueText}T00:00:00.000Z`, duePrecision: "date" as const } : {}),
    };

    if (payload.title.length < 3) {
      setBusy(false);
      setMessage("Give the task a title of at least 3 characters.");
      return;
    }

    try {
      const created = await api.createTask(payload);
      setDraft(null);
      setText("");
      setTitle("");
      setDescription("");
      setDueText("");
      onCreated(created.id);
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.status === 0) {
        queueOperation({ id: newId(), kind: "task.create", payload, at: new Date().toISOString() });
        setMessage("You are offline. The task is queued and will be sent when the connection returns.");
        onCreated();
      } else {
        setMessage(failure instanceof Error ? failure.message : "Could not create the task");
      }
    } finally {
      setBusy(false);
    }
  }, [description, dueText, onCreated, ownerId, priority, title]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={{ gap: 2 }}>
        <Heading>Capture work</Heading>
        <Text style={styles.subtitle}>Say it in a sentence, check the draft, then save it.</Text>
      </View>

      <View style={styles.modeRow}>
        <Chip label="From a sentence" active={mode === "capture"} onPress={() => setMode("capture")} />
        <Chip label="Plain form" active={mode === "form"} onPress={() => setMode("form")} />
      </View>

      {message ? (
        <Card style={{ borderColor: colors.amber }}>
          <Text style={{ color: colors.amber, fontSize: 13 }}>{message}</Text>
        </Card>
      ) : null}

      {mode === "capture" && !draft ? (
        <Card>
          <Field
            label="What needs doing?"
            value={text}
            onChangeText={setText}
            placeholder="Ravi will call the Sharma account about the KYC gap by Thursday"
            multiline
          />
          <Text style={styles.hint}>
            Nothing is saved until you confirm. The assistant only ever produces a draft.
          </Text>
          <Button label={busy ? "Reading…" : "Draft the task"} onPress={() => void extract()} loading={busy} />
        </Card>
      ) : null}

      {(draft || mode === "form") && (
        <Card>
          <View style={styles.previewHeader}>
            <Text style={styles.sectionTitle}>{draft ? "Check the draft" : "New task"}</Text>
            {draft ? <Badge label={`via ${draft.provider}`} color={colors.mint} /> : null}
          </View>

          {draft?.warnings.length ? (
            <View style={styles.warnings}>
              {draft.warnings.map((warning) => (
                <Text key={warning} style={styles.warning}>
                  · {warning.replaceAll("_", " ")}
                </Text>
              ))}
            </View>
          ) : null}

          <Field label="Title" value={title} onChangeText={setTitle} />
          <Field label="Details" value={description} onChangeText={setDescription} multiline />
          <Field
            label="Due date"
            value={dueText}
            onChangeText={setDueText}
            placeholder="2030-05-06"
            hint="Date only. Leave empty for no deadline."
          />

          <Text style={styles.label}>Priority</Text>
          <View style={styles.chipRow}>
            {taskPriorities.map((value) => (
              <Chip
                key={value}
                label={value}
                active={priority === value}
                onPress={() => setPriority(value)}
                color={value === "urgent" ? colors.danger : colors.mint}
              />
            ))}
          </View>

          <Text style={styles.label}>Owner</Text>
          <View style={styles.chipRow}>
            {members.map((member) => (
              <Chip
                key={member.id}
                label={member.name}
                active={ownerId === member.id}
                onPress={() => setOwnerId(member.id)}
              />
            ))}
            <Chip label="Unassigned" active={ownerId === null} onPress={() => setOwnerId(null)} />
          </View>

          <Button label={busy ? "Saving…" : "Save the task"} onPress={() => void confirm()} loading={busy} />
          {draft ? (
            <Button
              label="Back to the sentence"
              variant="ghost"
              onPress={() => {
                setDraft(null);
                setTitle("");
                setDescription("");
              }}
            />
          ) : null}
        </Card>
      )}

      {mode === "capture" ? (
        <Text style={styles.footnote}>
          The assistant runs with no write access. If it is unavailable, you can always create the task
          from the plain form.
        </Text>
      ) : null}

      {busy ? <ActivityIndicator color={colors.mint} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  subtitle: { color: colors.muted, fontSize: 13 },
  modeRow: { flexDirection: "row", gap: spacing.sm },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  previewHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  warnings: { gap: 2 },
  warning: { color: colors.amber, fontSize: 12 },
  label: { color: colors.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  footnote: { color: colors.muted, fontSize: 11, lineHeight: 16, textAlign: "center" },
});
