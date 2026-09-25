// The subscription engine: keeps every subscribed query's value current.
//
// Stream side (onEvent, synchronous): a committed transaction's table projection is appended to the buffer, then
// applied to the index (rule B; DDL dirties everything). Cycle side (async, one at a time, while anything is
// dirty): export S; a barrier (every commit visible in S applied); re-run the dirty entries whose current value S
// contains, in S (P-M10); re-register with S (the replay re-dirties what S missed); push the changed values as one
// batch; tell cycle listeners the cycle completed; prune. Entries S does not contain wait for the next cycle, so no
// subscriber ever goes back in time. The catalog is resolved per run, never cached across runs: a lookup made under
// one snapshot can never be served to a run under another (the plan review's A3 class, removed rather than patched).
import type { SQL } from "bun";
import { emitBarrier, lsnToBigInt, type StreamEvent } from "../capture";
import {
  isTransient,
  type MutationDef,
  parseSnapshot,
  type QueryDef,
  type Runtime,
  type SnapshotCall,
} from "../runtime";
import { project, RecentCommits } from "./buffer";
import { Registry } from "./registry";
import { stableHash } from "./stable";
import { contains, low32, type Visibility, visibilityOf } from "./xid";

export type EngineEvent<R> =
  | { kind: "value"; cycle: number | null; value: R }
  | { kind: "error"; cycle: number | null; error: unknown }
  | { kind: "reset"; reason: string };

export interface EngineStats {
  cycles: number;
  failedCycles: number;
  reruns: number;
  uselessReruns: number; // re-run, same result: the cost of table-level invalidation (the number 01b must lower)
  transientReruns: number;
  pushes: number;
}

export class EngineDownError extends Error {
  override name = "EngineDownError";
  constructor(reason = "the change stream is down; subscribe again after resume()") {
    super(reason);
  }
}

export class CommittedUnconfirmedError extends Error {
  override name = "CommittedUnconfirmedError";
  constructor(
    readonly commitLsn: string,
    readonly value: unknown,
    cause: unknown,
  ) {
    super("the mutation COMMITTED, but its effect could not be confirmed in the change stream", { cause });
  }
}

type Listener = (e: EngineEvent<unknown>) => void;

interface CacheEntry<S extends Record<string, unknown>> {
  key: string; // may change once: a shared entry whose re-run turns volatile is re-keyed to a private key
  run: SnapshotCall<S>;
  shareable: boolean;
  hash: string;
  last: EngineEvent<unknown>;
  visibility: Visibility; // the snapshot the subscribers' current value comes from
  listeners: Set<Listener>;
  transientTries: number;
}

const TRANSIENT_TRIES = 5;

function deliver(l: (e: never) => void, e: unknown): void {
  try {
    (l as (x: unknown) => void)(e);
  } catch {
    // one subscriber's failure (a closed socket) must not keep the value from the others
  }
}

