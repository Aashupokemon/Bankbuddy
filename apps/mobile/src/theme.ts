export const colors = {
  background: "#070c18",
  surface: "#0d1526",
  surfaceRaised: "#121d33",
  border: "rgba(255,255,255,0.10)",
  text: "#e9eef8",
  muted: "#93a1bd",
  mint: "#34d399",
  mintDark: "#0b3d2c",
  amber: "#fbbf24",
  amberDark: "#3d2f0b",
  blue: "#60a5fa",
  danger: "#f87171",
  dangerDark: "#3d1414",
  white: "#ffffff",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const statusColor: Record<string, string> = {
  open: colors.blue,
  in_progress: colors.mint,
  blocked: colors.danger,
  done: colors.muted,
  cancelled: colors.muted,
  archived: colors.muted,
};

export const priorityColor: Record<string, string> = {
  urgent: colors.danger,
  high: colors.amber,
  normal: colors.blue,
  low: colors.muted,
};
