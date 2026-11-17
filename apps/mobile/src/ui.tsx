import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

import { colors, radius, spacing } from "./theme";

export function Card({ children, style }: { children: React.ReactNode; style?: object }): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
}): React.JSX.Element {
  const palette =
    variant === "primary"
      ? { backgroundColor: colors.mint, borderColor: colors.mint, text: "#04120c" }
      : variant === "danger"
        ? { backgroundColor: colors.dangerDark, borderColor: colors.danger, text: colors.danger }
        : { backgroundColor: "transparent", borderColor: colors.border, text: colors.text };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.backgroundColor,
          borderColor: palette.borderColor,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} size="small" />
      ) : (
        <Text style={[styles.buttonText, { color: palette.text }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  active,
  onPress,
  color,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  color?: string;
}): React.JSX.Element {
  const tint = color ?? colors.mint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: active ? tint : colors.border,
          backgroundColor: active ? `${tint}22` : "transparent",
        },
      ]}
    >
      <Text style={{ color: active ? tint : colors.muted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }): React.JSX.Element {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[styles.input, props.multiline ? styles.multiline : null]}
        {...props}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Heading({ children, level = 1 }: { children: React.ReactNode; level?: 1 | 2 }): React.JSX.Element {
  return (
    <Text accessibilityRole="header" style={level === 1 ? styles.h1 : styles.h2}>
      {children}
    </Text>
  );
}

export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.empty}>{children}</Text>;
}

export function Badge({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: `${color}1f` }]}>
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  buttonText: { fontSize: 15, fontWeight: "700" },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  label: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
  },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  hint: { color: colors.muted, fontSize: 12 },
  h1: { color: colors.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.6 },
  h2: { color: colors.text, fontSize: 17, fontWeight: "700" },
  empty: { color: colors.muted, fontSize: 14, paddingVertical: spacing.lg, textAlign: "center" },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
});
