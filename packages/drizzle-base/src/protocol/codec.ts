// Values on the wire. JSON loses what a Drizzle result often holds — a Date, a bigint, bytes — so those travel as
// tagged objects: { "$t": "date" | "bigint" | "bytes", "v": … }. An application object that itself has a `$t` key
// is wrapped as { "$t": "obj", "v": … }, so no value is ever mistaken for a tag. Anything JSON cannot carry
// faithfully (a class instance, a Map, a non-finite number, an invalid Date) is refused rather than sent as `{}` or
// `null`. Runs on the server and in the browser: no Node APIs.

export const MAX_DEPTH = 64;
// Keys that would reach an object's prototype once copied (a JSON `__proto__` is an own key until assigned).
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class EncodeError extends Error {
  override name = "EncodeError";
}
export class DecodeError extends Error {
  override name = "DecodeError";
}

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeValue(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new EncodeError(`value nested deeper than ${MAX_DEPTH}`);
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      if (!Number.isFinite(v)) throw new EncodeError(`${v} cannot be sent`);
      return v;
    case "bigint":
      return { $t: "bigint", v: v.toString() };
    case "object":
      break;
    default:
      throw new EncodeError(`a ${typeof v} cannot be sent`);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new EncodeError("an invalid Date cannot be sent");
    return { $t: "date", v: v.toISOString() };
  }
  if (v instanceof Uint8Array) return { $t: "bytes", v: toBase64(v) };
  if (Array.isArray(v)) return v.map((x) => encodeValue(x, depth + 1));
  if (!isPlain(v)) throw new EncodeError(`a ${v.constructor?.name ?? "non-plain"} object cannot be sent`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodeValue(x, depth + 1);
  return "$t" in out ? { $t: "obj", v: out } : out;
}

export function decodeValue(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new DecodeError(`value nested deeper than ${MAX_DEPTH}`);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, depth + 1));
  const o = v as Record<string, unknown>;
  if ("$t" in o) {
    const tag = o["$t"];
    const x = o["v"];
    if (tag === "date" && typeof x === "string") {
      const d = new Date(x);
      if (Number.isNaN(d.getTime())) throw new DecodeError("an invalid date");
      return d;
    }
    if (tag === "bigint" && typeof x === "string" && /^-?\d+$/.test(x)) return BigInt(x);
    if (tag === "bytes" && typeof x === "string") return fromBase64(x);
    if (tag === "obj" && x !== null && typeof x === "object" && !Array.isArray(x)) return decodeObject(x, depth);
    throw new DecodeError(`an unknown or malformed tag ${JSON.stringify(tag)}`);
  }
  return decodeObject(o, depth);
}

function decodeObject(o: object, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (FORBIDDEN_KEYS.has(k)) throw new DecodeError(`the key ${JSON.stringify(k)} is refused`);
    out[k] = decodeValue(x, depth + 1);
  }
  return out;
}
