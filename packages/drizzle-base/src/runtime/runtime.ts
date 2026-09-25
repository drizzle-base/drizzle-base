// Runs functions. A query is one REPEATABLE READ READ ONLY transaction whose first statement records
// pg_current_snapshot() — the snapshot the subscription layer compares streamed xids against (spec D7). A
// mutation is SERIALIZABLE, retried on 40001/40P01 only, and reports pg_current_wal_insert_lsn() read after
// COMMIT on the same connection: at or past its commit record, which is what read-your-writes waits for (P-A7).
// A COMMIT that fails for any reason other than a Postgres error has an unknown outcome and is never retried
// (P-M7): the write may have landed.
import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { CATALOG_STATEMENT, Catalog, type ReadSet, readSetOf } from "../readset";
import { loadParser } from "../sql";
import { CapturingClient, type Recorded } from "./client";
import type { Ctx, MutationDef, QueryDef } from "./functions";

export interface Snapshot {
  text: string; // pg_current_snapshot() as text: "xmin:xmax:xip,…"
  xmin: bigint;
  xmax: bigint;
  xip: bigint[];
}
export interface QueryRun<R> {
  value: R;
  snapshot: Snapshot;
  readSet: ReadSet;
  statements: Recorded[];
}
export interface MutationRun<R> {
  value: R;
  encoded?: unknown; // the `encode` hook's result, computed before COMMIT
  commitLsn: string | null; // null: COMMIT succeeded but the WAL position could not be read afterwards
  attempts: number;
}
export interface MutationOptions<R> {
  // Runs on the handler's result INSIDE the transaction: if it throws, the mutation rolls back. The wire uses it to
  // encode the reply, so a value it cannot send never belongs to a write that committed.
  encode?: (value: R) => unknown;
}

export class MutationConflictError extends Error {
  override name = "MutationConflictError";
  constructor(
    readonly sqlState: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`mutation gave up after ${attempts} attempts (SQLSTATE ${sqlState})`, { cause });
  }
}
// The transaction was already aborted when the handler returned — it caught an error and carried on. Postgres
// answers COMMIT with the tag ROLLBACK and no error, so without this check the mutation "succeeds" with nothing
// written. A definite failure: nothing was applied.
export class MutationAbortedError extends Error {
  override name = "MutationAbortedError";
  constructor() {
    super("the mutation's transaction was aborted by an error its handler caught; nothing was written");
  }
}
export class CommitOutcomeUnknownError extends Error {
  override name = "CommitOutcomeUnknownError";
  constructor(cause: unknown) {
    super("the connection failed during COMMIT: the mutation may or may not have been applied", { cause });
  }
}

const RETRYABLE = new Set(["40001", "40P01"]);
// Drizzle wraps every driver error in DrizzleQueryError and keeps the original as `cause`: the SQLSTATE lives
// on the innermost error, so both checks walk the chain (a retry that looked only at the outer error never
// retried a serialization failure).
const rootError = (e: unknown): unknown => {
  let cur = e;
  for (let i = 0; i < 5 && (cur as { cause?: unknown })?.cause; i++) cur = (cur as { cause: unknown }).cause;
  return cur;
};
const sqlState = (e: unknown): string | undefined => (rootError(e) as { errno?: unknown })?.errno?.toString();
const isServerError = (e: unknown) => (rootError(e) as { name?: string })?.name === "PostgresError";

// Errors worth retrying on a later cycle instead of pushing as the query's result: connection (08), conflict (40),
// resources (53), operator intervention (57), or Bun's own connection-closed error. A handler's plain throw is not.
export function isTransient(e: unknown): boolean {
  const code = sqlState(e);
  if (code !== undefined) return /^(08|40|53|57)/.test(code);
  return /^ERR_POSTGRES_CONNECTION/.test(String((rootError(e) as { code?: unknown })?.code ?? ""));
}

export type SnapshotCall<S extends Record<string, unknown>> = (ctx: Ctx<S>) => Promise<unknown>;
export type SnapshotResult =
  | { ok: true; value: unknown; readSet: ReadSet }
  | { ok: false; error: unknown; readSet: ReadSet };
