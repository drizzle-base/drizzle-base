# drizzlebase — architecture

One npm package, `drizzlebase`, with public subpaths — the model of Convex (`convex/server`, `convex/react`)
and drizzle-orm (`drizzle-orm/pg-core`). Chosen 25 Sep 2026 over workspace packages + an umbrella (the
Supabase model): one install, one version, and `exports` already hides every internal file.

## Public entries

| Import | For | Status |
|---|---|---|
| `drizzlebase/server` | the app's server: `functions()`, `Runtime`, capture setup, errors | DZB-01a-2 |
| `drizzlebase/client` | framework-free client | DZB-01a-4 |
| `drizzlebase/react` | React hooks | DZB-01a-4 |

`drizzle-orm` is a peer dependency (`>=0.45.3 <0.46`, the tested minor): the app's Drizzle and drizzlebase's must be
the same copy. Widen the range only after the suite has run against the new minor.

## Modules (`src/<module>/`, entered only through `index.ts`)

| Module | Owns | May import |
|---|---|---|
| `sql` | the statement gate (libpg-query) | — |
| `capture` | the logical-decoding change feed | — |
| `readset` | references, catalog, table-level read-set, `touches()` | sql |
| `runtime` | `query()`/`mutation()`, `ctx.db`, transactions | sql, readset |
| `subscriptions` | index, registration, flush cycle, cache (01a-3) | sql, capture, readset, runtime |
| `server` | WebSocket, boot (01a-4) | the server modules + protocol |
| `protocol` | wire messages (01a-4) | — |
| `client` | client (01a-4) | protocol |
| `react` | hooks (01a-4) | protocol, client |
| `entry` | the files `exports` points at; re-exports only | every module |

`protocol`, `client` and `react` never import a server module, `pg`, `pg-logical-replication`, `libpg-query`,
`drizzle-orm`, `bun` or a `node:` builtin — type-only imports included (conservative on purpose). No module imports
the package's own public entry (`drizzlebase/…`), and nothing under `src/` imports from `test/` or `load/`. A new module is added to `LAYERS` in `test/support/boundaries.ts` before its first file.

## Tests

`test/<module>/unit` (no database), `test/<module>/integration` (the test Postgres), `test/e2e` (across
modules and through the public entries), `test/support` (the database guard, fixtures, the boundary checker).
`bun run test` runs everything; `bun run test:unit` needs no database. Every property has a sabotage that
must turn it red (a working rule, checked in review — not by a tool). The boundary test
(`test/boundaries/unit/boundaries.test.ts`) fails `bun run test` on any rule above; it scans every `.js/.ts/.jsx/.tsx/.mjs/.mts/.cjs/.cts`
file, strips comments first, and sees `import`, `export … from`, `import()` and `require()`. That `entry/` only re-exports is a
convention, not a checked rule.

## Code rules (tooling, since DZB-TOOLING)

| Rule | Enforced by |
|---|---|
| Format: 2 spaces, 120 columns, LF (same as minivex) | Biome formatter, `.editorconfig` |
| No `any`; no `@ts-ignore` (`@ts-expect-error` with a reason only) | Biome `noExplicitAny`, `noTsIgnore` |
| No floating promise; no promise where the caller does not await (a lost promise is a lost invalidation here) | Biome `noFloatingPromises`, `noMisusedPromises` — a suppression names why the promise is safe |
| No `console` in `src/` (the library writes through `src/capture/log.ts`) | Biome `noConsole` |
| Type-only imports are `import type`; imports organised | Biome `useImportType`, organize imports |
| Named exports only in `src/` | Biome `noDefaultExport` |
| `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride` | `tsconfig.base.json` |
| `as unknown as X` only with a comment saying why | review (no tool can check it) |

Two Biome rules are off on purpose: `useLiteralKeys` (it contradicts `noPropertyAccessFromIndexSignature`, and the
typed rule wins) and `noNonNullAssertion` (`noUncheckedIndexedAccess` makes `!` after a checked index normal).

Commands: `bun run check` (Biome + typecheck + no-database tests) before pushing; `bun run format` to fix
formatting. The pre-commit hook (`.githooks/pre-commit`, installed by `bun install` through `prepare`) checks the
staged files. When the repository gets a remote, CI runs `bun run check` plus the integration suite against
Postgres 18. At publish time: Changesets for versions, `publint` and `@arethetypeswrong/cli` for the manifest.