export class SubscriptionEngine<S extends Record<string, unknown>> {
  readonly stats: EngineStats = {
    cycles: 0,
    failedCycles: 0,
    reruns: 0,
    uselessReruns: 0,
    transientReruns: 0,
    pushes: 0,
  };
  private readonly buffer = new RecentCommits();
  private readonly registry = new Registry<string>();
  private readonly entries = new Map<string, CacheEntry<S>>();
  private readonly pending = new Map<string, Promise<CacheEntry<S>>>();
  private readonly barriers = new Map<
    string,
    { expected?: bigint; seen?: bigint; resolve: () => void; reject: (e: unknown) => void }
  >();
  private readonly inflight = new Set<number>(); // tickets of fresh queries not registered yet (start order)
  private readonly cycleListeners = new Set<(id: number) => void>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private ticket = 0;
  private started = 0;
  private generation = 0;
  private down = false;
  private closed = false;
  private running = false;
  private forced = false;
  private failures = 0;
  private uniq = 0;
  private cycleWaiters: { after: number; resolve: (id: number) => void; reject: (e: unknown) => void }[] = [];
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly opts: {
      runtime: Runtime<S>;
      sql: SQL;
      connections?: number;
      barrierTimeoutMs?: number;
      pruneEveryMs?: number;
      onError?: (e: unknown) => void;
    },
  ) {
    this.pruneTimer = setInterval(
      () => void this.pruneNow().catch((e) => this.opts.onError?.(e)),
      opts.pruneEveryMs ?? 1_000,
    );
  }

  get bufferSize(): number {
    return this.buffer.size;
  }

  // Every completed cycle, whether or not it pushed anything to a given subscriber: a client waiting for "a
  // transition at or after cycle N" (read-your-writes) needs to hear about cycles that changed none of its queries.
  onCycleComplete(listener: (id: number) => void): () => void {
    this.cycleListeners.add(listener);
    return () => this.cycleListeners.delete(listener);
  }

  async subscribe<A, R>(
    name: string,
    def: QueryDef<S, A, R>,
    args: A,
    listener: (e: EngineEvent<R>) => void,
  ): Promise<() => void> {
    if (this.down || this.closed) throw new EngineDownError();
    const shared = `${name}\u0000${stableHash(args)}`;
    // Check-then-create with no await in between: two subscribes of one key in the same tick share one open.
    const live = this.entries.get(shared);
    let promise = live?.shareable ? Promise.resolve(live) : this.pending.get(shared);
    const joined = promise !== undefined;
    if (!promise) promise = this.open(shared, def, structuredClone(args));
    let entry = await promise;
    if (joined && (!entry.shareable || this.entries.get(entry.key) !== entry))
      entry = await this.open(shared, def, structuredClone(args));
    const l = listener as Listener;
    entry.listeners.add(l);
    deliver(l, entry.last);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.listeners.delete(l);
      // Identity, not key: after a reset (or a re-key) the key may belong to another entry.
      if (entry.listeners.size === 0 && this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
        this.registry.remove(entry.key);
      }
    };
  }

  private open<A, R>(shared: string, def: QueryDef<S, A, R>, args: A): Promise<CacheEntry<S>> {
    const gen = this.generation;
    const ticket = ++this.ticket;
    this.inflight.add(ticket);
    // Assigned before the body can reach its finally: the first await comes before any cleanup.
    let p: Promise<CacheEntry<S>> | undefined;
    p = (async () => {
      try {
        const r = await this.opts.runtime.runQuery(def, args);
        if (gen !== this.generation || this.down) throw new EngineDownError("the change stream reset during subscribe");
        // A volatile result is never shared; neither is a key another live entry already holds (it turned volatile).
        const shareable = r.readSet.volatile.length === 0 && !this.entries.has(shared);
        const key = shareable ? shared : `${shared}\u0000${++this.uniq}`;
        const visibility = visibilityOf(r.snapshot);
        const entry: CacheEntry<S> = {
          key,
          run: (ctx) => def.handler(ctx, args),
          shareable,
          hash: stableHash(r.value),
          last: { kind: "value", cycle: null, value: r.value },
          visibility,
          listeners: new Set(),
          transientTries: 0,
        };
        this.entries.set(key, entry);
        if (this.registry.register(key, r.readSet, visibility, this.buffer)) this.schedule();
        return entry;
      } finally {
        this.inflight.delete(ticket);
        if (this.pending.get(shared) === p) this.pending.delete(shared);
      }
    })();
    this.pending.set(shared, p);
    return p;
  }

  onEvent(e: StreamEvent): void {
    if (this.closed) return;
    if (e.kind === "barrier") {
      const w = this.barriers.get(e.id);
      if (!w) return;
      w.seen = lsnToBigInt(e.lsn);
      if (w.expected !== undefined && w.expected === w.seen) w.resolve();
      return;
    }
    const p = project(e.txn);
    this.buffer.append(e.txn.xid, p);
    if (this.registry.apply(e.txn.xid, p).length || this.registry.dirtyCount > 0) this.schedule();
  }

  flush(): Promise<number> {
    if (this.closed || this.down) return Promise.reject(new EngineDownError());
    const after = this.started;
    const p = new Promise<number>((resolve, reject) => this.cycleWaiters.push({ after, resolve, reject }));
    this.forced = true;
    this.schedule();
    return p;
  }

  async mutate<A, R>(def: MutationDef<S, A, R>, args: A): Promise<{ value: R; cycle: number; commitLsn: string }> {
    const run = await this.opts.runtime.runMutation(def, args);
    return { value: run.value, cycle: await this.flush(), commitLsn: run.commitLsn }; // Task 5 replaces this
  }

  reset(_reason: string): void {} // Task 7

  resume(): void {} // Task 7

  close(): void {
    this.closed = true;
    this.down = true;
    clearInterval(this.pruneTimer);
    for (const t of this.retryTimers) clearTimeout(t);
    for (const b of this.barriers.values()) b.reject(new EngineDownError("engine closed"));
    for (const w of this.cycleWaiters) w.reject(new EngineDownError("engine closed"));
    this.cycleWaiters = [];
  }

  private schedule(): void {
    if (this.closed || this.down || this.running) return;
    if (!this.forced && this.registry.dirtyCount === 0) return;
    void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.closed && !this.down && (this.forced || this.registry.dirtyCount > 0)) {
        this.forced = false;
        try {
          await this.cycle();
          this.failures = 0;
        } catch (e) {
          this.stats.failedCycles++;
          this.opts.onError?.(e);
          this.failures++;
          this.forced = this.forced || this.cycleWaiters.length > 0;
          await Bun.sleep(Math.min(2_000, 50 * 2 ** this.failures)); // retry: dirty entries must not stay stuck
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async barrier(): Promise<void> {
    const id = crypto.randomUUID();
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const seen = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const w: { expected?: bigint; seen?: bigint; resolve: () => void; reject: (e: unknown) => void } = {
      resolve,
      reject,
    };
    this.barriers.set(id, w);
    const ms = this.opts.barrierTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          w.expected = lsnToBigInt(await emitBarrier(this.opts.sql, id));
          if (w.seen === w.expected) w.resolve();
          await seen;
        })(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`barrier not seen in the stream within ${ms} ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.barriers.delete(id);
    }
  }

  // A transient failure (connection, conflict, resources, operator) is never cached as the result: the entry leaves
  // the dirty set and comes back after a backoff — without spinning cycles meanwhile. After TRANSIENT_TRIES the
  // error is pushed like any other.
  private retryLater(entry: CacheEntry<S>): void {
    this.registry.clearDirty(entry.key);
    const t = setTimeout(
      () => {
        this.retryTimers.delete(t);
        if (this.entries.get(entry.key) === entry && this.registry.markDirty(entry.key)) this.schedule();
      },
      Math.min(2_000, 50 * 2 ** entry.transientTries),
    );
    this.retryTimers.add(t);
  }

  private async cycle(): Promise<void> {
    const id = ++this.started;
    const gen = this.generation;
    const ex = await this.opts.sql.reserve();
    try {
      await ex.unsafe("begin isolation level repeatable read read only");
      const [{ sid, snap }] = await ex.unsafe(
        "select pg_export_snapshot() as sid, pg_current_snapshot()::text as snap",
      );
      // Read AFTER the snapshot returned: a fresh query with a later ticket started after S was taken, so its own
      // snapshot is at least as new (the plan review's N-A2).
      const ticketAtExport = this.ticket;
      await this.barrier();
      const S = visibilityOf(parseSnapshot(snap as string));
      // Only entries whose current value S contains: re-running a newer value at an older S would go back in time.
      const due = this.registry
        .dirtyKeys()
        .map((k) => this.entries.get(k))
        .filter((e): e is CacheEntry<S> => e !== undefined && contains(S, e.visibility));
      const lanes = Math.max(1, Math.min(this.opts.connections ?? 4, due.length));
      const chunks: CacheEntry<S>[][] = Array.from({ length: lanes }, () => []);
      for (const [i, e] of due.entries()) chunks[i % lanes]?.push(e);
      const results = due.length
        ? await Promise.all(
            chunks.map((c) =>
              this.opts.runtime.runInSnapshot(
                sid as string,
                c.map((e) => e.run),
              ),
            ),
          )
        : [];
      if (gen !== this.generation) return; // reset while re-running: nothing from before the reset may be pushed
      const changed: CacheEntry<S>[] = [];
      for (const [lane, chunk] of chunks.entries())
        for (const [i, entry] of chunk.entries()) {
          const r = results[lane]?.[i];
          if (!r) continue;
          this.stats.reruns++;
          if (this.entries.get(entry.key) !== entry) continue; // unsubscribed (or replaced) during the cycle
          if (!r.ok && isTransient(r.error) && entry.transientTries < TRANSIENT_TRIES) {
            this.stats.transientReruns++;
            entry.transientTries++;
            this.retryLater(entry);
            continue;
          }
          entry.transientTries = 0;
          if (r.readSet.volatile.length && entry.shareable) {
            // It turned volatile: give it a private key so a later subscriber never joins (nor replaces) it.
            this.entries.delete(entry.key);
            this.registry.remove(entry.key);
            entry.key = `${entry.key}\u0000${++this.uniq}`;
            entry.shareable = false;
            this.entries.set(entry.key, entry);
          }
          this.registry.register(entry.key, r.readSet, S, this.buffer);
          entry.visibility = S;
          const hash = r.ok ? stableHash(r.value) : `error:${String(r.error)}`;
          if (hash === entry.hash) {
            this.stats.uselessReruns++;
            continue;
          }
          entry.hash = hash;
          entry.last = r.ok
            ? { kind: "value", cycle: id, value: r.value }
            : { kind: "error", cycle: id, error: r.error };
          changed.push(entry);
        }
      await ex.unsafe("commit");
      if (gen !== this.generation) return; // a reset during COMMIT: its subscribers were already told
      this.pruneBelow(S.xmin, ticketAtExport);
      this.stats.cycles++;
      for (const entry of changed)
        for (const l of entry.listeners) {
          if (gen !== this.generation) return; // a listener reset the engine: the rest were told "reset"
          this.stats.pushes++;
          deliver(l, entry.last);
        }
      for (const l of this.cycleListeners) deliver(l, id);
      this.cycleWaiters = this.cycleWaiters.filter((w) => {
        if (w.after >= id) return true;
        w.resolve(id);
        return false;
      });
    } finally {
      await ex.unsafe("rollback").catch(() => {});
      ex.release();
    }
  }

  // A buffered commit can go once every registration still to come sees it: fresh queries whose ticket is later
  // than `ticketAtSnapshot` started after that snapshot and have an xmin at least as large; earlier ones must finish.
  private pruneBelow(xmin: number, ticketAtSnapshot: number): void {
    for (const t of this.inflight) if (t <= ticketAtSnapshot) return;
    this.buffer.prune(xmin);
  }

  private async pruneNow(): Promise<void> {
    if (this.closed || this.buffer.size === 0) return;
    const [{ x }] = await this.opts.sql`select pg_snapshot_xmin(pg_current_snapshot())::text as x`;
    const ticketAt = this.ticket; // after the snapshot returned (N-A2)
    this.pruneBelow(low32(BigInt(x as string)), ticketAt);
  }
}
