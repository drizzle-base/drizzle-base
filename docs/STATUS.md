# Status — where drizzle-base stands

> Updated 25 Sep 2026. The single place that says what is done, what is in progress and what comes next.
> Update it in the same PR that closes a phase (CLAUDE.md, "Record"). Decisions and their reasons live in the spec
> and the plans; this file points to them and does not repeat them.

## Read first

1. [`CLAUDE.md`](../CLAUDE.md): invariants, the process every phase follows, test-honesty rules, and paid lessons.
2. [`docs/specs/DZB-01-foundation.md`](specs/DZB-01-foundation.md): read the **POST-REVIEW DECISION** block and the
   per-phase review records under it before the body. They supersede the body, and they list every deferred item.
3. The plan of the phase you are about to touch, in [`docs/superpowers/plans/`](superpowers/plans/).

## How work happens

- One branch per phase (`feat/…`, `fix/…`, `docs/…`, `ci/…`). Push it, open a PR, wait for **CI green**, then
  hand the owner the link. **The owner merges.**
- Every phase, scaled to its risk: study → plan → an adversarial review of the plan → TDD with a sabotage per
  property → a fresh final reviewer on the branch → PR.
- Parallel sessions work on this repository. Before asking to merge, check whether `main` moved; if it did, merge
  `main` into the branch and run the tests again.
- Chat with the owner in **pt-BR**. Everything in the repository is in English.

## Done

| Phase | What | Record |
|---|---|---|
| Probes P1–P4 | read-set extraction from SQL, capture options, the xid-visibility rule | `spikes/*/FINDINGS.md`, spec §1 |
| DZB-01 spec | the foundation, reviewed twice | spec, POST-REVIEW block |
| 01a-1 | streaming capture (pgoutput over the walsender), barriers, DDL signal | plan `…01a-1-capture`, spec review block |
| 01a-2 | the driver gate, the table-level read-set, the function runtime | plan `…01a-2-runtime`, spec review block |
| Layout, tooling | one package with public subpaths and enforced module boundaries; Biome, strict TS, pre-commit | plan `…layout-single-package`, `docs/ARCHITECTURE.md` |
| 01a-3 | the subscription engine: flush cycles in one exported snapshot, the shared cache, read-your-writes by cycle | plan `…01a-3-subscriptions`, spec review block |
| Test DB per checkout | each git worktree gets its own test database | `test/support/testdb.ts`, CLAUDE.md |
| PERF-CATALOG | one PREPAREd catalog statement per run, one Catalog per cycle (−27 % / −50 % per fresh run) | plan `…perf-catalog-one-query`, `docs/BENCH.md` |
| 01a-4a | the wire protocol, the WebSocket server, `startDrizzleBase` with capture restart; provisional first values in the engine | plan `…01a-4a-server`, spec review block |
| STUDIO-00 S1, S2, S3a | the studio UI on a mock data source: live read-only grid; filters, sort, columns, view in the URL; editing | `docs/specs/STUDIO-00-ui-on-mocks.md`, plans `…studio-00-*` |
| Public repo + CI | github.com/drizzle-base/drizzle-base; `.github/workflows/ci.yml` runs `check` and `test` (Postgres 18.6 with logical replication, Playwright) | PR #1 |

## In progress

- **STUDIO-00 S3b, the cell editors.** A parallel session in the worktree `~/www/drizzle-base-studio`, branch
  `feat/studio-s3b-editors`. It was local only on 25 Sep 2026: not pushed yet.

## Next, in order

1. **01a-4b: the browser client and React hooks** (`drizzle-base/client`, `drizzle-base/react`). Decided with the
   owner:
   - A mutation resolves only when the client has a transition at or after the cycle its reply names, as in Convex.
   - The API is typed without codegen: the client does `import type` of the server's `defineApi` tree and calls
     through a Proxy, as in tRPC.
   - On a `reset` frame the client resolves its pending mutations and subscribes to everything again.
   - An `upd` may carry `c`, the cycle that settled a held value.
   - The client's reconnect and liveness design comes from minivex: backoff with jitter, reset on the first frame,
     a ping with a deadline, a wake-up probe, a bounded outbox, and a frame validator.
2. **01a-4c: the demo** (`apps/demo`). An edit made in Drizzle Studio re-pushes a query with `with` in the browser,
   proved by a Playwright test. This is the done-when of all of 01a.
3. **01a-5: closing benches.** Wide-table write cost, an open transaction pinning xmin, and 1M-row regressions.
4. **Studio adapter.** `createDrizzleBaseDataSource(client)` passing the studio's conformance suite; needs 01a-4b.
5. **01b** row-level precision, **01c** joins, **01d** pages and visibility. Each must lower the useless re-run
   ratio (0.999 at 1 000 subscriptions today; see `docs/BENCH.md`).

## Open for the owner

- Protect `main`: merges only through a PR, with both CI jobs green.
- How to credit Convex (and minivex) publicly. Today the README says "Convex-style"; the owner is considering an
  "Inspired by" section later.
- The deferred items listed in the spec's review blocks, among them:
  - a message rate limit;
  - encoding a shared entry once per cycle rather than once per subscriber (hot path: bench first);
  - `reset()` rejecting barriers in flight;
  - a cross-run catalog cache keyed by the DDL stream (needs a spec of its own).

## A fresh machine or a cloud VM

```bash
bash scripts/gen-env.sh                  # .env with a random POSTGRES_PASSWORD (mode 600, gitignored)
docker compose up -d pg                  # Postgres 18.6, container drizzlebase-pg, 127.0.0.1:5478, wal_level=logical
bun install                              # Bun 1.4.2
(cd packages/studio && bunx playwright install --with-deps chromium)   # the studio's e2e tests
bun run check && bun run test
```

- Use the compose container, not a system Postgres. A cloud VM may ship an older one, and one capture test signals
  the walsender through `docker exec drizzlebase-pg`.
- `bun run test` creates this checkout's test database the first time.
- Numbers from CI on 25 Sep 2026: 232 tests (drizzle-base) + 178 (studio) + 11 Playwright end-to-end tests.
