// Postgres's text output for the kinds the contract carries as strings (TimeZone=UTC, DateStyle=ISO).

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function fraction(ms: number, micros: number): string {
  const us = ms * 1000 + micros;
  return us === 0 ? "" : `.${String(us).padStart(6, "0").replace(/0+$/, "")}`;
}

export function pgDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `micros` adds the sub-millisecond digits a JS Date cannot hold (0–999). */
export function pgTimestamp(d: Date, micros = 0): string {
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${pgDate(d)} ${time}${fraction(d.getUTCMilliseconds(), micros)}`;
}

export function pgTimestamptz(d: Date, micros = 0): string {
  return `${pgTimestamp(d, micros)}+00`;
}

export function pgBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
