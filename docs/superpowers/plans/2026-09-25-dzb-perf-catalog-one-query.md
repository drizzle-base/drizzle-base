# DZB-PERF-CATALOG — one catalog query per run, one Catalog per cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove most of the latency the per-run catalog added in 01a-3. The measured cost was +2 ms per fresh
run (builder) and +5 ms (relational), from `docs/BENCH.md`. The read-set must stay exactly the same.

**Architecture:**
- **A:** `Catalog.prefetch()` resolves every relation, function and operator named by a run's statements in ONE
  statement and fills the existing memo. `buildReadSet` is unchanged and reads from the memo.
- **B:** the subscription cycle gives all its lanes one `Catalog`: same exported snapshot, same search_path key.

**Spec:** `docs/specs/DZB-01-foundation.md`, POST-REVIEW block, "DZB-01a-3 review" (the deferred performance item).
The kernel invariant that must not move is invariant 1: never under-invalidate. Anything not understood widens.

## POST-REVIEW DECISION (plan review, 25 Sep 2026: FIX-FIRST, the design holds; supersedes the body below)

| Finding | Decision |
|---|---|
| C1: the equivalence corpus compares one statement at a time, so the cross-name bugs a batch introduces cannot show | Test 1 runs **multi-name statements in one fresh Catalog**. Same name with `only` both true and false; three families in one statement; a two-level partition (`events_2` → `events_2a`) and inheritance (`dogs` → `puppies`) read at middle and leaf; one oid reached by two keys (`users` bare on a `dzb_app` search_path, plus `dzb_app.users`); quoted `"MixedCase"` and `"a.b"`; a sequence (relkind S); `dzb_app.lower` vs built-in `lower` under two search_paths; an operator `===` in a second schema, qualified and bare; `BETWEEN`. Sabotages: carry `i` in `up` only; group functions by name only; pass the unquoted name; ignore `only` |
| I1: storing results only after the batch returns means concurrent lanes each issue their own batch, so B gains nothing | `prefetch` inserts a pending deferred for every missing key **synchronously, before its first await**. Test 3 counts catalog **statements** across a 4-lane cycle and expects 1 (sabotages: store-after-resolve; a Catalog per lane) |
| I2: an unguarded `catch → delete` can evict another writer's entry | Delete only if the map still holds that promise, in both paths |
| I3: key mismatches show only for the forms test 2 exercises; `schema ""` vs `null` | Keys come from shared helpers used by both paths. Test 2 names qualified and bare forms of each kind and `only` true and false: 1 statement, then 0. The batch treats schema by the same truthiness as the per-name SQL (`schema \|\| null`) |
| I4: the comments and the spec say "within one run" | Rewritten: memoised within one cycle's shared snapshot. Why this is safe: the lanes import the same snapshot, the catalog SQL reads through it, and a DDL after S is re-dirtied by the replay |
| M1: the search_path text omits the backend's `pg_temp_N` | The key is `current_schemas(true)::text` (it includes the active temp schema) in `runQuery` and `runInSnapshot` |
| M2: a failed catalog statement aborts the lane's transaction (25P02 on the next savepoint) | Deferred: the granularity is unchanged from today, and the failure widens (safe) |
| M3: an empty key set must issue no statement | `select 1` in test 2 expects 0 |
| M4: no hardcoded suite count | Accepted |
| Also found while planning | `json_agg` without ORDER BY can return members in a different order on each path, and the order of the `opaque` reasons follows it. Both loaders order members by name and ancestors by name, so the results are deterministic |

## Why this shape (options weighed)

| Option | Round trips per fresh run | Correct by construction | Cost to build |
|---|---|---|---|
| Today: one query per name | N (3–10) | yes | — |
| **A: one query for all names of a run** | 1 | yes: same snapshot, same connection, same search_path | a batched query |
| B: one Catalog per cycle, across lanes | 1 per cycle instead of 1 per lane | yes: lanes share the exported snapshot | trivial |
| C: cross-run cache, invalidated by the DDL stream | ~0 | only with a careful generation protocol (the 01a-3 poisoning class) | a spec of its own |

A + B now. C only if a measurement after A still asks for it.

