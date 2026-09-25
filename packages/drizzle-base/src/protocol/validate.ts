// Parsing an untrusted client frame. Anything malformed is refused with the frame's id when one could be read, so
// the client can fail the matching call.
import { decodeValue } from "./codec";
import { type ClientFrame, LIMITS } from "./frames";

export type ParsedFrame = { ok: true; frame: ClientFrame } | { ok: false; id?: string; message: string };

const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= LIMITS.id;
const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= LIMITS.name;
const isArgs = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

export function parseClientFrame(text: string): ParsedFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "not JSON" };
  }
  if (!isArgs(raw)) return { ok: false, message: "a frame is a JSON object" };
  const id = isId(raw["id"]) ? raw["id"] : undefined;
  const refuse = (message: string): ParsedFrame =>
    id === undefined ? { ok: false, message } : { ok: false, id, message };
  switch (raw["t"]) {
    case "ping":
      return { ok: true, frame: { t: "ping" } };
    case "unsub":
      return id === undefined ? refuse("a valid id is required") : { ok: true, frame: { t: "unsub", id } };
    case "sub":
    case "mut": {
      if (id === undefined) return refuse("a valid id is required");
      if (!isName(raw["name"])) return refuse(`a name of 1 to ${LIMITS.name} characters is required`);
      if (!isArgs(raw["args"])) return refuse("args must be an object");
      let args: Record<string, unknown>;
      try {
        args = decodeValue(raw["args"]) as Record<string, unknown>;
      } catch (e) {
        return refuse(e instanceof Error ? e.message : "args could not be decoded");
      }
      return { ok: true, frame: { t: raw["t"], id, name: raw["name"], args } };
    }
    default:
      return refuse("unknown frame type");
  }
}
