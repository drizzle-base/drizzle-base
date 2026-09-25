// The WebSocket side of drizzle-base: named queries become subscriptions on the engine, named mutations go through
// it, and every flush cycle reaches a connection as ONE `txn` frame. Quarried from minivex's server (its per-cycle
// transaction buffer, close-on-dropped-push, limits), rebuilt on this engine's totally ordered cycles, which make
// minivex's stamp machine unnecessary: a mutation's reply names a cycle, and the connection is sent a `txn` with a
// cycle at or after it — an empty one when that cycle changed nothing it watches.
//
// Bun only (`server.upgrade`, `ServerWebSocket`). Usage:
//   const dzb = createHandler({ engine, api });
//   Bun.serve({ fetch: (req, server) => dzb.upgrade(req, server) ?? new Response("…"), websocket: dzb.websocket });
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { encodeValue, parseClientFrame, type ServerFrame, type WireError } from "../protocol";
import { type MutationDef, type QueryDef, type StandardResult, validateArgs } from "../runtime";
import { CommittedUnconfirmedError, type EngineEvent, type SubscriptionEngine } from "../subscriptions";
import { type AnyDef, type ApiTree, registryOf } from "./api";
import { logInternal, toWireError } from "./errors";

export interface HandlerOptions<S extends Record<string, unknown>> {
  engine: SubscriptionEngine<S>;
  api: ApiTree;
  // Default: loopback origins and requests without an Origin (non-browser clients). Any website a developer
  // visits could otherwise open ws://127.0.0.1:<port> and call functions ("*" allows every origin, explicitly).
  allowedOrigins?: readonly string[] | "*";
  maxSubscriptions?: number; // per connection, pending ones included (default 1000)
  maxInFlight?: number; // subscribes being opened + mutations running, per connection (default 16)
  maxConcurrentCalls?: number; // server-wide, so one client cannot take the pool from the engine (default 8)
  maxPayloadLength?: number; // bytes (default 1 MiB)
  backpressureLimit?: number; // bytes (default 8 MiB)
  idleTimeout?: number; // seconds (default 60)
}

// A subscription on one connection. Its identity (the object) is what a late open or listener checks against the
// connection's map: an unsubscribe, a reset or a re-used id replaces or removes it.
interface Sub {
  off?: () => void;
  sentFirst: boolean; // the first value went out as `upd`; later ones go through the cycle's buffer
  wasHeld: boolean; // its first value was provisional and is waiting for the engine to settle it
}

export interface Conn {
  subs: Map<string, Sub>;
  buffer: Map<string, { id: string; value: unknown } | { id: string; error: WireError }>;
  pendingMuts: number[]; // named cycles still waiting for a `txn` at or after them
  inFlight: number;
  closed: boolean;
  ws?: ServerWebSocket<Conn>;
}

