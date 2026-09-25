# CLAUDE.md — a guide for agents (and humans) working in this repo

drizzle-base gives an app written with **plain drizzle-orm** (schema in real columns, drizzle-kit migrations,
Drizzle Studio) what Convex gives an app written against its own API: named server functions, reactive queries
that re-push when the data they read changes, a shared cache, ACID mutations, a typed client. The developer
writes ANY Drizzle query; the read-set is derived from the SQL the driver sees. Postgres 18 only (for now).
Sibling project: `~/www/minivex` (a restricted query API) — a quarry for ideas, never a dependency.

## Language

**Chat with the owner: always pt-BR**, including the short status lines between tool calls. Everything in the
repo — code, identifiers, comments, docs, commits, PRs — is **English**. A comment says what the code cannot
(the reason behind a non-obvious choice, an invariant, a trap), never the history of how it got there.

## Where to look

| Doc | What for |
|---|---|
| [`README.md`](README.md) | What it is, one screen |
| This `CLAUDE.md` | Invariants, process, paid lessons |
| [`docs/specs/DZB-01-foundation.md`](docs/specs/DZB-01-foundation.md) | **The spec. Read the POST-REVIEW DECISION block first**; it supersedes the body. Each phase's final review is recorded there |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The single-package layout, module layers, public entries, code rules |
| [`docs/BENCH.md`](docs/BENCH.md) | Every measured number, with its command and what it measured |
| `docs/superpowers/plans/` | One implementation plan per phase |
| `spikes/` | The throwaway probes the design rests on (P1–P4, reviews). Code is disposable; each `FINDINGS.md` is the record |

## Invariants — do NOT break them

1. **Never under-invalidate.** Anything the read-set extraction does not understand WIDENS (a whole table, or
   OPAQUE = any change re-runs the query); it never narrows. Every relation anywhere in the parse tree is a scan.
   Views, RLS tables, unpublished tables, unknown relations, user functions and user operators are OPAQUE.
2. **Every committed write reaches subscriptions through the stream** (logical decoding), whoever wrote it —
   a mutation, Drizzle Studio, psql. Mutations capture nothing themselves.
3. **The driver owns transactions.** Handlers run one SELECT/INSERT/UPDATE/DELETE per call through the gate
   (libpg-query); `db.transaction()` is a savepoint; session state (`set_config`, session advisory locks), DDL,
   `SELECT … INTO` and transaction control are refused.
4. **A query runs in one REPEATABLE READ READ ONLY snapshot**; its catalog resolution runs on the SAME connection.
   A mutation is SERIALIZABLE, retried on 40001/40P01 only; a COMMIT whose outcome is unknown is never retried; a
   COMMIT answered with the tag `ROLLBACK` is a failure, never a success.
5. **A cached query is a pure function of (args, snapshot).** Non-immutable functions make it uncacheable.
6. **A transition is consistent**: everything pushed in one batch reflects one snapshot (spec D8 / P-A3).
7. **Module boundaries are enforced** (`docs/ARCHITECTURE.md`): a module is entered only through its `index.ts`,
   layers point one way, client-side modules never touch server code. The boundary test fails `bun run test`.

## The process (every phase)

Scale the rigor to the risk; kernel and consistency work (capture, read-set, subscriptions, transactions) gets all
of it.

1. **Study before coding**: options against the real code and real probes, one recommendation, wait for the owner.
   Compare structural choices with what the market uses (Convex, Drizzle, tRPC, TanStack, Supabase) and name it.
2. **Spec or plan**: a phase of the spec gets a plan in `docs/superpowers/plans/` (exact files, code, tests,
   expected output). New kernel design gets a spec section and **two independent adversarial reviews**
   (correctness/concurrency and strategy/performance) before any code, recorded as a POST-REVIEW block.
3. **TDD**: the test is written first and seen failing for the right reason. Every property has a **sabotage**: break
   the thing the fix introduced and watch the test go red. A test that stays green under its sabotage is vacuous.
4. **`bun run check`** (Biome + typecheck + no-database tests) and **`bun run test`** (everything) green.
5. **A final fresh reviewer** on the whole branch (most capable model). Critical/Important are fixed, each with a
   test that fails first; minors are recorded. The phase's review goes into the spec's POST-REVIEW block.
