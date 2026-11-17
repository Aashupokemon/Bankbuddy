import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { MeResponse } from "@bankbuddy/contracts";

import { API_URL, api, saveToken, type DevUser } from "../api";
import { colors, radius, spacing } from "../theme";
import { Badge, Button, Card, Heading } from "../ui";

export default function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (token: string, me: MeResponse) => void;
}): React.JSX.Element {
  const [users, setUsers] = useState<DevUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.devUsers();
      setUsers(response.users);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load users");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = async (email: string): Promise<void> => {
    setBusy(email);
    setError(null);
    try {
      const response = await api.login(email);
      await saveToken(response.token);
      onSignedIn(response.token, response.me);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not sign in");
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.mark}>BB</Text>
        <Heading>BankBuddy</Heading>
        <Text style={styles.tagline}>Branch task workspace · pilot build</Text>
      </View>

      <Card>
        <Text style={styles.sectionTitle}>Sign in</Text>
        <Text style={styles.body}>
          This is the development sign-in. Pick one of the synthetic pilot users — there are no passwords
          and no real accounts.
        </Text>
      </Card>

      {error ? (
        <Card style={{ borderColor: colors.danger }}>
          <Text style={styles.errorTitle}>Cannot reach the API</Text>
          <Text style={styles.body}>{error}</Text>
          <Text style={styles.body}>
            Start it with <Text style={styles.code}>npm run api</Text>, then check that{" "}
            <Text style={styles.code}>{API_URL}</Text> is reachable from this device.
          </Text>
          <Button label="Try again" variant="ghost" onPress={() => void load()} />
        </Card>
      ) : null}

      {users.length === 0 && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.mint} />
          <Text style={styles.body}>Loading pilot users…</Text>
        </View>
      ) : null}

      {users.map((user) => (
        <Pressable
          key={`${user.email}-${user.branch}`}
          accessibilityRole="button"
          accessibilityLabel={`Sign in as ${user.name}, ${user.role}`}
          onPress={() => void signIn(user.email)}
          style={({ pressed }) => [styles.userRow, { opacity: pressed ? 0.75 : 1 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.userName}>{user.name}</Text>
            <Text style={styles.userMeta}>
              {user.role.replace("_", " ")} · {user.branch}
            </Text>
          </View>
          {busy === user.email ? (
            <ActivityIndicator color={colors.mint} />
          ) : (
            <Badge label="Sign in" color={colors.mint} />
          )}
        </Pressable>
      ))}

      <Text style={styles.footnote}>
        Synthetic data only. Nothing here is connected to a bank system.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, backgroundColor: colors.background, flexGrow: 1 },
  brand: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl },
  mark: {
    width: 52,
    height: 52,
    borderRadius: 16,
    textAlign: "center",
    textAlignVertical: "center",
    lineHeight: 52,
    color: colors.mint,
    backgroundColor: colors.mintDark,
    fontWeight: "800",
    fontSize: 18,
    overflow: "hidden",
  },
  tagline: { color: colors.muted, fontSize: 13 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  errorTitle: { color: colors.danger, fontSize: 14, fontWeight: "700" },
  code: { color: colors.mint, fontWeight: "600" },
  loading: { flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center" },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  userName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  userMeta: { color: colors.muted, fontSize: 12, textTransform: "capitalize" },
  footnote: { color: colors.muted, fontSize: 11, textAlign: "center", paddingVertical: spacing.lg },
});
