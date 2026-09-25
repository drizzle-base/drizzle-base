# DZB-01 — the foundation: reactive Drizzle on Postgres

> **Name:** the project was renamed **drizzle-base** on 25 Sep 2026 (npm convention for Drizzle complements, e.g.
> `drizzle-zod`, `drizzle-cursor`); text written before that says "drizzlebase".

> **v2 — the POST-REVIEW DECISION block below supersedes the body where they disagree.** v1 was written 24 Sep 2026 from four probes whose code lives in `spikes/` (throwaway; the
> findings are the record). This changes nothing that exists — it defines the kernel of a new project — but it
> IS kernel and consistency work, so it takes the reinforced ritual: two independent adversarial reviews of this
> document (A: correctness/concurrency, B: strategy/performance), a POST-REVIEW DECISION block, and a final
> reviewer on every implementation phase. No code outside `spikes/` before that block exists.

## POST-REVIEW DECISION (v2, 24 Sep 2026) — READ THIS BEFORE THE BODY

Two independent adversarial reviews, both **FIX-FIRST**: **A (correctness/concurrency)**, probes in
`spikes/review-a/`, and **B (strategy/performance/DX)**, probes in `spikes/review-b/`. Neither asked for a
redesign: logical decoding (D1), the xid-visibility rule (D7), one snapshot per cycle (D8) and "widen, never
narrow" all survived, and A confirmed D7 under savepoints and 2PC, D8's snapshot import across connections,
TOAST under FULL, and that drizzle-orm's bun-sql driver sends every non-transaction statement through
`client.unsafe()`. B retired risk #1: libpg-query 18.1.5 (WASM) runs under Bun, parses all 76 P1 statements
incl. INTERSECT/EXCEPT, ~20 µs per parse. The author re-read the probe outputs behind every A-level item
before accepting it. **Where this block and the body disagree, this block wins.**

### A — blocking (all accepted)

- **P-A1 (RA-A1, RB-M7) — every relation in the tree is a scan.** A dropped conjunct used to drop the tables
  inside it (`NOT EXISTS`/`NOT IN (subquery)`/`OR … IN (subquery)` lost `posts`; a quoted `"Users"` produced an
  empty read-set — `review-a/analyzer_holes.out`). Rule: every RangeVar anywhere in the parse tree (conjuncts,
  CASE, select list, ORDER BY, function args, set-op arms) yields at least a TABLE scan; only a positive
  top-level conjunct may be dropped; an unknown under NOT/OR is MAYBE (NOT MAYBE = MAYBE). A relation that
  does not resolve, or is not in the publication (another schema, created at runtime), is OPAQUE. Views and
  `LANGUAGE sql` functions are expanded (`pg_get_viewdef`, `prosrc`) before falling back to OPAQUE (RB-M6).
  Corpus gains NOT EXISTS, NOT IN (subquery), OR (subquery), CASE, quoted mixed-case names, recursive CTEs,
  window functions, DISTINCT ON.
- **P-A2 (RB-A1, RA-M6) — the transport is streaming replication, not polling.** Polling rebuilds a decoding
  context from `restart_lsn` on every call: 0.6 ms idle, 41→204 ms per poll while an open transaction pins the
  slot (`review-b/poll_cost.txt`); `upto_nchanges` is honoured only at transaction boundaries, so one 20 000-row
  UPDATE came back as one 177 MB poll and +742 MB RSS (`poll_bulk.txt`); a batch that throws after the call
  returned is lost. v1 streams pgoutput over the walsender (`pg-logical-replication` on `pg`, under Bun:
  commit→receive p50 0.49 ms, p99 3.7 ms — `stream_probe.txt`), acknowledges its LSN only after a transaction
  is applied, and processes a transaction message by message. **Per-transaction row cap:** past N rows the
  images are discarded and the transaction invalidates its tables at table level — memory is bounded by N.
  D12 is replaced by this item.
- **P-A3 (RA-A2) — a flush cycle waits for a stream barrier.** The exported snapshot can see commits the stream
  has not delivered, so one batch could mix two points in time. Cycle: export S → read
  `pg_current_wal_insert_lsn()` → `pg_logical_emit_message(false, 'drizzlebase.barrier', …)` (pgoutput
  `messages = true`) → process the stream up to the barrier → re-run at S every entry dirtied by a transaction
  visible in S; entries dirtied only by transactions not visible in S carry to the next cycle. The dirty bit is
  cleared at re-registration. A batch is tagged with a cycle id, never with an LSN (no LSN prefix equals a
  snapshot — P4).
- **P-A4 (RA-A3) — the recent-commits buffer is pruned against a snapshot taken after the commit streamed.**
  With no query in flight the old bound emptied the buffer, while a streamed commit can still sit in the next
  snapshot's `xip` (synchronous replication widens that window). Prune T only when T.xid precedes the xmin of
  a snapshot taken after T was streamed (fold `pg_snapshot_xmin(pg_current_snapshot())` in on each barrier);
  never prune to empty on "nothing in flight".