const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i;
// What a run's read-set resolution needs from its connection, read in the statement each run sends first: the
// schemas names resolve in (with the session's temp schema) and whether the connection already holds the prepared
// catalog statement.
const READ_CONTEXT =
  "select current_schemas(true)::text as sp, exists (select 1 from pg_prepared_statements where name = $1) as ready";
const READ_CONTEXT_WITH_SNAPSHOT =
  "select pg_current_snapshot()::text as s, current_schemas(true)::text as sp, exists (select 1 from pg_prepared_statements where name = $1) as ready";

export function parseSnapshot(text: string): Snapshot {
  const [xmin = "0", xmax = "0", xip = ""] = text.split(":");
  return { text, xmin: BigInt(xmin), xmax: BigInt(xmax), xip: xip ? xip.split(",").map(BigInt) : [] };
}

// The catalog is memoised per run — or per cycle, shared by the cycle's lanes, which all import the same snapshot
// — and never across them: a lookup made for one run or cycle is never served to another. One statement resolves
// every name a run needs (Catalog.prefetch). Keys carry current_schemas(true), which names the session's temp
// schema too. Name resolution itself (the parser, to_regclass) reads Postgres's latest catalog, not the imported
// snapshot, so this alone does not make a read-set exact across a concurrent DDL: that rests on the subscription
// layer, where a streamed DDL dirties every entry and the replay catches the rest.
export class Runtime<S extends Record<string, unknown>> {
  private readonly maxAttempts: number;

