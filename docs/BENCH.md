# drizzle-base — measurements

Every performance claim in a spec or a commit points here. A row names the machine, the date, the command,
and what the number measured (which branch of the code it exercised). Re-measure before quoting an old row.

## Capture (DZB-01a-1, 24 Sep 2026, MacBookPro18,3, 8 CPU, load avg ~4 (shared Mac), Postgres 18.6 in Docker)

| Case | p50 ms | p99 ms | Command |
|---|---|---|---|
| commit → onEvent, idle (500 inserts) | 0.50 | 1.52 | `bun --preload ./test/support/env.ts load/capture/stream_latency.ts` |
| one open transaction pinning the slot + 400k-row noise, step 0 | 0.57 | 9.23 | same |
| same, step 1 | 0.63 | 2.17 | same |
| same, step 2 | 0.51 | 1.90 | same |

The open-transaction rows are the case that made slot polling cost 41 → 204 ms per poll (review B,
`spikes/review-b/poll_cost.txt`); streamed, the latency does not grow with the WAL behind the slot.

| REPLICA IDENTITY | tps, rounds 1/2/3 (8 clients, 6 s) | WAL in 6 s, rounds 1/2/3 | Command |
|---|---|---|---|
| DEFAULT | 19 503 / 20 030 / 21 116 | 64 / 66 / 67 MB | `bash load/capture/wide_identity.sh` |
| FULL | 12 423 / 15 636 / 13 665 (−22 … −36 %) | 651 / 804 / 711 MB (10–12×) | same |

What it measured: PgoutputCapture end to end (walsender → assembler → handler), acknowledgement after the
handler, barriers flushed. The wide table is review B's (`spikes/review-b/wide_setup.sql`): 20 columns,
4 indexes, 2 KB jsonb, 6 KB TOAST, 20 000 rows; the workload updates one counter by primary key. FULL's cost
is the old tuple logged with its TOAST detoasted (spec P-M9; O2 files a per-table DEFAULT opt-out).

## Barrier latency (DZB-01a-1, same machine)

| Barrier | median of 20, quiet database | Where |
|---|---|---|
| `pg_logical_emit_message(false, …)` | 181 ms | `test/capture/integration/pgoutput.test.ts` "a barrier arrives promptly…", before the fix |
| same with `flush = true` | < 50 ms (the test's bound) | after the fix |

## Drizzle overhead and the runtime (DZB-01a-2, 25 Sep 2026, same machine, load avg ~2.5)

Sequential latency, one call at a time, 3 000 calls per cell after 200 warm-up calls, two interleaved rounds.
Command: `bun --preload ./test/support/env.ts load/runtime/drizzle_overhead.ts` (1 000 users, 3 000 posts; select by primary key).

| Variant | p50 ms (r1 / r2) | p99 ms (r1 / r2) | ops/s (r1 / r2) |
|---|---|---|---|
| Bun.sql tagged template | 0.339 / 0.348 | 0.498 / 0.543 | 2 892 / 2 770 |
| Drizzle builder | 0.355 / 0.362 | 0.568 / 0.690 | 2 748 / 2 612 |
| Drizzle `.prepare()` | 0.342 / 0.346 | 0.715 / 0.676 | 2 759 / 2 763 |
| Drizzle relational (`with: { posts }`) | 0.516 / 0.626 | 0.954 / 1.191 | 1 829 / 1 516 |
| `runtime.runQuery` (builder) | 1.427 / 1.423 | 2.810 / 2.762 | 660 / 665 |
| `runtime.runQuery` (relational) | 1.699 / 1.704 | 3.619 / 3.207 | 549 / 553 |

What it measured: the Drizzle builder costs ~3–5 % over raw Bun.sql and `.prepare()` erases it; the relational
query's extra cost is its SQL (`left join lateral` + `json_agg`), not JavaScript. The runtime rows add a reserved
connection, `BEGIN … READ ONLY`, `pg_current_snapshot()`, `COMMIT` (three extra round trips) plus the parse gate
and the read-set, with the parse and catalog caches warm. Folding BEGIN and the snapshot into one round trip is
the obvious next step when the runtime's latency matters (not taken in 01a-2).
