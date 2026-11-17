import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";

import type { MeResponse } from "@bankbuddy/contracts";

import { api, clearToken, flushQueue, loadToken, subscribeQueue } from "./api";
import BoardScreen from "./screens/BoardScreen";
import CreateScreen from "./screens/CreateScreen";
import LoginScreen from "./screens/LoginScreen";
import MoreScreen from "./screens/MoreScreen";
import TaskScreen from "./screens/TaskScreen";
import { colors, radius, spacing } from "./theme";

type Tab = "board" | "capture" | "more";

export default function App(): React.JSX.Element {
  const [booting, setBooting] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tab, setTab] = useState<Tab>("board");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) setMe(await api.me());
      } catch {
        await clearToken();
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  // The pending count is read from device storage, so it is correct immediately after a relaunch.
  useEffect(() => subscribeQueue(setQueued), []);

  // Replay anything left over from a previous session as soon as we know who we are.
  useEffect(() => {
    if (!me) return;
    void flushQueue()
      .then((outcome) => {
        if (outcome.applied > 0) refresh();
      })
      .catch(() => undefined);
  }, [me, refresh]);

  if (booting) {
    return (
      <SafeAreaView style={styles.splash}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.brand}>BankBuddy</Text>
        <ActivityIndicator color={colors.mint} />
      </SafeAreaView>
    );
  }

  if (!me) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <LoginScreen
          onSignedIn={(_token, response) => {
            setMe(response);
            setTab("board");
          }}
        />
      </SafeAreaView>
    );
  }

  const content = taskId ? (
    <TaskScreen
      me={me}
      taskId={taskId}
      onBack={() => setTaskId(null)}
      onChanged={refresh}
    />
  ) : tab === "board" ? (
    <BoardScreen me={me} onOpenTask={setTaskId} refreshKey={refreshKey} />
  ) : tab === "capture" ? (
    <CreateScreen
      me={me}
      onCreated={(createdId) => {
        refresh();
        if (createdId) setTaskId(createdId);
        else setTab("board");
      }}
    />
  ) : (
    <MoreScreen
      me={me}
      onSignOut={() => {
        void api.logout().catch(() => undefined);
        void clearToken();
        setMe(null);
        setTaskId(null);
      }}
      onOpenTask={setTaskId}
    />
  );

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>{content}</View>

      {taskId ? null : (
        <View style={styles.tabBar}>
          <TabButton label="Board" active={tab === "board"} onPress={() => setTab("board")} />
          <TabButton label="Capture" active={tab === "capture"} onPress={() => setTab("capture")} />
          <TabButton
            label={queued > 0 ? `More (${queued})` : "More"}
            active={tab === "more"}
            onPress={() => setTab("more")}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.tab, active ? styles.tabActive : null]}
    >
      <Text style={[styles.tabLabel, active ? { color: colors.mint } : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  splash: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
  },
  brand: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.5 },
  content: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  tabActive: { backgroundColor: colors.mintDark },
  tabLabel: { color: colors.muted, fontSize: 13, fontWeight: "700" },
});
