# P2 — write capture (THROWAWAY code; the findings are the output)

PG 18.6 in its own container (`drizzlebase-pg18`, 127.0.0.1:5477, wal_level=logical; password generated
into `.env`, never in code). Scripts: `equiv.ts` (correctness), `bench/run.sh` (cost), `consumer.ts` (ordering).

## Correctness — capture ⊇ snapshot diff (`bun equiv.ts --method=…`, 1500 random writes × 2 seeds)
Writes: single-row, multi-row, FK cascade (delete AND pk move), a user trigger writing another table, upsert,
TRUNCATE, rolled-back transaction, two-statement transaction.

| method | steps with a missed image |
|---|---|
| row trigger → outbox (+ truncate trigger) | 0 |
| statement trigger, transition tables (+ truncate trigger) | 0 |
| logical decoding (test_decoding, REPLICA IDENTITY FULL) | 0 (after the parser fix below) |
| RETURNING OLD/NEW on the mutation path | ~11 % — cascade, user trigger, truncate |

- RETURNING cannot see what the statement did NOT name (cascade children, a trigger's writes, TRUNCATE) —
  and never sees Studio/psql writes. It also must buffer until COMMIT (a rollback returned rows too).
- test_decoding omits NULL columns from the old tuple; the table's column list restores them (pgoutput sends
  them explicitly). Found as 8 "misses" that were my parser.
- Sabotage: without the TRUNCATE trigger the row method misses 12 steps → the harness catches a loss.
- Transition tables do not pair old↔new rows; invalidation does not need pairing (old OR new is tested).

## Cost — pgbench inside the container, 3 interleaved rounds × 6 s (tps, avg; the Mac had load ~4/8 cores: noisy)

| workload | none | row trigger | stmt trigger | RETURNING | logical |
|---|---|---|---|---|---|
| update by pk (8 clients) | 18 411 | 10 729 (−42 %) | 12 203 (−34 %) | 17 519 (−5 %) | 19 927 (≈) |
| insert (8 clients) | 17 993 | 14 199 (−21 %) | 14 423 (−20 %) | 20 889 (≈) | 22 337 (≈) |
| update 1 000 rows (4 clients) | 696 | 120 (−83 %) | 164 (−76 %) | 304 (−56 %) | 768 (≈) |

- "none" already runs with wal_level=logical, so the logical column shows the SLOT + REPLICA IDENTITY FULL
  cost on writers: within noise. Its cost moves to the reader: ~290 k changes/s decoded (test_decoding).
- The outbox is also storage + a delete/vacuum the consumer pays: 750 k–1 M rows ≈ 230–300 MB per round
  (row), 1.8–2.4 M rows ≈ 350–470 MB (stmt: two rows per updated row).

## Ordering — can the consumer miss an outbox row? (`bun consumer.ts`, 8 writers, 8 s, 2 runs)
- naive cursor `id > last`: missed 2 797 / 5 023 and 2 736 / 4 928 (bigserial is assigned at insert, commits
  land out of order).
- xid8 cursor (read `xid >= lo AND xid < pg_snapshot_xmin(pg_current_snapshot())`, then lo = xmin): 0 missed,
  0 duplicates. Price: a long transaction holds xmin back and delays EVERY invalidation behind it.
- Logical decoding delivers in commit order natively (LSN) — this whole problem does not exist there.

## Portability (the owner's "other Drizzle databases" goal)
- row triggers: PG, MySQL, SQLite all have them (MySQL/SQLite lack statement triggers and transition tables).
- RETURNING OLD: PG 18 only (MySQL has no RETURNING; SQLite's has no OLD).
- logical decoding: PG only (MySQL has the binlog, SQLite nothing) and needs wal_level=logical + a slot per
  database; a stalled consumer retains WAL until the disk fills.

# P4 — the subscribe race (`bun race.ts [--trials --gap --sabotage=xip]`)

A subscription runs its query at snapshot S1 and must react to every streamed transaction NOT reflected in
S1. Judge: S2 re-runs the query later; if R1 ≠ R2, some transaction visible in S2 that the rule reacted to
must touch the query's rows. Query is `where k = X` (precise) so only the race is measured. Logical decoding
stream, 6 writers with a sleep inside each transaction, 900 trials, gap 60 ms between a writer's commits.

| rule | missed |
|---|---|
| A — LSN read AFTER the query, react to commit-LSN > lsn | 19 / 199 changed results (~10 %) |
| A' — LSN read BEFORE the query | 0 / 190 |
| B — react iff the xid is NOT visible in S1's `pg_current_snapshot()` | 0 / 179 |
| B with sabotage `xip` (in-progress txns treated as visible) | 3 / 166 → the judge catches it |

- A' stayed at 0 even with `commit_delay = 20 ms`: `pg_current_wal_lsn()` is the WRITE position, which is
  behind a commit record waiting for its flush. A' is correct only by that internal ordering, which Postgres
  does not promise; synchronous replication waits for the standby AFTER the flush and BEFORE the transaction
  leaves the in-progress list — a wide window we cannot test without a standby. B is Postgres's own
  visibility rule. Recommendation: B.
- B's two obligations, both design work:
  1. the server keeps recently streamed commits and replays, at registration, those whose xid is not visible
     in S1 (the streamer may have passed them before the subscription registered);
  2. logical decoding gives a 32-bit xid, the snapshot gives xid8: the epoch must be reconstructed
     (wraparound), or the stream must carry xid8.
