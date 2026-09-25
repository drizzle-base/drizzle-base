# DZB-01 — the foundation: reactive Drizzle on Postgres

> **v1, BEFORE review.** Written 24 Sep 2026 from four probes whose code lives in `spikes/` (throwaway; the
> findings are the record). This changes nothing that exists — it defines the kernel of a new project — but it
> IS kernel and consistency work, so it takes the reinforced ritual: two independent adversarial reviews of this
> document (A: correctness/concurrency, B: strategy/performance), a POST-REVIEW DECISION block, and a final
> reviewer on every implementation phase. No code outside `spikes/` before that block exists.

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