Market check: Drizzle has no read-set. Convex resolves tables from its own typed schema and has no SQL catalog to
query. PostgREST keeps a schema cache reloaded on a DDL `NOTIFY`; that is C's shape, and PostgREST accepts a stale
window, which we cannot.

## Decisions

- **D1.** `Catalog.prefetch(refs: readonly Refs[], exec: SQL, searchPath: string): Promise<void>`:
  - It collects the relation, function and operator keys not yet in the memo (the same key strings the per-name
    methods use) and resolves them in one statement.
  - It stores each result as a resolved promise under its key, so later `relation()`, `fn()` and `operator()`
    calls are memo hits.
  - A key the statement returns nothing for is stored as `null`, which is exactly what the per-name loaders
    return for "not found".
  - If the statement fails, `prefetch` rejects and stores nothing. The caller behaves as it does today when a
    lookup throws: `runQuery` fails, and `runInSnapshot` widens that call to OPAQUE.
- **D2.** The batched statement takes one `jsonb` parameter: `JSON.stringify` of
  `{rels:[{i,name,only}], fns:[{i,name,schema}], ops:[{i,name,schema}]}` (probed: Bun does not encode an array of
  objects; text cast to jsonb works). It returns three json columns.
  - **Relations:** the same recursive walk as `loadRelation`, carrying the input index `i` through `up`, `down`
    and `scanned`, so every name's family stays separate. `to_regclass(name)` runs per name. Only the names
    `to_regclass` resolves produce a row; a missing one means null.
  - **Functions and operators:** the same predicates as `loadFunction` and `loadOperator`, joined against the
    input rows. A missing `schema` means `current_schemas(true)`. The JS side keeps the same reduction: any
    overload outside pg_catalog means user; any non-immutable overload means volatile.
- **D3.** `readSetOf` collects `collectRefs` for every statement, calls `prefetch` once, then runs the existing
  loop. `buildReadSet` does not change, so the per-name path stays the reference.
- **D4.** `Runtime.runInSnapshot(snapshotId, calls, catalog?)` takes an optional `Catalog`. The engine creates one
  per cycle and passes it to every lane.
  - Memo keys already include the search_path.
  - A lane that awaits a promise another lane started waits on that lane's connection, not on a new one, so
    there is no pool deadlock (the 01a-2 lesson).
  - If that lane's statement fails, the waiting lane's read-set widens to OPAQUE, as today.

## Tests (each with its sabotage)

1. **Equivalence (the property).** In `test/readset/integration/readset.test.ts`, a new test runs a corpus that
   covers every shape the existing tests cover, plus mixed statements with several relations, functions and
   operators. For each statement it compares `readSetOf([stmt], new Catalog)` (prefetch) against
   `buildReadSet(..., new Catalog)` (per name), and they must be deep-equal.
   - The corpus: quoted tables, a view, an RLS table, an unpublished table, an unknown table, a user function,
     volatile and immutable functions, a partition leaf and root, an inheritance parent, `ONLY`, a CTE shadow,
     SQL executors, user and built-in operators, and the two single-member publications.
   - Sabotages, one at a time; each must turn the test red:
     - drop the `only` handling in the batch (`scanned` ignores `only`);
     - drop the ancestors column;
     - return `user: false` for every function.
2. **One round trip.** `readSetOf` over one statement naming 3 relations, 2 functions and 1 operator, through a
   counting proxy of the connection:
   - a fresh `Catalog` issues exactly 1 catalog statement;
   - a second call on the same `Catalog` issues 0.
   - Sabotage: skip `prefetch` → 6 statements, red.
3. **One Catalog per cycle.** Four subscriptions on four lanes; count the distinct `Catalog` instances whose
   `prefetch` ran during one cycle (a prototype spy, installed after the subscribes). Expect 1.
   - Sabotage: `runInSnapshot` ignores the argument and creates its own → 4, red.
4. The existing suite passes unchanged: 168 tests plus the new ones.

## Bench

- Re-run `load/runtime/drizzle_overhead.ts`, interleaved A/B against `main`, in the same session.
- Re-run `load/subscriptions/reactive_latency.ts`.
- Record the delta in `docs/BENCH.md` next to the 01a-3 rows (invariant 5: before and after).
- Expected: `runQuery` goes from about 4 / 7.5 ms back to about 2 ms. If A/B shows no gain, it does not land.

## Risks