- **P-A5 (RA-A4, RB-B7) — the driver owns transaction control.** drizzle's `db.transaction()` calls
  `client.begin()`; on our reserved connection that sent BEGIN (a warning) and COMMIT, committing the outer
  transaction silently (`review-a/nested_tx.out`: the server log and the snapshot change). The wrapper maps
  `begin` to a savepoint and implements `savepoint`; it refuses `reserve`, `close`, and any statement whose
  parse is transaction control (BEGIN/COMMIT/ROLLBACK/SET TRANSACTION). `db.$client` is the wrapper; drizzle's
  `cache` option is never passed.
- **P-A6 (RA-A5) — generated columns.** FULL + a publication makes UPDATE/DELETE fail on a table with a
  generated column unless it is published (`review-a/gen_cols.out`). The publication is created
  `WITH (publish_generated_columns = stored, publish_via_partition_root = true)`; boot refuses a published
  table with a VIRTUAL generated column (PG 18 cannot publish them) and runs a trivial UPDATE probe per table.
- **P-A7 (RA-A6, RB-M4) — read-your-writes by position, decoupled from the flush.** A mutation that writes
  nothing produces no stream transaction (pgoutput skips empty ones — `review-a/pgoutput.out` §4b), so waiting
  for its xid hangs. After COMMIT the mutation reads `pg_current_wal_insert_lsn()` on its connection,
  releases the connection, waits for a barrier past that LSN, and replies tagged with the first cycle id whose
  snapshot contains its commit. The client resolves the mutation when it has received that cycle's
  transition — a slow dashboard query in the cycle delays the transition, not the reply. No
  `pg_current_xact_id()` up front.
