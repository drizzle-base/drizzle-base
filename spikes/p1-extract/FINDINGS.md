# P1 — extraction spike (THROWAWAY code; the findings are the output)

Run: `bun capture.ts` (SQL per case) · `bun report.ts` (read-set per case). drizzle-orm 0.45.3, pgsql-ast-parser 12.0.2.

76 cases (single, join, agg, subquery/CTE, RQB v1, raw sql, set ops, writes).

## Result
- 54 fully precise (every scan INTERVAL / DYNAMIC / PREDICATE)
- 14 read a whole table — mostly CORRECT as such (no where, distinct, groupBy over all, findMany without where);
  imprecise by our limitation only: G03/G04 (parser), D04 (filter over a derived aggregate)
- 6 KEYQUERY (inner join / EXISTS / IN-subquery / right join): keys not all in the result → side query or TABLE
- 2 non-deterministic (now(), random()) → uncacheable / time-driven

## Findings
1. Capture point = the drizzle DRIVER (pg-proxy here): every API (builder, RQB, db.execute, prepared/placeholder)
   passes through it as (sql, params). No wrapper per API needed.
2. Drizzle operators are NOT typed nodes: eq() = sql`${a} = ${b}` (sql/expressions/conditions.js). The builder
   AST knows the leaves (Column/Param), not the operator → analyse the emitted SQL, use Drizzle only for metadata.
3. DYNAMIC keys from the result are sound ONLY when the source side is preserved (left side of LEFT JOIN, the
   RQB parent via `left join lateral … on true`) and no WHERE tests the nullable side. Inner join → keys missing
   → under-invalidation. First version of this analyzer had that bug.
4. Inside sql`` in a single-table select, drizzle drops the table qualifier: `${users.id}` in a scalar subquery
   over posts becomes "id" and Postgres binds it to posts.id (D05). The analyzer must resolve names exactly as PG.
5. pgsql-ast-parser does not parse INTERSECT/EXCEPT → use libpg-query (the real PG parser).
6. Writes: UPDATE/DELETE … WHERE give the touched set only as a PREDICATE; the actual rows need RETURNING/trigger (P2).
7. The read-set does not have to be an index interval: invalidation tests the changed row's OLD and NEW image
   against the predicate. So PREDICATE (like, lower(), arithmetic) is as exact as INTERVAL IF the JS evaluator
   matches PG semantics — or answers "maybe" (invalidate) whenever unsure. Needs full row images from capture.

# P3 — the soundness oracle (`bun oracle.ts [--steps --seed --only --sabotage=inner|gte|leftjoin]`)

PGlite (isolated, in-process PG). Per case: anchored random seed, then N random writes (insert / update of
random columns / primary-key move / delete) on small domains. Changes come from DIFFING table snapshots
(to_json), not from the write we issued. Property: result changed ⇒ some OLD or NEW image of a changed row is
in the read-set computed BEFORE the write. `changed=0` is reported VACUOUS, never "sound".

## Result (3 seeds × 1000 writes × 62 read cases)
- 0 violations. Vacuous: C02 ($count — the proxy harness serves array rows, $count wants objects). Skipped:
  F02/F03 (nondeterministic), D05 (drizzle's unqualified column makes it `uuid = integer` → PG error),
  F06 (my case was invalid: drizzle renders a JS array as a list, `any(($1,$2))`).
- Sabotages (each MUST go red): `inner` (keys from the result on an inner join — the P1 bug) → 10 violations
  (B05, B08); `gte` (>= evaluated as >) → 25 (D03); `leftjoin` (DYNAMIC degraded to a side query) → 0, as
  predicted: sound, only costlier.
- Useless invalidations (invalidated, result unchanged), all seeds: precise 10 % · DYNAMIC 0 % ·
  KEYQUERY 26 % · whole-table 32 %.

## What this does NOT prove yet
- Concurrency: the write racing the query's execution/registration (minivex solves it with a snapshot seq).
- The capture: the oracle uses an ideal diff. P2 must deliver the same OLD/NEW images (trigger / RETURNING).
- Keys from the result only for ROOT sources with the key projected; nested DYNAMIC (E03 comments) and keys
  inside RQB json fell back to side-query keys. Result-key extraction from json is untested.
- Semantics outside ASCII/UTC: collation (text ranges, ILIKE on non-ASCII), timestamptz, numeric, jsonb.
- The limit-tightening refinement (bound by the last row) is not implemented.
