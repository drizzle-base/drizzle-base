// The subscription engine: keeps every subscribed query's value current.
//
// Stream side (onEvent, synchronous): a committed transaction's table projection is appended to the buffer, then
// applied to the index (rule B; DDL dirties everything). Cycle side (async, one at a time, while anything is
// dirty): export S; a barrier (every commit visible in S applied); re-run the dirty entries whose current value S
// contains, in S (P-M10); re-register with S (the replay re-dirties what S missed); push the changed values as one
// batch; tell cycle listeners the cycle completed; prune. Entries S does not contain wait for the next cycle, so no
// subscriber ever goes back in time. A cycle's lanes share one Catalog (they import the same snapshot); nothing
// about the catalog survives from one cycle to the next (the plan review's A3 class, removed rather than patched).
import type { SQL } from "bun";
import { emitBarrier, lsnToBigInt, type StreamEvent } from "../capture";
import {
  isTransient,
  type MutationDef,
  type MutationOptions,
  parseSnapshot,
  type QueryDef,
  type Runtime,
  type SnapshotCall,
} from "../runtime";
import { project, RecentCommits } from "./buffer";
import { Registry } from "./registry";
import { stableHash } from "./stable";
import { contains, low32, type Visibility, visibilityOf } from "./xid";

// provisional: a subscriber's FIRST value, given while the entry is dirty — older than commits the engine has
// already applied. That subscriber is guaranteed one more event after the entry's next re-run, changed or not.
export type EngineEvent<R> =
  | { kind: "value"; cycle: number | null; value: R; provisional?: true }
  | { kind: "error"; cycle: number | null; error: unknown; provisional?: true }
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
    readonly commitLsn: string | null,
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
  waiting: Set<Listener>; // got a provisional first value; owed an event after the next re-run
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
  private readonly resetListeners = new Set<(reason: string) => void>();
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

  // Live cache entries: what a server's cleanup is tested against.
  get size(): number {
    return this.entries.size;
  }

  // Every completed cycle, whether or not it pushed anything to a given subscriber: a client waiting for "a
  // transition at or after cycle N" (read-your-writes) needs to hear about cycles that changed none of its queries.
  // Every reset, told once — including to a server whose connection holds no subscription (and so no listener)
  // but waits for a mutation's cycle, which a reset during that cycle would otherwise strand.
  onReset(listener: (reason: string) => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

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
    // A first value is current only if nothing the engine has applied is missing from it: a fresh open whose replay
    // dirtied it, or a joiner on an entry being re-run or waiting for one, gets it marked provisional (01a-4a I1).
    if (this.registry.isDirty(entry.key) && entry.last.kind !== "reset") {
      entry.waiting.add(l);
      deliver(l, { ...entry.last, provisional: true });
    } else deliver(l, entry.last);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.listeners.delete(l);
      entry.waiting.delete(l);
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
          waiting: new Set(),
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

  // P-A7: read-your-writes by position. After COMMIT, a barrier written after it proves the stream has applied the
  // commit (its entries are dirty); the first cycle that starts after that exports a snapshot containing the commit.
  // The reply names that cycle; the client resolves when it has received a transition at or after it — a slow
  // re-run delays the transition, never the reply. A confirmation failure is not a mutation failure.
  async mutate<A, R>(
    def: MutationDef<S, A, R>,
    args: A,
    opts: MutationOptions<R> = {},
  ): Promise<{ value: R; encoded?: unknown; cycle: number; commitLsn: string | null }> {
    const run = await this.opts.runtime.runMutation(def, args, opts);
    try {
      if (this.down || this.closed) throw new EngineDownError();
      await this.barrier();
      const cycle = this.started + 1;
      this.forced = true;
      this.schedule();
      return { value: run.value, encoded: run.encoded, cycle, commitLsn: run.commitLsn };
    } catch (e) {
      throw new CommittedUnconfirmedError(run.commitLsn, run.value, e);
    }
  }

  // The capture failed (spec D14, P-M6): commits may have been lost, so no registered result can be trusted. Every
  // subscriber is told; the engine stays down — refusing subscribes — until resume(), which the caller invokes only
  // after recreating the slot and restarting the capture, so no new snapshot predates the new slot.
  reset(reason: string): void {
    this.generation++;
    this.down = true;
    const listeners = [...this.entries.values()].flatMap((e) => [...e.listeners]);
    for (const key of this.entries.keys()) this.registry.remove(key);
    this.entries.clear();
    this.pending.clear();
    this.buffer.clear();
    for (const w of this.cycleWaiters) w.reject(new EngineDownError());
    this.cycleWaiters = [];
    for (const l of listeners) deliver(l, { kind: "reset", reason });
    for (const l of this.resetListeners) deliver(l, reason);
  }

  resume(): void {
    if (this.closed) return;
    this.down = false;
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.down = true;
    clearInterval(this.pruneTimer);
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
        const wasForced = this.forced;
        this.forced = false;
        try {
          await this.cycle();
          this.failures = 0;
        } catch (e) {
          this.stats.failedCycles++;
          this.opts.onError?.(e);
          this.failures++;
          // A forced cycle (a mutation named it) must still happen: nothing may be dirty to bring the loop back.
          this.forced = this.forced || wasForced || this.cycleWaiters.length > 0;
          await Bun.sleep(Math.min(2_000, 50 * 2 ** this.failures)); // retry: dirty entries must not stay stuck
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async barrier(): Promise<void> {
    // close() rejects the barriers it can see; one registered after it would wait for the full timeout.
    if (this.closed) throw new EngineDownError("engine closed");
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
          if (this.closed) throw new EngineDownError("engine closed");
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

  private async cycle(): Promise<void> {
    const id = ++this.started;
    const gen = this.generation;
    // A cycle re-registers its entries with S, an OLDER snapshot than the prune timer's: until it has, it holds a
    // ticket like a fresh query, so no commit S did not see is pruned before the replay (final review C1).
    const own = ++this.ticket;
    this.inflight.add(own);
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
      const catalog = this.opts.runtime.createCatalog();
      const results = due.length
        ? await Promise.all(
            chunks.map((c) =>
              this.opts.runtime.runInSnapshot(
                sid as string,
                c.map((e) => e.run),
                catalog,
              ),
            ),
          )
        : [];
      if (gen !== this.generation) return; // reset while re-running: nothing from before the reset may be pushed
      // A transient failure (timeout, conflict, lost connection) is never cached as a result, and never lets its
      // peers go out without it: that would push half a transition (invariant 6), and a mutation's named cycle could
      // complete without the entry that carries its write. The whole cycle fails and is retried with the loop's
      // backoff; nothing was registered, so every entry stays dirty. After TRANSIENT_TRIES in a row the error is
      // pushed like any other.
      let transient = false;
      for (const [lane, chunk] of chunks.entries())
        for (const [i, entry] of chunk.entries()) {
          const r = results[lane]?.[i];
          if (!r || r.ok || !isTransient(r.error) || this.entries.get(entry.key) !== entry) continue;
          if (entry.transientTries >= TRANSIENT_TRIES) continue;
          entry.transientTries++;
          this.stats.transientReruns++;
          transient = true;
        }
      if (transient) throw new Error("a re-run failed transiently: the cycle is retried whole");
      const changed: CacheEntry<S>[] = [];
      const settled: CacheEntry<S>[] = []; // re-run this cycle with provisional subscribers waiting
      for (const [lane, chunk] of chunks.entries())
        for (const [i, entry] of chunk.entries()) {
          const r = results[lane]?.[i];
          if (!r) continue;
          this.stats.reruns++;
          if (this.entries.get(entry.key) !== entry) continue; // unsubscribed (or replaced) during the cycle
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
          if (entry.waiting.size) settled.push(entry);
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
      this.inflight.delete(own);
      this.pruneBelow(S.xmin, ticketAtExport);
      this.stats.cycles++;
      for (const entry of changed)
        for (const l of entry.listeners) {
          if (gen !== this.generation) return; // a listener reset the engine: the rest were told "reset"
          this.stats.pushes++;
          deliver(l, entry.last);
        }
      // A waiting subscriber that the push above did not reach (the value did not change) still learns that its
      // value is now current, with this cycle's id; one that it did reach is simply settled. (A joiner that arrives
      // during this cycle's COMMIT can get the pushed value right after its own first value: a harmless repeat.)
      for (const entry of settled) {
        const waiting = [...entry.waiting];
        entry.waiting.clear();
        if (changed.includes(entry)) continue;
        for (const l of waiting) {
          if (gen !== this.generation) return;
          if (!entry.listeners.has(l)) continue;
          this.stats.pushes++;
          deliver(l, entry.last.kind === "reset" ? entry.last : { ...entry.last, cycle: id });
        }
      }
      for (const l of this.cycleListeners) deliver(l, id);
      this.cycleWaiters = this.cycleWaiters.filter((w) => {
        if (w.after >= id) return true;
        w.resolve(id);
        return false;
      });
    } finally {
      this.inflight.delete(own);
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