6. **Branch per phase** (`feat/…`, `fix/…`, `refactor/…`, `chore/…`); the merge into `main` is the owner's call.
   Once the GitHub remote exists: push, open a PR, wait for CI green, hand the owner the link.
7. **Record**: `docs/BENCH.md` for numbers, the spec for decisions, memory for lessons.

## Tests — the rules that keep them honest

- **Assert the property, not the patch.** A test that cannot be broken by a plausible variant of its scenario is
  not a test yet. Sabotage one thing at a time.
- **A case whose premise never happened is VACUOUS**, not passing: assert the premise (the write was captured, the
  result changed, the process really stopped — e.g. `ps -o stat=` shows `T`).
- **Compare counts**, not only "0 fail": Bun silently ignores a test path that matches nothing. After any move the
  run must say the same `Ran N tests across M files`.
- **Restore a sabotaged file with `cp` from a backup**, never `git checkout --` (it eats uncommitted work).
- Tests only touch this checkout's test database: `dzb_test` in the main checkout, `dzb_test_<worktree>_<hash>`
  in a linked git worktree (`test/support/testdb.ts`; `bun run test` creates it; `DZB_TEST_DB` overrides; a guard
  refuses any name without "test"). Suites in different worktrees no longer share fixtures or the stream, but they
  share the CLUSTER: a long transaction in one pins the xmin every other sees. Every test object
  (schema, slot, publication) carries its pid in its name and is swept when that pid is dead.

## Running

```bash
bash scripts/gen-env.sh          # .env with a random POSTGRES_PASSWORD (mode 600, gitignored) — never print it
docker compose up -d pg          # Postgres 18.6, 127.0.0.1:5478, wal_level=logical (db dzb_test; worktrees get their own)
bun install                      # also installs the pre-commit hook (core.hooksPath = .githooks)
bun run check                    # Biome + typecheck + unit tests (no database)
bun run test                     # everything, incl. integration and e2e against the test database
```

CI (`.github/workflows/ci.yml`) runs the same two commands on every pull request and on `main`: `check`, and
`test` against a Postgres 18.6 container with logical replication (a random password per run). Actions are
pinned to a commit.

Benches: `cd packages/drizzle-base && bun --preload ./test/support/env.ts load/<module>/<bench>.ts`. The old spike
container (`drizzlebase-pg18`, :5477, db `spike`) belongs to `spikes/` only.

## Gotchas — lessons already paid for

- **pg-logical-replication's `acknowledge(lsn)` adds 1.** Acknowledge the commit record's START (`commitLsn`);
  `commitEndLsn` confirms one byte past the WAL end and the next record — a barrier — is skipped forever.
- **A barrier needs `pg_logical_emit_message(false, prefix, id, true)`** — the 4th argument flushes. Without it the
  walsender waits for the WAL writer (~180 ms per barrier).
- **Slot and publication names travel unquoted in `START_REPLICATION`**: a mixed-case name is folded and PG 18 skips
  the missing publication with only a warning. Names are validated (`^[a-z_][a-z0-9_]*$`).
- **After a handler error the capture stops acknowledging**, or the failed transaction is confirmed past and lost.
- **Drizzle wraps every driver error in `DrizzleQueryError`**; the SQLSTATE (Bun puts it in `errno`) is on `cause`.
- **COMMIT on an aborted transaction returns the tag `ROLLBACK` with no error.** Check `result.command`.
- **libpg-query**: write targets are unwrapped `RangeVar` bodies (detect relations by shape, `relname`); false
  booleans are omitted (`inh` absent = `ONLY`); `""` throws before the statement count.
- **Bun**: bunfig's `[test] timeout` is ignored (pass `--timeout`); `bun test /unit/` is an absolute path (use
  `unit/`); `ReservedSQL extends SQL`; Bun's `exports` enforcement also applies to self-reference.
- **The shell is zsh**: no word splitting of `$var` (use a function); macOS has no `timeout`. Never `pkill bun`.
- **Biome `--unsafe` can delete a file's header comment**: count comment lines before and after a mass fix.
- **Drizzle Studio writes directly**: prefer database-side defaults (`uuid().default(sql\`uuidv7()\`)`) over
  `$defaultFn`, which exists only in JS.

## Security

No secret in code, logs, tests, commits or docs. The test password is generated into the gitignored `.env`;
Postgres listens on loopback only. Before the repository goes public, the whole history is scanned for secrets.