  constructor(private readonly opts: { sql: SQL; schema: S; publication: string; maxAttempts?: number }) {
    // Bun.sql's prepared statements break after a schema change (0A000 "cached plan must not change result type",
    // probed on parameterised statements): drizzle-base's pool never prepares.
    if ((opts.sql as unknown as { options?: { prepare?: boolean } }).options?.prepare !== false)
      throw new Error(
        "drizzle-base needs a pool created with prepare: false (Bun.sql's prepared statements break after a schema change)",
      );
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  private ctx(client: CapturingClient): Ctx<S> {
    // drizzle-orm/bun-sql types its client as Bun's SQL; CapturingClient implements the part the driver calls.
    return { db: drizzle({ client: client as unknown as SQL, schema: this.opts.schema }) };
  }

  async runQuery<A, R>(def: QueryDef<S, A, R>, args: A): Promise<QueryRun<R>> {
    await loadParser();
    const conn = await this.opts.sql.reserve();
    const client = new CapturingClient(conn, "query");
    try {
      await conn.unsafe("begin isolation level repeatable read read only");
      try {
        const [{ s, sp, ready }] = await conn.unsafe(READ_CONTEXT_WITH_SNAPSHOT, [CATALOG_STATEMENT]);
        const value = await def.handler(this.ctx(client), args);
        const readSet = await readSetOf(client.statements, this.createCatalog(), conn, sp as string, {
          ready: ready as boolean,
        });
        await conn.unsafe("commit");
        return { value, snapshot: parseSnapshot(s as string), readSet, statements: [...client.statements] };
      } catch (e) {
        await conn.unsafe("rollback").catch(() => {});
        throw e;
      }
    } finally {
      client.close();
      try {
        conn.release();
      } catch {
        // a terminated connection may refuse release; the pool discards it
      }
    }
  }

  // Runs each call in the exported snapshot, one transaction on one connection, a savepoint per call (P-M10). A
  // failing call does not break the others; a read-set that cannot be resolved widens to OPAQUE for that call.
  // One Catalog for a whole cycle: its lanes share the exported snapshot, and a name one lane resolves is not
  // looked up again by the others.
  createCatalog(): Catalog {
    return new Catalog(this.opts.publication);
  }

  async runInSnapshot(
    snapshotId: string,
    calls: SnapshotCall<S>[],
    catalog: Catalog = this.createCatalog(),
  ): Promise<SnapshotResult[]> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`not a snapshot id: ${JSON.stringify(snapshotId)}`);
    await loadParser();
    const conn = await this.opts.sql.reserve();
    const results: SnapshotResult[] = [];
    try {
      await conn.unsafe("begin isolation level repeatable read read only");
      try {
        await conn.unsafe(`set transaction snapshot '${snapshotId}'`);
        const [{ sp, ready }] = await conn.unsafe(READ_CONTEXT, [CATALOG_STATEMENT]);
        const prepared = { ready: ready as boolean }; // one connection for the whole lane
        for (const call of calls) {
          const client = new CapturingClient(conn, "query");
          await conn.unsafe("savepoint dzb_call");
          let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
          try {
            outcome = { ok: true, value: await call(this.ctx(client)) };
            await conn.unsafe("release savepoint dzb_call");
          } catch (error) {
            await conn.unsafe("rollback to savepoint dzb_call");
            outcome = { ok: false, error };
          } finally {
            client.close();
          }
          let readSet: ReadSet;
          try {
            readSet = await readSetOf(client.statements, catalog, conn, sp as string, prepared);
          } catch (e) {
            readSet = { tables: new Set(), opaque: [`read-set resolution failed: ${String(e)}`], volatile: [] };
          }
          results.push({ ...outcome, readSet });
        }
        await conn.unsafe("commit");
        return results;
      } catch (e) {
        await conn.unsafe("rollback").catch(() => {});
        throw e;
      }
    } finally {
      try {
        conn.release();
      } catch {
        // a terminated connection may refuse release; the pool discards it
      }
    }
  }

  async runMutation<A, R>(def: MutationDef<S, A, R>, args: A, opts: MutationOptions<R> = {}): Promise<MutationRun<R>> {
    await loadParser();
    for (let attempt = 1; ; attempt++) {
      let committed: { value: R; encoded?: unknown; attempts: number } | null = null;
      const conn = await this.opts.sql.reserve();
      const client = new CapturingClient(conn, "mutation");
      try {
        await conn.unsafe("begin isolation level serializable");
        let value: R;
        let encoded: unknown;
        try {
          value = await def.handler(this.ctx(client), args);
          if (opts.encode) encoded = opts.encode(value);
        } catch (e) {
          await conn.unsafe("rollback").catch(() => {});
          const code = sqlState(e);
          if (code && RETRYABLE.has(code)) {
            if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
            await backoff(attempt);
            continue;
          }
          throw e;
        }
        let tag: string | undefined;
        try {
          tag = ((await conn.unsafe("commit")) as { command?: string }).command;
        } catch (e) {
          const code = sqlState(e);
          if (isServerError(e) && code && RETRYABLE.has(code)) {
            if (attempt >= this.maxAttempts) throw new MutationConflictError(code, attempt, e);
            await backoff(attempt);
            continue; // a serialization failure at COMMIT rolled the transaction back: safe to retry
          }
          // A Postgres error at COMMIT is a definite failure — unless it is a connection (08) or operator
          // intervention (57, e.g. pg_terminate_backend) class: then the COMMIT may or may not have run.
          if (isServerError(e) && code && !/^(08|57)/.test(code)) throw e;
          throw new CommitOutcomeUnknownError(e);
        }
        if (tag === "ROLLBACK") throw new MutationAbortedError();
        committed = opts.encode ? { value, encoded, attempts: attempt } : { value, attempts: attempt };
      } finally {
        client.close();
        try {
          conn.release();
        } catch {
          // a terminated connection may refuse release; the pool discards it
        }
      }
      // The barrier, not this position, is what read-your-writes waits on: failing to read it after a successful
      // COMMIT must not turn a landed write into an error.
      if (committed) return { ...committed, commitLsn: await this.walPosition().catch(() => null) };
    }
  }

  // The WAL insert position is global and only moves forward: read on any connection after COMMIT returned, it
  // is at or past the commit record. Reading it on the pool — not on the function's connection — means a
  // connection that dies after a successful COMMIT cannot turn a landed write into an error (final review #9).
  private async walPosition(): Promise<string> {
    for (let i = 1; ; i++) {
      try {
        const [{ l }] = await this.opts.sql`select pg_current_wal_insert_lsn()::text as l`;
        return l as string;
      } catch (e) {
        if (i >= 3) throw e;
        await Bun.sleep(20 * i);
      }
    }
  }
}

const backoff = (attempt: number) => Bun.sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
