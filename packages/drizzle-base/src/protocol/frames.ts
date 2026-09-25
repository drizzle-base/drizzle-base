// The frames of the drizzle-base wire protocol (JSON text frames; every frame has `t`). Values inside are encoded
// with codec.ts. See docs/superpowers/plans/2026-09-25-dzb-01a-4a-server.md for the semantics of each.

export type ClientFrame =
  | { t: "sub"; id: string; name: string; args: Record<string, unknown> }
  | { t: "unsub"; id: string }
  | { t: "mut"; id: string; name: string; args: Record<string, unknown> }
  | { t: "ping" };

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "invalid_args"
  | "too_many_subscriptions"
  | "too_busy"
  | "duplicate_id"
  | "unavailable"
  | "commit_unknown"
  | "app"
  | "internal";

export interface WireError {
  code: ErrorCode;
  message?: string;
  data?: unknown;
}

export type ServerFrame =
  // A subscription's first value: `c` is the cycle that settled a provisional value, null when it was current.
  | { t: "upd"; id: string; c: number | null; value?: unknown; error?: WireError }
  // Every change one flush cycle made for this connection, from one snapshot. `u` may be empty: a stamp that lets
  // a client resolve a mutation named for cycle ≤ c.
  | { t: "txn"; c: number; u: ({ id: string; value: unknown } | { id: string; error: WireError })[] }
  // A mutation's reply: `c` is the cycle whose completion carries the write; null when it committed but could not
  // be confirmed in the stream (the client resolves at once).
  | { t: "res"; id: string; c: number | null; value: unknown }
  | ({ t: "err"; id?: string } & WireError)
  | { t: "reset" }
  | { t: "pong" };

export const LIMITS = { id: 64, name: 200 } as const;