- **P-A8 (RA-A7) — the evaluator is type-directed and tested against Postgres itself.** Nine concrete
  disagreements (`review-a/js_semantics.out` vs `.pg.out`): float NaN, numeric division truncated, numeric
  `1.0 = 1.00`, LIKE with `\n`, `\` escapes, astral characters, Kelvin/`İ` under ILIKE, nondeterministic ICU
  equality. Operations dispatch on the type OID (integer truncation, exact decimal numeric, float NaN/−0);
  LIKE is dotall, code-point based, honours `\`; ILIKE/lower/upper on non-ASCII answer MAYBE unless the
  collation is C; nondeterministic collations, citext and enums answer MAYBE for comparison and make key
  membership TABLE; keys pass a per-type canonicaliser. **A differential test** — random images ×
  allow-listed expressions, compared with `select <expr> from (values …)` on PG 18 with the production
  collation, adversarial generators (NaN, ±0, `\n`, `\`, `%`, `_`, astral, Turkish/Greek/Kelvin pairs, numeric
  scales, DST-crossing timestamptz) — gates every operator on the allow-list.

### M — must hold before the phase that implements it (all accepted)

- **P-M1 (RA-M1) — DDL arrives through the stream.** A rewriting ALTER emits 0 row messages; relation messages
  are lazy. A `ddl_command_end` + `sql_drop` event trigger emits a transactional
  `pg_logical_emit_message(true, 'drizzlebase.ddl', …)`: DDL reaches the stream in commit order and
  invalidates everything and recycles the pool (F7). Boot checks the trigger exists.
- **P-M2 (RA-M2) — TRUNCATE** invalidates every scan of every listed relation, CASCADE included.
- **P-M3 (RA-M3, RB-M7) — partitions and inheritance.** `publish_via_partition_root` (P-A6); scans are indexed
  by OID with a leaf→root map; plain inheritance children map to the parent or the query is OPAQUE; REPLICA
  IDENTITY FULL is checked on leaves, at boot and after every migrate.
- **P-M4 (RA-M4) — RLS.** A table with `relrowsecurity`, unless the role bypasses RLS, makes the query OPAQUE in
  DZB-01; role and settings join the cache key when auth lands.
- **P-M5 (RA-M5) — xids are compared modulo 2^32** against the snapshot's truncated `xmin`/`xmax`
  (`TransactionIdPrecedes`), never widened with an epoch read at another time.
- **P-M6 (RA-M7) — the slot exists before any snapshot is taken.** On boot and on every slot loss (invalidated,
  or dropped — Neon removes inactive slots, RB-M8): drop every subscription, recreate the slot, THEN let
  clients re-run. Never `pg_replication_slot_advance` past a backlog.
- **P-M7 (RA-M9) — an ambiguous COMMIT is not retried.** Retry only 40001/40P01 raised before or at COMMIT; a
  connection lost during COMMIT answers *committed, confirmation pending* (or checks `pg_xact_status`).
- **P-M8 (RA-M8) — the oracle judges real images.** It consumes images from the pgoutput decoder (not
  `to_json`), runs on PG 18 with the production collation, uses the differential test of P-A8, and keeps its
  canonical (order-free) comparison only for queries without a total ORDER BY.
- **P-M9 (RB-M1) — FULL is not free on real rows; say so.** On a 20-column table with 4 indexes, a 2 KB jsonb
  and 6 KB of TOAST, FULL costs 10–16× the WAL per update and −28…−41 % write throughput
  (`review-b/wide_wal.txt`, `wide_tps.txt`). §1's "≈ 0" held only for P2's 4-column table. The wide-table
  bench runs in the first phase. A per-table `DEFAULT` identity opt-out is filed (O2).
- **P-M10 (RB-M2) — keys from the result for DYNAMIC; one transaction per connection per cycle.** For the
  nested-`with` shape, a re-run with D5's two key queries plus its own transaction does ~1.7k/s against 5–5.7k/s
  bare (`review-b/rerun_cost.txt`). DYNAMIC keys are read from the result, including the positional
  `json_build_array` inside RQB's `json_agg`; side queries remain for KEYQUERY only; a key query whose source
  is TABLE degrades its dependent to TABLE (RA-B2). A connection's share of a cycle runs inside ONE
  transaction importing the snapshot. The P3 `inner` sabotage and a `keyMismatch` check guard the result keys.
  D5 is replaced by this item. Multiplexing (`unnest(args) cross join lateral …`, `multiplex.txt`) is filed (O3);
  D10's cache key is (SQL shape, args) so it stays possible.
- **P-M11 (RB-M3) — the LIMIT boundary is a tier.** A page (`order by … limit n`) is bounded by the last row's
  sort key, fetched as n+1 to detect the cut, with minivex's null-region guard; minivex measured 420× fewer
  recomputes for `take(20)` (`minivex/docs/BENCH.md:621-640`). Plus column pruning in D6: an UPDATE whose
  changed columns miss the scan's read columns, and whose row keeps matching, is skipped.
- **P-M12 (RB-M6) — the developer sees the tiers.** A per-function `explain` (tier per scan, dropped conjuncts,
  OPAQUE reasons) in the CLI and dev overlay; a dev strict mode that throws on OPAQUE/TABLE; per-function
  re-runs/s and the **useless re-run ratio** (re-run hash equal to the previous one). The purity rule (D15.3)
  gets a dev-time lint for `Date.now()`/`Math.random()` in handlers — SQL text cannot see them. Non-determinism
  in SQL is classified by `pg_proc.provolatile` + SQLValueFunction nodes, not a name list (RA-B3).
- **P-M13 (RB-M5) — the phases are re-sliced: a vertical slice first.** P1/P3 already proved extraction; the
  unmeasured risks are the transport, FULL's cost, the re-run cost and the product itself. New §4 below.
- **P-M14 (RB-M8) — hosting and the minivex split are decisions, recorded here.** DZB-01 targets self-hosted or
  single-tenant Postgres: logical decoding needs a REPLICATION-privileged role (which can read the cluster's
  WAL) and a slot per database under a cluster-wide `max_replication_slots` — the reason minivex rejected it
  for shared tenants (`minivex/docs/specs/OOB-01-out-of-band-writes.md:221-225`). The trigger+outbox `Capture`
  is the shared-cluster path. The promise is **"any Drizzle query is correct; a documented subset is
  precise"**, shown per function by P-M12's explain — the answer to the landscape (Electric, Zero, Hasura each
  narrowed the language or gave up precise invalidation). §0 states what drizzlebase buys that minivex's
  COLS/OOB work does not: the free query language and `pgTable` as the source of truth; the price is FULL
  identity, a slot, REPLICATION privilege and re-running arbitrary SQL.

### B — accepted, folded into the phases

RA-B1 (append to the buffer before matching, no await), RA-B2 (key-query degradations; anchors form a
forest), RA-B4 (pin `TimeZone`/`DateStyle`/`IntervalStyle`/`extra_float_digits` on the decoder and the
evaluator), RA-B5 (Studio/psql at READ COMMITTED sit outside SSI — documented), RA-B6 (results without a total
ORDER BY are diffed order-insensitively), RB-B1 (LRU over parse + extraction), RB-B2 (auth scoping needs
taint on `ctx.auth` reads — for the auth spec), RB-B3 (regression benches: an open transaction under load, one
1M-row UPDATE), RB-B4 (nothing blocks IVM or multi-node).

### Open — for the owner

- **O1** — share the sync protocol and client with minivex as one package, or copy them (RB-M8: two copies
  drift). Touches minivex; the owner's call.
- **O2** — per-table `DEFAULT` identity (cheaper writes; UPDATE/DELETE on that table invalidate at table level).
- **O3** — multiplexed re-runs (Hasura-style) once the useless ratio and re-run cost are measured.

### The phases, re-sliced (supersedes §4)

| Phase | Content | Done when |
|---|---|---|
| **DZB-01a** — the vertical slice | Streaming capture (P-A2) + publication/boot/post-migrate checks (P-A6, P-M1, P-M3, P-M6); the driver with transaction control (P-A5); every scan at **TABLE** level (P-A1's rule: all relations, OPAQUE detection); the cycle with barrier + exported snapshot (P-A3, P-A4); mutations with read-your-writes (P-A7, P-M7); functions, WebSocket and React client (quarried); a demo edited live from Drizzle Studio | A Studio edit re-pushes a `with` query in the browser; capture-equivalence, race and flush-consistency properties green with sabotages; benches: reactive latency, **useless re-run ratio**, wide-table write cost, open-transaction and 1M-row regressions |
| **DZB-01b** — row-level precision | INTERVAL + PREDICATE tiers, the type-directed evaluator (P-A8) with the differential test, the oracle on real images (P-M8) | Useless ratio measurably lower than 01a on the corpus; soundness oracle + sabotages green |
| **DZB-01c** — joins | DYNAMIC keys from the result, KEYQUERY side queries, degradations (P-M10) | Same gate, on the relational corpus |
| **DZB-01d** — pages and visibility | LIMIT boundary + column pruning (P-M11); explain, strict mode, metrics, lint (P-M12) | Feed/cursor corpus gate; explain output reviewed |

Each tier must pay for itself against 01a's useless-ratio baseline (the minivex invariant: measure before and
after). Each phase keeps a final reviewer on its implementation.

### DZB-01a-1 review (capture; final reviewer 24 Sep 2026, verdict "ready to merge with fixes")

Fixed, each with a test that failed first: `start()` fails closed and retries a slot still held; slot and
publication names validated (the replication command sends them unquoted and Postgres folds case — a
mixed-case publication lost every change silently); a liveness deadline for a server that goes silent; barriers
acknowledged plus an optional periodic barrier so a quiet app does not retain WAL without limit; the boot check
requires every publish operation and refuses an invalidated slot or one from another database; xid and
relation OID made unsigned. Found during implementation, also fixed: acknowledging `commitEndLsn` confirmed
one byte past the WAL end (the library adds one) and skipped the next barrier; a failed handler let later
transactions be acknowledged over it; unflushed barriers waited ~180 ms for the WAL writer.
**Deferred to the phase that needs them:** partitioned roots are not made FULL (relkind `p`; widens, costs 01b
precision); images use the process-global `pg.types` parsers and the walsender's GUCs are not pinned (RA-B4,
before 01b); barriers can be forged by any role (01a-3 matches on the LSN `emitBarrier` returns, not the id);
the equivalence property checks keys, not image contents (P-M8).

### DZB-01a-2 review (runtime; final reviewer 25 Sep 2026, verdict "not ready, with fixes" → fixed)

Fixed, each with a test (red first, or red when the fix is removed): a mutation whose handler caught an error
committed nothing but reported success (COMMIT on an aborted transaction answers with the tag ROLLBACK and no
error) → `MutationAbortedError`; the catalog resolved names on the pool while the function held a connection
(deadlock on a small pool, and a different search_path resolved a name to another table) → resolution on the
function's own connection, cached by (search_path, name); `set_config()` and session advisory locks refused;
SQL-running built-ins (`query_to_xml`, `table_to_xml`, …) and user-defined operators → OPAQUE; publication
membership checked per scanned table (ONLY respected), not per family; a statement issued after the handler
returned is refused (the client closes); concurrent `db.transaction()` blocks serialized, unique savepoint
names; `SELECT … INTO` refused; the WAL position read on the pool after COMMIT; a real commit-time 40001
(write skew) retried, with backoff. Found during implementation: Drizzle wraps driver errors in
`DrizzleQueryError` (the SQLSTATE is on `cause`), so the retry never fired until the runtime walked the chain.
**Deferred:** user casts and domain CHECK functions are not resolved (same class as user operators; 01b);
a caught 40001 is reported as `MutationAbortedError`, not retried; `Catalog.clear()` is wired to DDL in 01a-3
(P-M1); the parse cache evicts FIFO, not LRU (RB-B1); `runQuery` still takes three round trips for
BEGIN/snapshot/COMMIT (`docs/BENCH.md`).

### DZB-01a-3 review (subscriptions; plan reviewed twice, final reviewer 25 Sep 2026, verdict "fix first" → fixed)

Two plan reviews (v2, v3) before code; v3 removed the cross-run catalog cache instead of patching it: a catalog
lookup is memoised within one run only, so a DDL can no longer poison a later run (`Catalog.clear()` from 01a-2's
deferred list is moot). Found during implementation, by sabotages that stayed green: Postgres computes a
snapshot's xmax as latestCompletedXid + 1, so an open transaction holding the newest xid is never in xip (the
held-open tests complete a later transaction first and assert the xid is in xip); the read-your-writes contract is
cycle COMPLETION (`onCycleComplete`), not "the named cycle pushes"; the two-table property needs a lagging stream
and a workload where one side is dirty alone. Final review, each fixed with a test red first and red again under
its sabotage: the prune timer could drop a commit a cycle still re-running at S needed for its replay
(under-invalidation) → a cycle holds a ticket until it has re-registered; a forced cycle that failed with nothing
dirty was never retried → it stays forced; a transient re-run let its peers push without it (half a transition,
a named cycle without the write) → the whole cycle fails and is retried with backoff; tests added for never going
back in time, re-keying an entry that turns volatile, and a reset during COMMIT.
**Deferred:** a barrier matched by id only would pass the tests (forging needs WAL access); `rollback` after a
successful COMMIT (one round trip per cycle); the pool needs `max >= connections + 1`; `reset()` does not reject
pending barriers; no bound on a cycle's or a fresh query's time; an idle-in-transaction writer pins xmin and the
buffer is replayed whole on every registration (index it by table, RB-B3); a duplicate barrier id arriving early
overwrites `seen`. Performance: the per-run catalog cost was mostly PLANNING, not round trips; cured by DZB-PERF-CATALOG
(one prepared catalog statement per run, one `Catalog` per cycle; `docs/BENCH.md`, −27 % / −50 %). A cross-run cache
keyed by the DDL stream's generation stays open (needs its own spec). Its final review found no stale answer from the prepared plan
across DDL (probed under generic and custom plans) and fixed: an untested volatility reduction (names with mixed
overloads, `to_timestamp`), a dollar-quote tag the text's end could complete, a malformed catalog answer leaving
waiters pending, and a statement name that did not hash the PREPARE signature. **Deferred:** developer-authored
plpgsql run by a query can DEALLOCATE the catalog statement (the run then fails closed) or PREPARE one under its name
that outlives the run; no test pins that `ready` is set only after PREPARE succeeds (a wrong order fails closed).

### DZB-01a-4a review (the wire protocol and the WebSocket server; plan reviewed, final reviewer 25 Sep 2026, verdict "fix first" → fixed)

The plan review (1 Critical, 11 Important, all accepted) moved one change into the engine: a subscriber's first
value that is older than commits the engine already applied (a fresh open whose replay dirtied it, a joiner on a
dirty entry) is PROVISIONAL, and that subscriber is owed one event after the entry's next re-run, changed or not; the
server holds it until then, so a client never shows data older than its own resolved mutation. The first value
always goes out at once otherwise (a joiner's carries the entry's last cycle id). A mutation's reply names a cycle;
the connection is sent a `txn` at or after it, empty when nothing it watches changed, compared with ≥ (a failed cycle
is retried under a new id). Final review, each fixed with a test red before and red again under its sabotage: a
reset during the named cycle stranded a connection with no subscription (the engine now has `onReset`, and the
server resets every connection); a cycle whose barrier was registered after `close()` waited the full 10 s barrier
timeout; `stop()` during a capture restart could leave a capture running (the restart logic is now a
`CaptureSupervisor` with injected dependencies, tested deterministically: stop mid-restart, a capture dying while the
restart finishes, errors from an older capture); the integration harness consumed frames in arrival order and was
red in 4 of 5 runs (now 3 consecutive full runs green, same count); the server-wide call limit, the log redaction
and the explicit origin list gained tests; the encoder refuses an own `__proto__` key; `toWireError` never throws; a
mutation whose socket closed while it waited for a slot is not run. **Deferred:** a message rate limit (a 1 MiB
bigint costs ~52 ms of CPU); encoding a shared entry once per subscriber per cycle (hot path: bench first); the
capture's WAL-advance barrier is wired but untested; the library logger is the capture's (`log`), with no
`onError` override yet; `reset()` still does not reject barriers in flight (the 01a-3 M3 item).

## 0. What and why

drizzlebase gives an app written with **plain drizzle-orm** (schema in real columns, migrations by drizzle-kit,
data browsable and editable in Drizzle Studio) what Convex gives an app written against its own API: named
server functions, **reactive queries that re-push when the data they read changes**, a shared query cache,
ACID mutations, and a typed client.

The sibling project minivex does this by **restricting the query language** (`withIndex().eq().gt()…`) so every
query is, by construction, an index interval. drizzlebase refuses that restriction: the developer writes any
Drizzle query — joins, relational `with`, aggregates, subqueries, raw `sql` — and the system derives the
read-set from the SQL Drizzle emits. Where it cannot be precise it is **wider, never narrower**.

minivex is a quarry, not a dependency: kernel ideas, the sync protocol and the client are copied and adapted.

### Non-goals of DZB-01
- Databases other than Postgres (D1). The capture sits behind an interface so a trigger+outbox driver can come
  later; nothing else in v1 assumes it will.
- Auth, actions, scheduler, files, multi-node. In that order, after DZB-01.
- A query language of our own. The developer's API is Drizzle's, unmodified.

## 1. Evidence (what the probes established)

| Probe | Question | Answer | Record |
|---|---|---|---|
| P1 | Can a read-set be derived from a free Drizzle query? | Yes, from the emitted SQL at the driver: 54/76 cases precise; the rest widen to a table or need a key side-query | `spikes/p1-extract/FINDINGS.md`, `report.txt` |
| P3 | Is that read-set sound? | 0 violations over 3 seeds × 1000 random writes × 62 read cases (PGlite, snapshot diff as truth). Sabotages `inner` (10) and `gte` (25) go red; `leftjoin` (a sound degradation) stays green | `spikes/p1-extract/oracle.ts`, `oracle-*.txt` |
| P2 | Can every write be captured, incl. Drizzle Studio's? | Logical decoding, row triggers and statement triggers: 0 missed images over 2 × 1500 writes incl. cascade, user triggers, TRUNCATE, rollback. RETURNING OLD/NEW misses ~11 % of steps (cascade, trigger writes, TRUNCATE). Write cost: logical ≈ 0; row trigger −42 % pk update, −83 % bulk | `spikes/p2-capture/FINDINGS.md` |
| P2c | Can an outbox consumer miss rows? | `id > last` misses ~55 %; an xid8 + `pg_snapshot_xmin` cursor misses 0. Logical decoding is commit-ordered and has no such problem | same |
| P4 | Does subscribing race the stream? | Reacting to commits with LSN > an LSN read after the query misses ~10 %; reacting iff the xid is NOT visible in the query's own `pg_current_snapshot()` misses 0 (sabotage `xip` → red) | `spikes/p2-capture/race.ts` |

Findings that shape decisions below, by number:
- **F1** Drizzle operators are template strings (`eq` = `` sql`${a} = ${b}` ``); the builder knows leaves, not operators.
- **F2** Keys read from a query's RESULT are a sound read-set only when the source side is preserved (left side of
  a LEFT JOIN; the parent of a relational query, which Drizzle emits as `left join lateral … on true`) and no
  WHERE tests the nullable side. An inner join drops rows and loses keys — under-invalidation. P1's first
  analyzer had exactly this bug; P3's `inner` sabotage reproduces it.
- **F3** Inside `sql```, a single-table select drops the table qualifier; name resolution must follow Postgres
  exactly (P1 D05: `${users.id}` in a subquery over posts bound to `posts.id`).
- **F4** pgsql-ast-parser does not parse INTERSECT/EXCEPT; the real parser (libpg-query) is required.
- **F5** The read-set need not be an index interval: a change is tested by evaluating the query's predicate on
  the changed row's OLD and NEW images. That needs full images (REPLICA IDENTITY FULL) and an evaluator that is
  Postgres-exact or answers "maybe".
- **F6** test_decoding omits NULL columns from the old tuple (a parser artefact, not a loss).
- **F7** Bun.sql does not re-prepare after an ALTER: `0A000 cached plan must not change result type` on every
  retry (minivex COLS-02 S1). drizzle-kit migrations ALTER.

## 2. Decisions

### D1 — Postgres only; capture by logical decoding; a `Capture` interface for later drivers
Logical decoding is complete (captures Studio, psql, cascades, triggers), costs ≈ nothing on the writer (P2),
and is commit-ordered (P2c). Its costs: Postgres only, `wal_level=logical`, one slot per database, a stalled
consumer retains WAL. The stream is consumed through an internal `Capture` interface (start, next batch of
committed transactions, position) so trigger+outbox (portable, −20…−80 % writes, needs the xid8 cursor) can
be added without touching subscriptions.

### D2 — the developer's API
- Schema: Drizzle `pgTable` + `relations`. Migrations: drizzle-kit, unmodified, then the post-migrate step (D13).
- Functions: `query({ args, handler })` and `mutation({ args, handler })` in a functions directory, called by
  name over a WebSocket (`api.module.fn`), types inferred end to end (the minivex client pattern).
- `ctx.db` is a real Drizzle database typed by the user's schema; the only difference is our driver underneath.

### D3 — the read-set comes from the SQL at the driver, parsed by libpg-query
Every statement a query handler runs passes the driver as `(sql, params)`; that covers the select builder,
relational queries, `db.execute`, `sql.raw` and prepared statements alike (P1). Operators are not typed in
Drizzle (F1), so analysis runs on the SQL, using libpg-query (F4). Drizzle is used only for metadata (columns,
types). The parse is cached by SQL text (params vary, text repeats). Name resolution follows Postgres (F3).

### D4 — tiers, and the widening rule
Per table scan: **INTERVAL** (bounds on columns from constants/params), **DYNAMIC** (column ∈ keys of a preserved
source, F2), **PREDICATE** (a single-scan predicate the evaluator can compute), **KEYQUERY** (column ∈ keys of a
non-preserved source), **TABLE**. Anything not understood is DROPPED from the conjunction — dropping widens.
A query that reads a **view, a set-returning or user SQL function, a foreign table**, or whose SQL does not
parse, is **OPAQUE**: invalidated by any committed change, with a log warning naming the query. Reason: a
regex over names cannot see what a view or function reads.

### D5 — join keys: a side query inside the query's own transaction (v1)
Both DYNAMIC and KEYQUERY scans get their key set from a key query run **inside the same REPEATABLE READ
transaction** as the handler, so the keys belong to the same snapshot as the result. Reading keys from the
result (cheaper, possible only for DYNAMIC) is a later optimisation, gated by P3's `keyMismatch` check.
Cost: one extra statement per join edge per run; measured before DZB-01 closes (bench §6).

### D6 — change evaluation
A committed change (table, OLD image, NEW image) invalidates a subscription iff, for some scan of that table,
OLD or NEW satisfies the scan's bounds, predicates and key membership. The evaluator implements SQL 3-valued
logic for the operators P1 met (comparisons, IN, BETWEEN, IS [NOT] NULL, LIKE/ILIKE, AND/OR/NOT, + − * /,
lower/upper/coalesce, `= any`). Values are decoded by the column's type OID from the stream's relation
metadata. **Any type or operator outside a tested allow-list answers MAYBE (= match).** Text comparisons other
than equality answer MAYBE unless the column's collation is `C` (JS code-unit order equals C only).

### D7 — aligning a subscription with the stream: the xid-visibility rule
A query runs as `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_current_snapshot(); …handler…;
COMMIT`. A streamed transaction is already reflected iff its xid is visible in that snapshot
(`xid < xmin`, or `xid < xmax` and not in `xip`). Registration: insert the read-set into the index and, with
**no await in between**, scan the recent-commits buffer for transactions NOT visible in the snapshot that
touch it → the subscription is dirty from birth. The buffer keeps transactions whose xid ≥ the smallest
`xmin` among queries in flight. The stream's 32-bit xid is widened to xid8 against the current epoch (tested
near wraparound). P4: 0 misses; the LSN-after-query rule misses ~10 %.

### D8 — consistent transitions: one exported snapshot per flush cycle
A flush cycle re-runs every dirty query at **one** snapshot: an exporter transaction runs
`pg_export_snapshot()`, each re-run does `SET TRANSACTION SNAPSHOT`, and the client receives the batch
tagged with one position. Two queries on one screen never show different points in time (Convex's guarantee).
The exported snapshot is also the snapshot D7 registers against.

### D9 — mutations: SERIALIZABLE, retried, read-your-writes
`BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT pg_current_xact_id(); handler; COMMIT`. 40001/40P01 → bounded
retry with backoff (handlers must be safe to repeat, as in Convex). The mutation captures nothing itself: its
writes arrive through the stream like anyone's (invariant 2), cascades and triggers included — the place
RETURNING failed in P2. The reply to the client waits until the stream has passed its xid AND the flush it
caused has been sent. If the stream stalls past a deadline the reply is a distinct error, *committed,
confirmation pending* — never "failed".

### D10 — the query cache
Key `(function, canonical args)` (auth scope joins the key when auth lands). One entry per key, shared by
every subscriber; invalidation marks it dirty and the flush re-runs it once. A query whose SQL contains a
non-deterministic function (`now`, `random`, `clock_timestamp`, `gen_random_uuid`, `current_*`) is not
cached and is re-run only when its read-set is touched; v1 has no timer-driven re-run and logs a warning.

### D11 — single node
One process, one slot. Multi-node (a stream fanned out to several servers, or a slot per node) is a later spec.

### D12 — stream transport (v1): polling the slot with pgoutput
`pg_logical_slot_get_binary_changes(slot, NULL, n, 'proto_version','1','publication_names', …)` on a short
interval. pgoutput sends relation metadata (type OIDs), explicit NULLs (F6 does not arise), and is the
production plugin. No replication-protocol client is needed in v1 (Bun has none). Streaming replication
(lower latency, no polling) is an alternative the reviewers should weigh; losing buffered changes on a crash
costs nothing, because every subscription lives in memory and clients re-run on reconnect.

### D13 — the driver, the pool, and the post-migrate step
- `ctx.db` = `drizzle-orm/bun-sql` over a wrapped, reserved Bun.sql connection per function run, which pins the
  transaction and records `(sql, params, rows)`. To verify in phase 1: which client method the official driver
  calls; fallback is a `pg-proxy` callback (P1 used it; it breaks `$count`'s row shape).
- Internal statements (snapshot, stream, key queries) use Bun.sql directly.
- Post-migrate step (after drizzle-kit): `REPLICA IDENTITY FULL` on every app table, publication and slot
  ensured, then **recycle the pool and invalidate everything** (F7).
- Boot is fail-closed: `wal_level=logical`, the slot, the publication, and REPLICA IDENTITY FULL on every
  table the schema declares; any missing → refuse to start, naming it.

### D14 — failure modes (fail closed: widen or refuse, never serve stale silently)

| Failure | Response |
|---|---|
| view / function / foreign table / unparseable SQL | OPAQUE (D4) |
| change without an OLD image (a table lost REPLICA IDENTITY FULL at runtime) | invalidate every subscription on that table; warn |
| slot invalidated, stream error, or a gap in the stream | drop every subscription; clients re-run; recreate the slot |
| DDL observed (relation metadata changed in the stream) | recycle the pool; invalidate everything |
| serialization retries exhausted | error with the Postgres code |
| mutation committed, stream stalled | *committed, confirmation pending* |
| recent-commits buffer | bounded by the oldest in-flight query snapshot (D7) |

### D15 — the invariants
1. **Never under-invalidate.** Unknown widens (D4, D6). The oracle is a permanent property test.
2. **Every committed write reaches subscriptions through the stream**, whatever wrote it.
3. **A cached query is a pure function of (args, snapshot)** (D10).
4. **A transition is consistent**: everything pushed in one batch reflects one snapshot (D8).

## 3. Data flows

**Subscribe.** cache hit (clean) → attach. Miss → reserved connection → RR read-only transaction →
`pg_current_snapshot()` (or the cycle's exported snapshot) → handler, every statement captured → read-set
extracted → key queries (D5) in the same transaction → COMMIT → register + buffer scan with no await (D7) → push.

**Change.** Slot → decode → per transaction, in commit order: widen xid, append to the buffer, for every row
find candidate subscriptions through the index (table → column → bounds; predicate and opaque lists), evaluate
OLD/NEW (D6), mark dirty. Flush cycle: export a snapshot, re-run the dirty set (deduped by cache key), push
what changed, as one batch per client (D8).

**Mutation.** SERIALIZABLE transaction → retry loop → commit → wait for the stream to pass the xid and the
resulting flush → reply (D9).

## 4. Phases (each one a branch, a PR, a final reviewer)

| Phase | Content | Done when |
|---|---|---|
| **DZB-01a** | Extractor on libpg-query (the P1 corpus as fixtures, ≥ 76 cases) + the evaluator (D6) + the read-set oracle on a real PG 18 with the snapshot diff as truth | P3's result reproduced on libpg-query; sabotages red |
| **DZB-01b** | The driver (D13): the wrapped Bun.sql under `drizzle-orm/bun-sql`, RR/SERIALIZABLE transactions, capture of `(sql, params, rows)`, key queries (D5) | The corpus runs through `ctx.db`; the bench of Drizzle vs raw Bun.sql |
| **DZB-01c** | The stream (D12): pgoutput decoding, xid widening, the buffer, the post-migrate step and the boot checks | P2's equivalence harness green against the pgoutput stream |
| **DZB-01d** | Subscriptions: the index, registration (D7), the flush cycle with an exported snapshot (D8), the cache (D10) | P4's race harness green; the flush-consistency property green |
| **DZB-01e** | Functions, the WebSocket protocol and the React client (quarried from minivex), mutations with read-your-writes (D9), a demo app edited live from Drizzle Studio | End-to-end: a Studio edit re-pushes a `with` query in the browser |

## 5. Tests (every property has a sabotage that must turn it red)

| Property | Sabotage |
|---|---|
| read-set soundness: result changed ⇒ invalidated (oracle, per corpus case, ≥ 3 seeds) | inner-join keys from the result; `>=` evaluated as `>`; drop the old image |
| capture ⊇ snapshot diff (cascade, user trigger, TRUNCATE, rollback, pk move, upsert) | skip TRUNCATE; skip one table |
| subscribe race: 0 misses under concurrent writers | treat `xip` as visible |
| flush consistency: a batch equals re-running all its queries at the batch snapshot | re-run one query outside the exported snapshot |
| read-your-writes: the reply arrives after the affected pushes | reply at commit |
| faults: kill the stream, invalidate the slot, ALTER under a warm pool, drop REPLICA IDENTITY — no stale value served | remove each guard in turn |
| xid widening across the 2^32 boundary | widen without the epoch |

A case reported `changed = 0` is VACUOUS, never sound.

## 6. Benchmarks (before DZB-01 closes)
- Reactive latency: commit → push, p50/p99, at 1/100/1 000 subscriptions.
- Write throughput with and without the slot + REPLICA IDENTITY FULL, on wide tables (P2 used a narrow one).
- Drizzle overhead: raw Bun.sql vs builder vs `.prepare()` vs relational query (the owner's question).
- Cost of D5's key queries on the relational corpus; decides whether reading keys from the result is worth it.
- Polling interval of D12 vs latency and idle CPU.

## 7. Risks and open questions for the reviewers
1. **libpg-query under Bun** (WASM or native) — load time, parse cost, and whether it runs where we deploy.
2. **Re-run cost** dominates at scale, as in minivex: a flush re-runs whole queries. Incremental maintenance
   (IVM) is out of scope; is anything in D4–D8 hostile to adding it later?
3. **D8's exported snapshot** holds a transaction open for the length of a cycle; a slow re-run delays every
   subscriber in the cycle. Bound it, or split cycles?
4. **D5's key queries** can form chains (comments ← posts ← users); every link is a statement. Is there a case
   where the chain is not a DAG?
5. **REPLICA IDENTITY FULL on wide/TOASTed tables**: WAL volume and decoding cost; unchanged TOAST values in
   pgoutput (`u` marker) need the old value — does FULL guarantee it for every case?
6. **D6's evaluator vs Postgres semantics**: numeric, timestamptz, collations, arrays, jsonb operators.
   The allow-list must be tested against Postgres itself, not against our reading of the docs.
7. **Managed Postgres**: logical replication availability and slot limits (Neon, Supabase, RDS, and minivex's
   own tenants cluster).
8. **Drizzle versions**: v1 relational queries (0.45) vs RQB v2 (1.0 beta) emit different SQL; the extractor
   must not care, but the corpus should cover both.
