import { expect, test } from "bun:test";
import { mulberry32, uuidv7 } from "../../src/mock/ids";
import { pgBytea, pgDate, pgTimestamp, pgTimestamptz } from "../../src/mock/pgtext";

test("timestamps print as Postgres prints them: trailing fraction zeros dropped", () => {
  const d = new Date(Date.UTC(2026, 8, 25, 12, 43, 35, 257));
  expect(pgTimestamptz(d, 72)).toBe("2026-09-25 12:43:35.257072+00");
  expect(pgTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 250)))).toBe("2026-01-01 00:00:00.25");
  expect(pgTimestamptz(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01 00:00:00+00");
});

test("dates pad the year; bytea is hex with a \\x prefix", () => {
  expect(pgDate(new Date(Date.UTC(987, 1, 3)))).toBe("0987-02-03");
  expect(pgBytea(new TextEncoder().encode("id"))).toBe("\\x6964");
});

test("the seeded generator is deterministic and uuidv7 has the v7 shape", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = [a(), a(), a()];
  expect([b(), b(), b()]).toEqual(xs);
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  expect(mulberry32(43)()).not.toBe(xs[0]);
  const id = uuidv7(Date.UTC(2026, 0, 1), mulberry32(1));
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(id.startsWith(Date.UTC(2026, 0, 1).toString(16).padStart(12, "0").slice(0, 8))).toBe(true);
});
