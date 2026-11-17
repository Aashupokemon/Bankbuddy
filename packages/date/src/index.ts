/**
 * The single date/time service for the project.
 *
 * Rules encoded here (from the specification §8):
 *  - a due value is either a date-only value or a full instant, never a guess;
 *  - date-only values never silently become midnight *or* end-of-business — they keep their
 *    precision flag and are rendered without a time;
 *  - wall-clock input is resolved in the branch timezone, and DST gaps/overlaps are reported
 *    instead of being silently coerced;
 *  - nothing here reads the machine's local timezone.
 */

export type DuePrecision = "date" | "datetime";

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ResolvedWallTime {
  instant: Date | null;
  /** The wall time occurs twice (clocks went back): the earlier instant is returned. */
  ambiguous: boolean;
  /** The wall time never occurs (clocks went forward). */
  nonexistent: boolean;
}

export interface DueResolution {
  dueAt: Date | null;
  precision: DuePrecision | null;
  warnings: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function wallTimeOf(instant: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Unable to format ${type} for ${timeZone}`);
    return Number(part.value);
  };
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` at `instant`, in milliseconds east of UTC. */
export function offsetMsAt(instant: Date, timeZone: string): number {
  const wall = wallTimeOf(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Converts a wall-clock time in `timeZone` into an instant, reporting DST edge cases rather than
 * picking one silently.
 */
export function resolveWallTime(wall: WallTime, timeZone: string): ResolvedWallTime {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const offsets = new Set<number>();
  for (const delta of [0, 12 * 60 * 60_000, -12 * 60 * 60_000, 36 * 60 * 60_000, -36 * 60 * 60_000]) {
    offsets.add(offsetMsAt(new Date(guess + delta), timeZone));
  }

  const candidates = new Set<number>();
  for (const offset of offsets) {
    const t = guess - offset;
    if (sameWall(wallTimeOf(new Date(t), timeZone), wall)) candidates.add(t);
  }

  const sorted = [...candidates].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) {
    return { instant: null, ambiguous: false, nonexistent: true };
  }
  return { instant: new Date(first), ambiguous: sorted.length > 1, nonexistent: false };
}

export function wallTimeFromIsoDate(datePart: string): WallTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** Start of the calendar day containing `datePart` (`YYYY-MM-DD`) in `timeZone`. */
export function startOfDay(datePart: string, timeZone: string): Date | null {
  const wall = wallTimeFromIsoDate(datePart);
  if (!wall) return null;
  return resolveWallTime(wall, timeZone).instant;
}

/** The last millisecond of the calendar day containing `datePart` in `timeZone`. */
export function endOfDay(datePart: string, timeZone: string): Date | null {
  const start = startOfDay(datePart, timeZone);
  if (!start) return null;
  const wall = wallTimeOf(start, timeZone);
  const next = resolveWallTime({ ...wall, day: wall.day + 1 }, timeZone).instant;
  if (!next) return null;
  return new Date(next.getTime() - 1);
}

export function toIsoDate(instant: Date, timeZone: string): string {
  const wall = wallTimeOf(instant, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function addDays(instant: Date, days: number, timeZone: string): Date {
  const wall = wallTimeOf(instant, timeZone);
  const shifted = Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute, wall.second);
  const resolved = resolveWallTime({ ...wall, day: wall.day + days }, timeZone);
  return resolved.instant ?? new Date(shifted);
}

function nextWeekday(now: Date, timeZone: string, weekday: number, forceNextWeek: boolean): Date {
  const today = wallTimeOf(now, timeZone);
  const todayIndex = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const upcoming = (weekday - todayIndex + 7) % 7;
  // "next Thursday" means Thursday of next week, not the next Thursday to arrive.
  const delta = forceNextWeek ? (upcoming === 0 ? 7 : upcoming + 7) : upcoming;
  return addDays(now, delta, timeZone);
}

/**
 * Understands the phrasings the specification's examples use. Returns `null` when the text is not a
 * recognisable due date, so the caller can ask instead of guessing.
 */
export function resolveDuePhrase(
  input: string,
  options: { timeZone: string; now?: Date },
): DueResolution | null {
  const timeZone = options.timeZone;
  const now = options.now ?? new Date();
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Full ISO instant, e.g. 2026-11-19T06:00:00Z or 2026-11-19T11:30:00+05:30
  const isoInstant = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:\d{2})$/i.exec(text);
  if (isoInstant) {
    const parsed = new Date(input.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return { dueAt: parsed, precision: "datetime", warnings: [] };
    }
    return null;
  }

  // Date only, e.g. 2026-11-19 — stays date-only.
  const dateOnly = startOfDay(text, timeZone);
  if (dateOnly) {
    return { dueAt: dateOnly, precision: "date", warnings: [] };
  }

  // Local date + time without an offset, e.g. 2026-11-19 15:30
  const localDateTime = /^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (localDateTime) {
    const wall = wallTimeFromIsoDate(localDateTime[1]!);
    if (!wall) return null;
    const resolved = resolveWallTime(
      { ...wall, hour: Number(localDateTime[2]), minute: Number(localDateTime[3]) },
      timeZone,
    );
    if (!resolved.instant) {
      return { dueAt: null, precision: "datetime", warnings: ["local_time_does_not_exist"] };
    }
    return {
      dueAt: resolved.instant,
      precision: "datetime",
      warnings: resolved.ambiguous ? ["ambiguous_local_time"] : [],
    };
  }

  const withTime = (date: Date, hour: number, minute: number): DueResolution => {
    const wall = wallTimeOf(date, timeZone);
    const resolved = resolveWallTime({ ...wall, hour, minute, second: 0 }, timeZone);
    if (!resolved.instant) return { dueAt: null, precision: "datetime", warnings: ["local_time_does_not_exist"] };
    return {
      dueAt: resolved.instant,
      precision: "datetime",
      warnings: resolved.ambiguous ? ["ambiguous_local_time"] : [],
    };
  };

  // A date-only answer is normalised to the start of that local day, so no caller ever has to
  // wonder whether "Thursday" means 09:15, 17:00 or midnight.
  const dayOnly = (instant: Date): DueResolution => {
    const wall = wallTimeOf(instant, timeZone);
    const midnight = resolveWallTime({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone).instant;
    return { dueAt: midnight ?? instant, precision: "date", warnings: [] };
  };

  if (text === "today") return dayOnly(now);
  if (text === "tomorrow") return dayOnly(addDays(now, 1, timeZone));
  if (text === "day after tomorrow" || text === "day after") {
    return dayOnly(addDays(now, 2, timeZone));
  }
  if (text === "eod" || text === "end of day" || text === "today eod") {
    return { ...withTime(now, 17, 0), warnings: ["eod_interpreted_as_1700"] };
  }

  const inDays = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(text);
  if (inDays) {
    const n = Number(inDays[1]);
    const days = inDays[2]!.startsWith("week") ? n * 7 : n;
    return dayOnly(addDays(now, days, timeZone));
  }

  const weekday = /^(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text);
  if (weekday) {
    const index = WEEKDAYS.indexOf(weekday[2] as (typeof WEEKDAYS)[number]);
    return dayOnly(nextWeekday(now, timeZone, index, Boolean(weekday[1])));
  }

  return null;
}

/** True when a task is past its deadline, honouring date-only precision (end of the local day). */
export function isOverdue(
  dueAt: Date,
  precision: DuePrecision,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  if (precision === "date") {
    const end = endOfDay(toIsoDate(dueAt, timeZone), timeZone);
    return end ? now.getTime() > end.getTime() : now.getTime() > dueAt.getTime();
  }
  return now.getTime() > dueAt.getTime();
}

/** The UTC bounds of "today" in a timezone, used by dashboard and reminder queries. */
export function dayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const today = toIsoDate(now, timeZone);
  const start = startOfDay(today, timeZone);
  const end = endOfDay(today, timeZone);
  if (!start || !end) {
    return { start: new Date(now.getTime() - DAY_MS), end: now };
  }
  return { start, end };
}
