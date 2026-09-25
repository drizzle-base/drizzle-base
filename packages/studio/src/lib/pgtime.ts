import type { ColumnKind } from "../contract";

// Postgres's date/time text (DateStyle=ISO), edited by parts. A JS Date cannot hold microseconds nor an offset, so
// values are never round-tripped through one: parts are replaced and the rest is written back as it was.

export type TimeKind = "date" | "timestamp" | "timestamptz";

export interface PgTime {
  kind: TimeKind;
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Digits of the fraction of a second, 0–6 of them, trailing zeros dropped (as Postgres prints them). */
  fraction: string;
  /** Minutes east of UTC; timestamptz only. Text without one is in the data source's zone, which is UTC. */
  offset: number | null;
}

export type Shortcut = "now" | "today" | "tomorrow" | "yesterday";

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const MAX_OFFSET = 15 * 60 + 59;
const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export const isTimeKind = (kind: ColumnKind): kind is TimeKind =>
  kind === "date" || kind === "timestamp" || kind === "timestamptz";

function parseOffset(text: string | undefined): number {
  if (text === undefined || text === "Z") return 0;
  const sign = text.startsWith("-") ? -1 : 1;
  const digits = text.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
}

/** A Date on the UTC calendar; setUTCFullYear because Date.UTC reads years 0–99 as 1900–1999. */
function utcDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

function fromUtcDate(kind: TimeKind, d: Date, fraction: string, offset: number | null): PgTime {
  return {
    kind,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    fraction,
    offset,
  };
}

export function parsePgTime(kind: TimeKind, text: string): PgTime | null {
  const m = RE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, frac, off] = m;
  if (kind === "date" && (hh !== undefined || off !== undefined)) return null;
  if (kind === "timestamp" && off !== undefined) return null;
  const t: PgTime = {
    kind,
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(hh ?? 0),
    minute: Number(mi ?? 0),
    second: Number(ss ?? 0),
    fraction: (frac ?? "").replace(/0+$/, ""),
    offset: kind === "timestamptz" ? parseOffset(off) : null,
  };
  const check = utcDate(t.year, t.month, t.day);
  if (check.getUTCFullYear() !== t.year || check.getUTCMonth() !== t.month - 1 || check.getUTCDate() !== t.day) {
    return null;
  }
  if (t.hour > 23 || t.minute > 59 || t.second > 59) return null;
  if (t.offset !== null && Math.abs(t.offset) > MAX_OFFSET) return null;
  return t;
}

function formatOffset(minutes: number): string {
  const a = Math.abs(minutes);
  const rest = a % 60;
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}${rest ? `:${pad(rest)}` : ""}`;
}

export function formatPgTime(t: PgTime): string {
  const date = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
  if (t.kind === "date") return date;
  const time = `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${t.fraction ? `.${t.fraction}` : ""}`;
  return t.kind === "timestamp" ? `${date} ${time}` : `${date} ${time}${formatOffset(t.offset ?? 0)}`;
}

const wallMillis = (t: PgTime): number => utcDate(t.year, t.month, t.day, t.hour, t.minute, t.second).getTime();

/** The same instant at offset 0 (what a data source running with TimeZone=UTC prints). */
export function toUtc(t: PgTime): PgTime {
  if (t.kind !== "timestamptz") return t;
  return fromUtcDate("timestamptz", new Date(wallMillis(t) - (t.offset ?? 0) * 60_000), t.fraction, 0);
}

/** Microseconds since the epoch: the instant for timestamptz, the wall time for date and timestamp. */
export function instantOf(t: PgTime): number {
  const utc = toUtc(t);
  return wallMillis(utc) * 1000 + Number(utc.fraction.padEnd(6, "0"));
}

/** The text a data source reads back for `text`, or null when it is not a value of that kind. */
export function canonicalPgTime(kind: TimeKind, text: string): string | null {
  const t = parsePgTime(kind, text);
  return t ? formatPgTime(toUtc(t)) : null;
}

export const withDay = (t: PgTime, year: number, month: number, day: number): PgTime => ({ ...t, year, month, day });

export const withTime = (t: PgTime, part: "hour" | "minute" | "second", value: number): PgTime => ({
  ...t,
  [part]: value,
});

/** Minutes east of UTC in the browser's zone at `now` (getTimezoneOffset counts the other way). */
export const browserOffset = (now: Date): number => -now.getTimezoneOffset();

const SHIFT: Record<Shortcut, number> = { now: 0, today: 0, tomorrow: 1, yesterday: -1 };

/** A shortcut resolved on the client, in the zone `offset` names: `now` is this instant, the others midnight. */
export function shortcut(kind: TimeKind, name: Shortcut, now: Date, offset: number): PgTime {
  const wall = new Date(now.getTime() + offset * 60_000);
  const zone = kind === "timestamptz" ? offset : null;
  if (name === "now") {
    return fromUtcDate(kind, wall, pad(wall.getUTCMilliseconds(), 3).replace(/0+$/, ""), zone);
  }
  const day = utcDate(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate() + SHIFT[name]);
  return fromUtcDate(kind, day, "", zone);
}