- **A batched query that is subtly different from the per-name one** (index carried wrong, a family merged
  across names). This is under-invalidation risk; test 1 is the guard, and its sabotages must prove it.
- **Payload size.** Statements naming hundreds of relations produce one bigger query. That is fine: still one
  round trip.
- **The CTE-shadow case.** `buildReadSet` decides it from `info === null` and `refs.cteNames`; prefetch stores
  null for an unresolved name, exactly like the loader.

## Measured during implementation (25 Sep 2026) — A does not pay as designed

A/B interleaved (`load/runtime/drizzle_overhead.ts`, `runtime.runQuery` p50, two rounds; load avg ~3.6):

| Variant | prefetch (A) | per-name |
|---|---|---|
| builder | 5.51 / 4.98 ms | 4.20 / 4.34 ms |
| relational | 6.30 / 5.96 ms | 7.69 / 7.34 ms |

The premise was wrong. The cost is not the round trips; it is **planning**. The pool never prepares
(`prepare: false`), so every catalog statement is re-planned:
- the batch plans in 1.0–1.5 ms and executes in 0.64 ms (EXPLAIN ANALYZE);
- a per-name relation lookup is 1.6 ms against a 0.36 ms round trip.

Probes:
- Bun has no per-query `prepare` option.
- `EXECUTE name($1, $2)` cannot take bind parameters: Postgres does not pass protocol parameters to utility
  statements.
- `PREPARE` over the extended protocol reads the body's `$1` as a protocol parameter, so it must be sent with
  `.simple()`.
- A server-side `PREPARE` of the batch, then `EXECUTE` with the payload as a dollar-quoted literal, returns the
  identical result: **0.94 ms**, against 2.44 ms planned each time.

Status: correctness is done and tested (equivalence per name and per statement, 12 sabotages red; one statement per
run; one Catalog per cycle). The performance goal is not met. The next step is the owner's call (see the chat of
25 Sep).

## Extension E (owner's go-ahead, 25 Sep 2026): the batch prepared once per connection

- **E1.** `Catalog.prefetch(refs, exec, schemas, prepared?: { ready: boolean })`.
  - With a state object, the batch runs as `EXECUTE dzb_catalog_<hash of its text>(<payload>, <publication>)`,
    after a one-time `PREPARE` on that connection when `ready` is false. The state becomes ready after the
    `PREPARE`.
  - Without a state object, the batch is planned each time, as now.
  - Both `PREPARE` and `EXECUTE` go over the simple protocol. `EXECUTE` cannot take bind parameters, and an
    extended-protocol `PREPARE` would read its body's `$1` as a protocol parameter.
- **E2.** The payload and the publication name are embedded as dollar-quoted literals.
  - The tag is `dzb_<random hex>`, regenerated until `$tag$` does not occur in the text, so the literal cannot be
    closed early.
  - It does not depend on `standard_conforming_strings`: dollar quotes have no escapes.
  - This is SQL built by string, accepted by the owner. `dollarQuote()` is the only way in, and it is tested with
    adversarial text, round-tripped through Postgres.
- **E3.** The runtime learns whether the connection is ready from the first statement it already sends: `exists
  (select 1 from pg_prepared_statements where name = $1)`, so no extra round trip. `runQuery` and every lane of
  `runInSnapshot` pass the state object. A prepared statement survives a rollback (probed), and it lives as long
  as the connection. The name carries a hash of the SQL, so a changed batch never reuses an old plan.
- **Tests.**
  - The equivalence corpus runs on the prepared path too, the first run preparing and later ones executing.
  - The corpus adds tables named `a$q$b'c` and `$dzb_x$`.
  - A fresh connection issues PREPARE plus EXECUTE, and after that EXECUTE only.
  - Two `runQuery` calls on a one-connection pool both succeed, because a second PREPARE would fail with 42P05,
    and the statement is listed in `pg_prepared_statements`.
  - `dollarQuote` round-trips adversarial strings through Postgres.
  - Sabotages:
    - a fixed tag (the `$q$` table breaks);
    - the runtime always reporting not ready (the second `runQuery` fails);
    - `EXECUTE` of the wrong payload (the equivalence corpus fails).
- **Lands only if** the A/B shows a gain over per-name lookups on both the builder and the relational query.
