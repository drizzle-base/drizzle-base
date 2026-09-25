// "Did the result change?" — a push is sent only when it did. Object key order is not part of a result; array order,
// dates, bigints, bytes, map and set contents are. An unknown class instance cannot be compared safely: it hashes as
// always-changed (a push too many, never one too few).
let unique = 0;

export function stableHash(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (ArrayBuffer.isView(v)) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex") };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [normalize(k), normalize(x)]) };
  if (v instanceof Set) return { $set: [...v].map(normalize) };
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { $unknown: ++unique };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
