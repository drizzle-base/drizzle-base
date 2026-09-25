import { describe, expect, test } from "bun:test";
import {
  canonicalPgTime,
  formatPgTime,
  instantOf,
  parsePgTime,
  shortcut,
  toUtc,
  withDay,
  withTime,
} from "../../src/lib/pgtime";

const p = (kind: "date" | "timestamp" | "timestamptz", text: string) => {
  const t = parsePgTime(kind, text);
  if (!t) throw new Error(`did not parse ${text}`);
  return t;
};

describe("parse and format", () => {
  test("Postgres's own output round-trips exactly", () => {
    for (const [kind, text] of [
      ["timestamptz", "2026-09-25 12:43:35.257072+00"],
      ["timestamptz", "2026-01-01 00:00:00+05:30"],
      ["timestamptz", "2026-01-01 00:00:00-03"],
      ["timestamptz", "0099-01-01 00:00:00+00"],
      ["timestamp", "2026-09-25 11:43:35.257072"],
      ["timestamp", "2026-09-25 11:43:35"],
      ["date", "1980-02-07"],
    ] as const) {
      expect(formatPgTime(p(kind, text))).toBe(text);
    }
  });

  test("accepts what Postgres accepts on input, and writes it as Postgres would", () => {
    expect(formatPgTime(p("timestamptz", "2026-09-25T12:43Z"))).toBe("2026-09-25 12:43:00+00");
    expect(formatPgTime(p("timestamptz", "2026-09-25 12:43:00.500-0330"))).toBe("2026-09-25 12:43:00.5-03:30");
    expect(formatPgTime(p("timestamptz", "2026-09-25"))).toBe("2026-09-25 00:00:00+00");
    expect(formatPgTime(p("timestamp", "2026-09-25 12:43"))).toBe("2026-09-25 12:43:00");
  });

  test("refuses what is not a real date or time of its kind", () => {
    expect(parsePgTime("date", "2026-02-30")).toBeNull();
    expect(parsePgTime("date", "2026-02-03 10:00")).toBeNull();
    expect(parsePgTime("timestamp", "2026-09-25 24:00:00")).toBeNull();
    expect(parsePgTime("timestamp", "2026-09-25 10:00:00+00")).toBeNull();
    expect(parsePgTime("timestamptz", "2026-09-25 10:00:00+16")).toBeNull();
    expect(parsePgTime("timestamptz", "now")).toBeNull();
  });
});

describe("editing by parts", () => {
  test("withDay keeps the time, the fraction and the offset", () => {
    const t = p("timestamptz", "2026-09-25 12:43:35.257072+00");
    expect(formatPgTime(withDay(t, 2026, 9, 10))).toBe("2026-09-10 12:43:35.257072+00");
    expect(formatPgTime(withDay(p("timestamp", "2026-09-25 11:43:35.5"), 2025, 1, 31))).toBe("2025-01-31 11:43:35.5");
  });

  test("withTime keeps the day, the other parts, the fraction and the offset", () => {
    const t = p("timestamptz", "2026-09-25 12:43:35.257072-03");
    expect(formatPgTime(withTime(t, "hour", 8))).toBe("2026-09-25 08:43:35.257072-03");
    expect(formatPgTime(withTime(t, "second", 0))).toBe("2026-09-25 12:43:00.257072-03");
  });
});

describe("instants", () => {
  test("toUtc moves the wall time by the offset, across days and centuries", () => {
    expect(formatPgTime(toUtc(p("timestamptz", "2026-01-01 00:30:00-03")))).toBe("2026-01-01 03:30:00+00");
    expect(formatPgTime(toUtc(p("timestamptz", "2026-01-01 01:00:00.5+02")))).toBe("2025-12-31 23:00:00.5+00");
    expect(formatPgTime(toUtc(p("timestamptz", "0099-12-31 23:00:00-02")))).toBe("0100-01-01 01:00:00+00");
  });

  test("the same instant in two offsets is equal; a fraction orders after the whole second", () => {
    expect(instantOf(p("timestamptz", "2026-01-01 10:00:00+02"))).toBe(
      instantOf(p("timestamptz", "2026-01-01 08:00:00+00")),
    );
    expect(instantOf(p("timestamptz", "2026-01-01 08:00:00.000001+00"))).toBeGreaterThan(
      instantOf(p("timestamptz", "2026-01-01 08:00:00+00")),
    );
  });

  test("canonicalPgTime is what a data source reads back", () => {
    expect(canonicalPgTime("timestamptz", "2026-01-01T00:30-03:00")).toBe("2026-01-01 03:30:00+00");
    expect(canonicalPgTime("timestamp", "2026-01-01T00:30:00.100")).toBe("2026-01-01 00:30:00.1");
    expect(canonicalPgTime("date", "2026-1-1")).toBeNull();
  });
});

describe("shortcuts, in the browser's time zone", () => {
  // 02:30:15.25 UTC on the 25th is 23:30:15.25 on the 24th in São Paulo (UTC-3).
  const now = new Date(Date.UTC(2026, 8, 25, 2, 30, 15, 250));
  const sp = -180;
  test("date: the local day", () => {
    expect(formatPgTime(shortcut("date", "today", now, sp))).toBe("2026-09-24");
    expect(formatPgTime(shortcut("date", "tomorrow", now, sp))).toBe("2026-09-25");
    expect(formatPgTime(shortcut("date", "yesterday", now, sp))).toBe("2026-09-23");
    expect(formatPgTime(shortcut("date", "now", now, sp))).toBe("2026-09-24");
  });
  test("timestamptz: the local wall time with its offset; days start at local midnight", () => {
    expect(formatPgTime(shortcut("timestamptz", "now", now, sp))).toBe("2026-09-24 23:30:15.25-03");
    expect(formatPgTime(shortcut("timestamptz", "today", now, sp))).toBe("2026-09-24 00:00:00-03");
    expect(formatPgTime(shortcut("timestamptz", "tomorrow", now, 330))).toBe("2026-09-26 00:00:00+05:30");
  });
  test("timestamp: the local wall time, no offset", () => {
    expect(formatPgTime(shortcut("timestamp", "now", now, sp))).toBe("2026-09-24 23:30:15.25");
  });
});
