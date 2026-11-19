import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { DashboardResponse, MeResponse, TaskDto } from "@bankbuddy/contracts";

import { api } from "../api";
import { colors, priorityColor, radius, spacing, statusColor } from "../theme";
import { Badge, Card, Chip, Empty } from "../ui";

type Filter = "all" | "mine" | "due_today" | "overdue" | "blocked";

const FILTER_KEY = "bankbuddy.board-filter.v1";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "due_today", label: "Due today" },
  { key: "overdue", label: "Overdue" },
  { key: "blocked", label: "Blocked" },
];

function formatDue(task: TaskDto): string {
  if (!task.dueAt) return "No due date";
  const date = new Date(task.dueAt);
  if (task.duePrecision === "date") {
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${date.toLocaleTimeString(
    undefined,
    { hour: "2-digit", minute: "2-digit" },
  )}`;
}

export function TaskRow({ task, onPress }: { task: TaskDto; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${task.status.replace("_", " ")}, ${formatDue(task)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Badge label={task.priority} color={priorityColor[task.priority] ?? colors.muted} />
      </View>
      <View style={styles.rowMeta}>
        <Badge label={task.status.replace("_", " ")} color={statusColor[task.status] ?? colors.muted} />
        <Text style={[styles.metaText, task.isOverdue ? { color: colors.danger, fontWeight: "700" } : null]}>
          {task.isOverdue ? "Overdue · " : ""}
          {formatDue(task)}
        </Text>
        <Text style={styles.metaText}>{task.ownerName ?? (task.unassigned ? "Unassigned" : "No owner")}</Text>
      </View>
      {task.blockedByCount > 0 ? (
        <Text style={[styles.metaText, { color: colors.amber }]}>
          Waiting on {task.blockedByCount} other task{task.blockedByCount > 1 ? "s" : ""}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function BoardScreen({
  me,
  onOpenTask,
  refreshKey,
}: {
  me: MeResponse;
  onOpenTask: (id: string) => void;
  refreshKey: number;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [dashboardResponse, list] = await Promise.all([
        api.dashboard(),
        api.tasks({
          ...(filter === "mine" ? { scope: "mine" } : {}),
          ...(filter === "all" ? {} : { filter }),
          ...(query ? { q: query } : {}),
          limit: 50,
        }),
      ]);
      setDashboard(dashboardResponse);
      setTasks(list.items);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load the board");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, query]);

  // One request per pause in typing, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // The filter someone last chose is remembered on the device, so a reopened board is where they left it.
  useEffect(() => {
    void AsyncStorage.getItem(FILTER_KEY)
      .then((stored) => {
        if (stored && FILTERS.some((item) => item.key === stored)) setFilter(stored as Filter);
      })
      .catch(() => undefined);
  }, []);

  const chooseFilter = (next: Filter): void => {
    setFilter(next);
    void AsyncStorage.setItem(FILTER_KEY, next).catch(() => undefined);
  };

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const counts = dashboard?.counts;

  return (
    <FlatList
      data={tasks}
      keyExtractor={(task) => task.id}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.mint}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: spacing.md }}>
          <View>
            <Text style={styles.branch}>{me.branch.name}</Text>
            <Text style={styles.subtitle}>
              {me.user.name} · {me.role.replace("_", " ")}
            </Text>
          </View>

          <View style={styles.countsGrid}>
            {[
              { label: "Overdue", value: counts?.overdue ?? 0, color: colors.danger },
              { label: "Due today", value: counts?.dueToday ?? 0, color: colors.amber },
              { label: "Blocked", value: counts?.blocked ?? 0, color: colors.amber },
              { label: "In progress", value: counts?.inProgress ?? 0, color: colors.mint },
              { label: "Mine", value: counts?.mine ?? 0, color: colors.blue },
              { label: "Unassigned", value: counts?.unassigned ?? 0, color: colors.muted },
            ].map((item) => (
              <Card key={item.label} style={styles.countCard}>
                <Text style={[styles.countValue, { color: item.color }]}>{item.value}</Text>
                <Text style={styles.countLabel}>{item.label}</Text>
              </Card>
            ))}
          </View>

          <TextInput
            testID="board-search"
            accessibilityLabel="Search tasks"
            value={search}
            onChangeText={setSearch}
            placeholder="Search title or details"
            placeholderTextColor={colors.muted}
            returnKeyType="search"
            style={styles.search}
          />

          <View style={styles.filterRow}>
            {FILTERS.map((item) => (
              <Chip
                key={item.key}
                label={item.label}
                active={filter === item.key}
                onPress={() => chooseFilter(item.key)}
              />
            ))}
          </View>

          {query && !loading ? (
            <Text style={styles.metaText}>
              {tasks.length} matching “{query}”
            </Text>
          ) : null}

          {error ? <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text> : null}
          {loading ? <ActivityIndicator color={colors.mint} /> : null}
        </View>
      }
      ListEmptyComponent={
        loading ? null : (
          <Empty>
            {query ? `Nothing matches “${query}”.` : "Nothing here. Capture something from the “Capture” tab."}
          </Empty>
        )
      }
      ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
      renderItem={({ item }) => <TaskRow task={item} onPress={() => onOpenTask(item.id)} />}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  branch: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: colors.muted, fontSize: 13, textTransform: "capitalize" },
  countsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  countCard: {
    flexBasis: "31%",
    flexGrow: 1,
    padding: spacing.md,
    alignItems: "flex-start",
    gap: 2,
  },
  countValue: { fontSize: 22, fontWeight: "800" },
  countLabel: { color: colors.muted, fontSize: 11 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    fontSize: 15,
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  rowHeader: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start", justifyContent: "space-between" },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1, lineHeight: 20 },
  rowMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  metaText: { color: colors.muted, fontSize: 12 },
});
