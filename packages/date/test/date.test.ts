import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  dayBounds,
  endOfDay,
  isOverdue,
  offsetMsAt,
  resolveDuePhrase,
  resolveWallTime,
  startOfDay,
  toIsoDate,
  wallTimeOf,
} from "../src/index.ts";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

test("kolkata has a fixed +05:30 offset", () => {
  const instant = new Date("2026-11-19T06:00:00Z");
  assert.equal(offsetMsAt(instant, KOLKATA), 5.5 * 60 * 60 * 1000);
  assert.deepEqual(wallTimeOf(instant, KOLKATA), {
    year: 2026,
    month: 11,
    day: 19,
    hour: 11,
    minute: 30,
    second: 0,
  });
});

test("date-only input stays date-only and resolves to local start of day", () => {
  const resolved = resolveDuePhrase("2026-11-19", { timeZone: KOLKATA, now: new Date("2026-11-17T04:00:00Z") });
  assert.ok(resolved);
  assert.equal(resolved.precision, "date");
  // 00:00 in Kolkata on 19 Nov is 18:30 UTC on 18 Nov.
  assert.equal(resolved.dueAt?.toISOString(), "2026-11-18T18:30:00.000Z");
});

test("a full ISO instant is preserved exactly", () => {
  const resolved = resolveDuePhrase("2026-11-19T06:00:00Z", { timeZone: KOLKATA });
  assert.ok(resolved);
  assert.equal(resolved.precision, "datetime");
  assert.equal(resolved.dueAt?.toISOString(), "2026-11-19T06:00:00.000Z");
});

test("tomorrow is one calendar day ahead in the branch timezone", () => {
  const now = new Date("2026-11-17T20:00:00Z"); // 01:30 on 18 Nov in Kolkata
  const resolved = resolveDuePhrase("tomorrow", { timeZone: KOLKATA, now });
  assert.ok(resolved);
  assert.equal(resolved.precision, "date");
  assert.equal(toIsoDate(resolved.dueAt!, KOLKATA), "2026-11-19");
});

test("weekday phrases resolve to the next occurrence in the branch timezone", () => {
  const now = new Date("2026-11-17T04:00:00Z"); // Tuesday 09:30 in Kolkata
  const thursday = resolveDuePhrase("thursday", { timeZone: KOLKATA, now });
  assert.ok(thursday);
  assert.equal(toIsoDate(thursday.dueAt!, KOLKATA), "2026-11-19");
  // Date-only results are normalised to local midnight, never the time the sentence was typed.
  assert.equal(thursday.dueAt?.toISOString(), "2026-11-18T18:30:00.000Z");

  const nextThursday = resolveDuePhrase("next thursday", { timeZone: KOLKATA, now });
  assert.ok(nextThursday);
  assert.equal(toIsoDate(nextThursday.dueAt!, KOLKATA), "2026-11-26");
});

test("in 3 days and in 2 weeks", () => {
  const now = new Date("2026-11-17T04:00:00Z");
  const three = resolveDuePhrase("in 3 days", { timeZone: KOLKATA, now });
  assert.equal(toIsoDate(three!.dueAt!, KOLKATA), "2026-11-20");
  const fortnight = resolveDuePhrase("in 2 weeks", { timeZone: KOLKATA, now });
  assert.equal(toIsoDate(fortnight!.dueAt!, KOLKATA), "2026-12-01");
});

test("DST spring-forward gap is reported, not silently coerced", () => {
  // 2 March 2026 02:30 does not exist in New York.
  const resolved = resolveWallTime(
    { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
    NEW_YORK,
  );
  assert.equal(resolved.instant, null);
  assert.equal(resolved.nonexistent, true);
});

test("DST fall-back overlap is reported as ambiguous", () => {
  const resolved = resolveWallTime(
    { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
    NEW_YORK,
  );
  assert.ok(resolved.instant);
  assert.equal(resolved.ambiguous, true);
  // Earlier of the two 01:30s is EDT (-04:00).
  assert.equal(resolved.instant?.toISOString(), "2026-11-01T05:30:00.000Z");
});

test("end of day is the last millisecond of the local day", () => {
  const end = endOfDay("2026-11-19", KOLKATA);
  assert.ok(end);
  assert.equal(end.toISOString(), "2026-11-19T18:29:59.999Z");
});

test("date-only due values are overdue only after the local day ends", () => {
  const dueAt = startOfDay("2026-11-19", KOLKATA)!;
  assert.equal(isOverdue(dueAt, "date", KOLKATA, new Date("2026-11-19T18:00:00Z")), false);
  assert.equal(isOverdue(dueAt, "date", KOLKATA, new Date("2026-11-19T18:30:00Z")), true);
});

test("datetime due values are overdue at the instant", () => {
  const dueAt = new Date("2026-11-19T06:00:00Z");
  assert.equal(isOverdue(dueAt, "datetime", KOLKATA, new Date("2026-11-19T05:59:59Z")), false);
  assert.equal(isOverdue(dueAt, "datetime", KOLKATA, new Date("2026-11-19T06:00:01Z")), true);
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(toIsoDate(addDays(new Date("2026-12-30T04:00:00Z"), 3, KOLKATA), KOLKATA), "2027-01-02");
});

test("dayBounds covers exactly one local day", () => {
  const bounds = dayBounds(new Date("2026-11-19T06:00:00Z"), KOLKATA);
  assert.equal(bounds.start.toISOString(), "2026-11-18T18:30:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-11-19T18:29:59.999Z");
});

test("unrecognised text returns null so the caller asks instead of guessing", () => {
  assert.equal(resolveDuePhrase("sometime next weekish", { timeZone: KOLKATA }), null);
  assert.equal(resolveDuePhrase("", { timeZone: KOLKATA }), null);
});

test("eod is explicit but flagged as an interpretation", () => {
  const resolved = resolveDuePhrase("eod", { timeZone: KOLKATA, now: new Date("2026-11-17T04:00:00Z") });
  assert.ok(resolved);
  assert.equal(resolved.precision, "datetime");
  assert.deepEqual(resolved.warnings, ["eod_interpreted_as_1700"]);
  assert.equal(toIsoDate(resolved.dueAt!, KOLKATA), "2026-11-17");
});
