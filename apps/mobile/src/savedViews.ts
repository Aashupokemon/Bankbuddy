/**
 * Named board filters, kept on the device.
 *
 * A branch lead opens the same three views every morning ("my overdue", "unassigned today"). Storing
 * them locally means the habit survives a restart without adding a settings screen somewhere on the
 * server that nobody would maintain.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface SavedView {
  id: string;
  name: string;
  filter: "all" | "mine" | "due_today" | "overdue" | "blocked";
  query: string;
}

const STORAGE_KEY = "bankbuddy.saved-views.v1";
const MAX_VIEWS = 8;

function isView(value: unknown): value is SavedView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedView>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.filter === "string" &&
    typeof candidate.query === "string"
  );
}

export async function listSavedViews(): Promise<SavedView[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isView) : [];
  } catch {
    return [];
  }
}

export async function saveView(view: SavedView): Promise<SavedView[]> {
  const existing = await listSavedViews();
  // Same name replaces rather than duplicating: saving "My overdue" twice should not give two chips.
  const next = [...existing.filter((item) => item.name.toLowerCase() !== view.name.toLowerCase()), view].slice(
    -MAX_VIEWS,
  );
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The chip still works for this session.
  }
  return next;
}

export async function removeSavedView(id: string): Promise<SavedView[]> {
  const next = (await listSavedViews()).filter((item) => item.id !== id);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}