// A push the socket dropped would leave the client stale forever — the engine already counts the value as
// delivered — so a dropped frame closes the connection instead (quarried from minivex's pushOrClose). -1 means
// queued under backpressure (Bun closes on the limit itself), 0 means dropped.
export function pushOrClose(ws: Pick<ServerWebSocket<unknown>, "send" | "close">, frame: ServerFrame): void {
  if (ws.send(JSON.stringify(frame)) === 0) ws.close(1013, "backpressure");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
// No Origin header: not a browser (a browser always sends one on a WebSocket upgrade), so no ambient authority to
// abuse — admitted under every setting.
function originAllowed(origin: string | null, allowed: readonly string[] | "*" | undefined): boolean {
  if (allowed === "*" || origin === null) return true;
  if (allowed) return allowed.includes(origin);
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

export function createHandler<S extends Record<string, unknown>>(opts: HandlerOptions<S>) {
  const { engine } = opts;
  const registry = registryOf(opts.api);
  const maxSubscriptions = opts.maxSubscriptions ?? 1000;
  const maxInFlight = opts.maxInFlight ?? 16;
  const calls = new Semaphore(opts.maxConcurrentCalls ?? 8);
  const touched = new Set<Conn>(); // connections with buffered changes in the current cycle
  const waitingStamp = new Set<Conn>(); // connections with pending mutations
  const conns = new Set<Conn>();
  let pendingCalls = 0; // subscribes being opened and mutations running, across connections (closed ones too)

  const send = (conn: Conn, frame: ServerFrame) => {
    if (!conn.closed && conn.ws) pushOrClose(conn.ws, frame);
  };

  const encodeEvent = (
    e: Extract<EngineEvent<unknown>, { kind: "value" | "error" }>,
    where: { fn: string; frame: string },
  ): { value: unknown } | { error: WireError } => {
    if (e.kind === "error") {
      const error = toWireError(e.error);
      if (error.code === "internal") logInternal(e.error, where);
      return { error };
    }
    try {
      return { value: encodeValue(e.value) };
    } catch (x) {
      logInternal(x, where);
      return { error: { code: "internal" } };
    }
  };

  // The engine said its registered results can no longer be trusted: every subscription of every connection is
  // gone. The client re-subscribes; its pending mutations resolve (they committed, and a fresh subscription is
  // taken after them).
  const onReset = (conn: Conn) => {
    if (!conn.subs.size && !conn.pendingMuts.length) return;
    conn.subs.clear();
    conn.buffer.clear();
    conn.pendingMuts = [];
    touched.delete(conn);
    waitingStamp.delete(conn);
    send(conn, { t: "reset" });
  };

  const offReset = engine.onReset(() => {
    for (const conn of conns) onReset(conn);
  });

  const offCycle = engine.onCycleComplete((c) => {
    for (const conn of touched) {
      if (conn.closed || !conn.buffer.size) continue;
      const u = [...conn.buffer.values()];
      conn.buffer.clear();
      send(conn, { t: "txn", c, u });
      if (conn.pendingMuts.length) stamp(conn, c, false);
    }
    touched.clear();
    for (const conn of [...waitingStamp]) stamp(conn, c, true);
  });

  // Every pending mutation named for a cycle ≤ c is carried by a frame with cycle c: compared with ≥, never ===,
  // because a failed cycle is retried whole under a new id and the named one may never complete.
  function stamp(conn: Conn, c: number, needFrame: boolean): void {
    const due = conn.pendingMuts.filter((m) => m <= c);
    if (!due.length) return;
    conn.pendingMuts = conn.pendingMuts.filter((m) => m > c);
    if (!conn.pendingMuts.length) waitingStamp.delete(conn);
    if (needFrame) send(conn, { t: "txn", c, u: [] });
  }

  async function checkArgs(def: AnyDef, raw: Record<string, unknown>) {
    return validateArgs(
      def as {
        args?: { "~standard": { version: 1; vendor: string; validate: (v: unknown) => StandardResult<unknown> } };
      },
      raw,
    );
  }

  async function subscribe(conn: Conn, id: string, name: string, raw: Record<string, unknown>) {
    const def = registry.get(name);
    if (conn.subs.has(id)) return send(conn, { t: "err", id, code: "duplicate_id" });
    if (def?.kind !== "query") return send(conn, { t: "err", id, code: "not_found" });
    if (conn.subs.size >= maxSubscriptions) return send(conn, { t: "err", id, code: "too_many_subscriptions" });
    if (conn.inFlight >= maxInFlight) return send(conn, { t: "err", id, code: "too_busy" });
    const sub: Sub = { sentFirst: false, wasHeld: false };
    conn.subs.set(id, sub);
    const current = () => !conn.closed && conn.subs.get(id) === sub;
    conn.inFlight++;
    pendingCalls++;
    await calls.acquire();
    try {
      if (!current()) return; // unsubscribed or closed while it waited for a slot: nobody wants it
      const checked = await checkArgs(def, raw);
      if (!checked.ok) {
        if (current()) conn.subs.delete(id);
        return send(conn, { t: "err", id, code: "invalid_args", message: checked.issues.join("; ") });
      }
      const where = { fn: name, frame: id };
      const off = await engine.subscribe(name, def as unknown as QueryDef<S, unknown, unknown>, checked.value, (e) => {
        if (!current()) return;
        if (e.kind === "reset") return onReset(conn);
        if (!sub.sentFirst) {
          // A provisional first value is older than commits the engine applied — possibly the client's own write
          // — so it is held until the engine settles it (01a-4a review I1). The first value that goes out is
          // always sent at once, whatever its cycle (review C1).
          if (e.provisional) {
            sub.wasHeld = true;
            return;
          }
          sub.sentFirst = true;
          // `c`: the cycle that settled a held value; null for a value that was current when it went out.
          return send(conn, { t: "upd", id, c: sub.wasHeld ? e.cycle : null, ...encodeEvent(e, where) });
        }
        conn.buffer.set(id, { id, ...encodeEvent(e, where) });
        touched.add(conn);
      });
      // Closed or unsubscribed while it was opening: let it go at once (review I2).
      if (current()) sub.off = off;
      else off();
    } catch (e) {
      if (current()) conn.subs.delete(id);
      const error = toWireError(e);
      if (error.code === "internal") logInternal(e, { fn: name, frame: id });
      send(conn, { t: "err", id, ...error });
    } finally {
      conn.inFlight--;
      pendingCalls--;
      calls.release();
    }
  }

  async function mutate(conn: Conn, id: string, name: string, raw: Record<string, unknown>) {
    const def = registry.get(name);
    if (def?.kind !== "mutation") return send(conn, { t: "err", id, code: "not_found" });
    if (conn.inFlight >= maxInFlight) return send(conn, { t: "err", id, code: "too_busy" });
    conn.inFlight++;
    pendingCalls++;
    await calls.acquire();
    try {
      // The socket left while this waited for a slot: its client already failed the call ("connection lost"), so
      // running it now would write something the client believes never happened.
      if (conn.closed) return;
      const checked = await checkArgs(def, raw);
      if (!checked.ok) return send(conn, { t: "err", id, code: "invalid_args", message: checked.issues.join("; ") });
      const r = await engine.mutate(def as unknown as MutationDef<S, unknown, unknown>, checked.value, {
        encode: encodeValue,
      });
      if (conn.closed) return; // committed; the reply has nowhere to go, and it is never replayed
      // No await between mutate returning and this reply: the named cycle has not started yet (the engine names
      // `started + 1`), so the reply always precedes the `txn` that carries it.
      conn.pendingMuts.push(r.cycle);
      waitingStamp.add(conn);
      send(conn, { t: "res", id, c: r.cycle, value: r.encoded });
    } catch (e) {
      if (e instanceof CommittedUnconfirmedError) {
        // It committed; its effect could not be confirmed in the stream. The client resolves at once.
        let value: unknown = null;
        try {
          value = encodeValue(e.value); // it was encodable before COMMIT; never let a surprise escape
        } catch {}
        return send(conn, { t: "res", id, c: null, value });
      }
      const error = toWireError(e);
      if (error.code === "internal") logInternal(e, { fn: name, frame: id });
      send(conn, { t: "err", id, ...error });
    } finally {
      conn.inFlight--;
      pendingCalls--;
      calls.release();
    }
  }

  const websocket: WebSocketHandler<Conn> = {
    maxPayloadLength: opts.maxPayloadLength ?? 1024 * 1024,
    backpressureLimit: opts.backpressureLimit ?? 8 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: opts.idleTimeout ?? 60,
    open(ws) {
      ws.data.ws = ws;
      conns.add(ws.data);
    },
    message(ws, message) {
      const conn = ws.data;
      const parsed = parseClientFrame(typeof message === "string" ? message : new TextDecoder().decode(message));
      if (!parsed.ok) {
        const frame: ServerFrame = { t: "err", code: "bad_request", message: parsed.message };
        return send(conn, parsed.id === undefined ? frame : { ...frame, id: parsed.id });
      }
      const f = parsed.frame;
      switch (f.t) {
        case "ping":
          return send(conn, { t: "pong" });
        case "unsub": {
          const sub = conn.subs.get(f.id);
          conn.subs.delete(f.id);
          conn.buffer.delete(f.id);
          sub?.off?.(); // a pending one is let go when its open resolves
          return;
        }
        case "sub":
          return void subscribe(conn, f.id, f.name, f.args);
        case "mut":
          return void mutate(conn, f.id, f.name, f.args);
      }
    },
    close(ws) {
      const conn = ws.data;
      conn.closed = true;
      for (const sub of conn.subs.values()) sub.off?.();
      conn.subs.clear();
      conn.buffer.clear();
      touched.delete(conn);
      waitingStamp.delete(conn);
      conns.delete(conn);
    },
  };

  return {
    websocket,
    // undefined: upgraded. A Response: refused (the caller returns it).
    upgrade(req: Request, server: Server<Conn>): Response | undefined {
      if (!originAllowed(req.headers.get("origin"), opts.allowedOrigins))
        return new Response("origin not allowed", { status: 403 });
      const conn: Conn = { subs: new Map(), buffer: new Map(), pendingMuts: [], inFlight: 0, closed: false };
      return server.upgrade(req, { data: conn })
        ? undefined
        : new Response("expected a WebSocket upgrade", { status: 400 });
    },
    get connections(): number {
      return conns.size;
    },
    get pendingCalls(): number {
      return pendingCalls;
    },
    close(): void {
      offCycle();
      offReset();
      for (const conn of conns) conn.ws?.close(1001, "server stopping");
    },
  };
}
