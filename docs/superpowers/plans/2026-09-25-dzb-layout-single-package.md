# DZB-LAYOUT — One package, public subpaths, enforced module boundaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise `packages/drizzlebase` into the single-package-with-subpaths layout (the Convex / drizzle-orm model): internal modules as folders under `src/`, public entry points only through `package.json` `exports` (`drizzlebase/server` now; `/client` and `/react` in 01a-4), tests mirroring the modules, and a boundary test that makes the folder rules as hard as package boundaries would be. No behaviour changes: the 92 existing tests are the proof.

**Architecture:** `src/<module>/index.ts` is the only door into a module. Modules are layered (`sql → readset → runtime → subscriptions → server`, `capture → subscriptions`, `protocol → client → react`); `src/entry/*.ts` re-export the public API and are what `exports` points at. `test/<module>/{unit,integration}` mirror `src/`; `test/e2e` crosses modules; `test/support` holds the test database guard and fixtures. A pure checker (`test/support/boundaries.ts`) enforces the rules on `src/` and `test/`.

**Tech Stack:** Bun 1.4.2, TypeScript, existing dependencies. No new runtime dependency.

**Spec:** `docs/specs/DZB-01-foundation.md` (POST-REVIEW block). The owner chose this layout on 25 Sep 2026 over workspace packages + an umbrella: one npm package, subpaths, like Convex (`convex/server`, `convex/react`) and drizzle-orm (`drizzle-orm/pg-core`).

## Global Constraints

- One published package: `drizzlebase`. `exports` lists only public entries; a deep import (`drizzlebase/src/…`) must not resolve (probed: Bun enforces `exports` on self-reference).
- `drizzle-orm` becomes a **peerDependency** (`>=0.45.3 <1`) and stays a devDependency at `0.45.3` for the tests: the app's Drizzle and drizzlebase's must be the same copy, or Drizzle's `is()`/entity checks fail silently across copies (the drizzle-orm driver packages do the same). `pg`, `pg-logical-replication`, `libpg-query` stay `dependencies`.
- A module is imported from outside only through its folder (`../readset`, resolving to `index.ts`) — never a file inside it.
- Allowed module dependencies (and nothing else): `sql: []`, `capture: []`, `readset: [sql]`, `runtime: [sql, readset]`, `subscriptions: [sql, capture, readset, runtime]`, `server: [sql, capture, readset, runtime, subscriptions, protocol]`, `protocol: []`, `client: [protocol]`, `react: [protocol, client]`, `entry: [every module]`. A folder under `src/` missing from this table is an error: a new module declares its layer.
- `protocol`, `client`, `react` import no server-only package (`pg`, `pg-logical-replication`, `libpg-query`, `bun`, `drizzle-orm`) and no `node:` builtin.
- Every bare import in `src/` is declared in `dependencies` or `peerDependencies`.
- Tests import `src/` only through module folders (or `drizzlebase/<entry>`), never a file inside a module.
- No behaviour change: after the moves, the suite reports the same 92 tests passing plus the new ones.
- Moves use `git mv` (history follows). English everywhere in the repo. Branch `refactor/dzb-layout`.

## Review Focus

1. **A new module added later without a layer** — the checker must refuse it, not silently allow any import. (Task 3 test: `an undeclared module is an error`.)
2. **A client-side module reaching server code indirectly** — through an allowed-looking relative path like `../server` or a bare `pg` import. (Task 3 tests: `client importing a server module`, `client importing pg`.)
3. **Tests that stop running after the move** — Bun silently ignores missing paths, so the count must be compared, not just "0 fail". (Task 2 step: the run must say `Ran 92 tests across 11 files`.)
4. **The public door** — `drizzlebase/server` resolves and exposes `functions`; `drizzlebase/runtime` and deep paths do not. (Task 4 test: `the public entries are the only doors`.)
5. **The re-export of `touches`'s input** — moving `touches` off `CapturedTxn` must keep accepting a real captured transaction. (Task 1: the existing reactivity e2e test passes a real `CapturedTxn`.)

---

## Target layout

```
packages/drizzlebase/
  package.json            exports: { "./server": "./src/entry/server.ts" }
  src/
    capture/   index.ts assembler.ts barrier.ts log.ts pgoutput.ts setup.ts types.ts
    sql/       index.ts parse.ts
    readset/   index.ts catalog.ts readset.ts refs.ts
    runtime/   index.ts client.ts functions.ts runtime.ts
    entry/     server.ts
  test/
    support/   env.ts db.ts app.ts boundaries.ts guard.test.ts
    capture/   unit/assembler.test.ts   integration/{setup,pgoutput,equivalence}.test.ts
    sql/       unit/parse.test.ts
    readset/   unit/refs.test.ts        integration/readset.test.ts
    runtime/   integration/{client,runtime}.test.ts
    boundaries/unit/boundaries.test.ts
    e2e/       reactivity.test.ts entry.test.ts
  load/
    capture/   stream_latency.ts wide_identity.sh wide_setup.sql wide_upd.pgb
    runtime/   drizzle_overhead.ts
docs/ARCHITECTURE.md
```

---

### Task 1: Modules behind their index; `touches` off `capture`

**Files:**
- Move: `src/log.ts` → `src/capture/log.ts`
- Create: `src/sql/index.ts`, `src/readset/index.ts`
- Modify: `src/capture/pgoutput.ts`, `src/readset/refs.ts`, `src/readset/readset.ts`, `src/runtime/client.ts`, `src/runtime/runtime.ts` (import specifiers only, plus `touches`'s parameter type)

**Interfaces:**
- Produces: `src/sql` exports `ForbiddenStatementError, loadParser, parseStatement, type Node, type Parsed`; `src/readset` exports `Catalog, type Member, type RelationInfo, type FunctionInfo, buildReadSet, readSetOf, touches, type ReadSet, type TxnTables, collectRefs, type Refs, type RelationRef, type FunctionRef, type OperatorRef`.
- `touches(rs: ReadSet, txn: TxnTables): boolean` with `interface TxnTables { ddl: boolean; changes: readonly { table: string }[]; wholeTables: ReadonlySet<string> }` — structural, so `readset` no longer imports `capture`; a `CapturedTxn` still satisfies it.

- [ ] **Step 1: Branch and moves**

```bash
cd ~/www/drizzlebase && git checkout -b refactor/dzb-layout
cd packages/drizzlebase && git mv src/log.ts src/capture/log.ts
```

- [ ] **Step 2: The two new indexes**

`src/sql/index.ts`:
```ts
export { ForbiddenStatementError, loadParser, type Node, type Parsed, parseStatement } from "./parse";
```
`src/readset/index.ts`:
```ts
export { Catalog, type FunctionInfo, type Member, type RelationInfo } from "./catalog";
export { buildReadSet, type ReadSet, readSetOf, touches, type TxnTables } from "./readset";
export { collectRefs, type FunctionRef, type OperatorRef, type Refs, type RelationRef } from "./refs";
```

- [ ] **Step 3: Rewrite the cross-module imports** (a module is reached only through its folder)

```bash
cd ~/www/drizzlebase/packages/drizzlebase && python3 - <<'EOF'
import re
edits = {
  "src/capture/pgoutput.ts": [('from "../log"', 'from "./log"')],
  "src/readset/refs.ts": [('from "../sql/parse"', 'from "../sql"')],
  "src/readset/readset.ts": [('from "../sql/parse"', 'from "../sql"')],
  "src/runtime/client.ts": [('from "../readset/refs"', 'from "../readset"'), ('from "../sql/parse"', 'from "../sql"')],
  "src/runtime/runtime.ts": [('from "../readset/catalog"', 'from "../readset"'), ('from "../readset/readset"', 'from "../readset"'), ('from "../sql/parse"', 'from "../sql"')],
}
for path, pairs in edits.items():
    s = open(path).read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old, s.count(old))
        s = s.replace(old, new)
    open(path, "w").write(s)
EOF
grep -rn 'from "\.\./[a-z]*/' src || echo "no deep cross-module import left"
```
Expected: `no deep cross-module import left`.

- [ ] **Step 4: `touches` takes a structural type** — in `src/readset/readset.ts` replace the `import type { CapturedTxn } from "../capture/types";` line with nothing, and the `touches` signature with:

```ts
// The part of a committed transaction touches() reads. Structural on purpose: readset does not depend on
// capture, and a CapturedTxn satisfies it as is.
export interface TxnTables {
	ddl: boolean;
	changes: readonly { table: string }[];
	wholeTables: ReadonlySet<string>;
}

export function touches(rs: ReadSet, txn: TxnTables): boolean {
```

Also merge the two `import … from "../readset"` lines in `src/runtime/runtime.ts` into one:
`import { Catalog, type ReadSet, readSetOf } from "../readset";`

- [ ] **Step 5: Verify — nothing changed behaviourally**

Run: `bun run typecheck && bun test --timeout 200000 2>&1 | grep -E "Ran |pass$|fail$"`
Expected: 0 type errors; `Ran 92 tests across 11 files`, 92 pass, 0 fail (tests still live in `test/` and import deep files; Task 2 moves them).

- [ ] **Step 6: Commit**

```bash
cd ~/www/drizzlebase && git add -A packages/drizzlebase && git commit -m "refactor(layout): every module behind its index; touches() takes a structural transaction, readset no longer depends on capture"
```

---

### Task 2: Tests and benches mirror the modules

**Files:**
- Move every file under `test/` and `load/` to the target layout (above), with `git mv`.
- Modify: import specifiers in the moved files; `bunfig.toml` preload; `test/support/env.ts` (one more `..` to reach the root `.env`); `package.json` scripts; `docs/BENCH.md` commands.

- [ ] **Step 1: Moves**

```bash
cd ~/www/drizzlebase/packages/drizzlebase
mkdir -p test/support test/capture/unit test/capture/integration test/sql/unit test/readset/unit test/readset/integration test/runtime/integration test/e2e load/capture load/runtime
git mv test/env.ts test/support/env.ts && git mv test/db.ts test/support/db.ts && git mv test/fixtures/app.ts test/support/app.ts && git mv test/guard.test.ts test/support/guard.test.ts
git mv test/assembler.test.ts test/capture/unit/ && git mv test/setup.test.ts test/pgoutput.test.ts test/equivalence.test.ts test/capture/integration/
git mv test/parse.test.ts test/sql/unit/ && git mv test/refs.test.ts test/readset/unit/ && git mv test/readset.test.ts test/readset/integration/
git mv test/client.test.ts test/runtime.test.ts test/runtime/integration/ && git mv test/reactivity.test.ts test/e2e/
git mv load/stream_latency.ts load/wide_identity.sh load/wide_setup.sql load/wide_upd.pgb load/capture/ && git mv load/drizzle_overhead.ts load/runtime/
rmdir test/fixtures
```

- [ ] **Step 2: Rewrite imports** — deep `src` paths become module folders, support files move:

```bash
cd ~/www/drizzlebase/packages/drizzlebase && python3 - <<'EOF'
import os, re, glob
files = glob.glob("test/**/*.ts", recursive=True) + glob.glob("load/**/*.ts", recursive=True)
for f in files:
    depth = f.count("/")                       # test/capture/unit/x.ts -> 3 ; test/e2e/x.ts -> 2 ; test/support/x.ts -> 2
    up = "../" * depth
    s = open(f).read()
    # any old deep path into src: "../src/<m>/<file>", "../../src/<m>/<file>" -> "<up>src/<m>"
    s = re.sub(r'from "(?:\.\./)+src/([a-z]+)/[a-z]+"', lambda m: f'from "{up}src/{m.group(1)}"', s)
    # support files
    to_support = "./" if f.startswith("test/support/") else up + "test/support/"
    if f.startswith("load/"): to_support = up + "test/support/"
    s = re.sub(r'from "(?:\./|\.\./)(?:test/)?db"', f'from "{to_support}db"', s)
    s = re.sub(r'from "(?:\./|\.\./)(?:test/)?fixtures/app"', f'from "{to_support}app"', s)
    s = re.sub(r'from "\.\./db"', f'from "{to_support}db"', s)
    open(f, "w").write(s)
EOF
grep -rn 'from "\.[^"]*src/[a-z]*/[a-z]' test load || echo "no deep src import in tests"
grep -rn 'fixtures/\|from "\./db"' test load | grep -v "test/support/" || echo "support paths ok"
```
Expected: `no deep src import in tests` and `support paths ok`. Then in `test/support/env.ts` change `join(import.meta.dir, "..", "..", "..", ".env")` to `join(import.meta.dir, "..", "..", "..", "..", ".env")`, and in `bunfig.toml` set `preload = ["./test/support/env.ts"]`.

- [ ] **Step 3: Scripts and bench paths** — `package.json` `scripts`:

```json
"test": "bun test --timeout 200000",
"test:unit": "bun test --timeout 30000 /unit/",
"typecheck": "tsc -p tsconfig.json"
```
In `docs/BENCH.md` replace `load/stream_latency.ts` → `load/capture/stream_latency.ts`, `load/wide_identity.sh` → `load/capture/wide_identity.sh`, `load/drizzle_overhead.ts` → `load/runtime/drizzle_overhead.ts`.

- [ ] **Step 4: Verify the SAME tests run** (Bun ignores a path that matches nothing — compare the count)

Run: `cd packages/drizzlebase && bun run typecheck && bun test --timeout 200000 2>&1 | grep -E "Ran |pass$|fail$" && bun run test:unit 2>&1 | grep -E "Ran "`
Expected: 0 type errors; `Ran 92 tests across 11 files`, 0 fail; `test:unit` runs only the unit files (assembler, parse, refs: `Ran 33 tests across 3 files` — 11 + 13 + 9) with no database needed.

- [ ] **Step 5: Commit**

```bash
cd ~/www/drizzlebase && git add -A packages/drizzlebase docs/BENCH.md && git commit -m "refactor(layout): tests mirror the modules (unit / integration / e2e / support), benches under load/<module>"
```

---

### Task 3: The boundary checker

**Files:**
- Create: `test/support/boundaries.ts`
- Test: `test/boundaries/unit/boundaries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SourceFile { path: string; text: string }  // path relative to the package root, e.g. "src/runtime/client.ts"
  interface PackageDeps { dependencies: string[]; peerDependencies: string[] }
  const LAYERS: Record<string, readonly string[]>;
  function checkBoundaries(files: SourceFile[], pkg: PackageDeps): string[];   // [] = clean
  function loadPackage(root: string): { files: SourceFile[]; pkg: PackageDeps };
  ```

- [ ] **Step 1: Write the failing tests**

`test/boundaries/unit/boundaries.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkBoundaries, LAYERS, loadPackage, type PackageDeps } from "../../support/boundaries";

const pkg: PackageDeps = { dependencies: ["pg", "libpg-query", "pg-logical-replication"], peerDependencies: ["drizzle-orm"] };
const one = (path: string, text: string) => checkBoundaries([{ path, text }], pkg);

describe("checkBoundaries — each rule refuses its violation", () => {
	test("a deep import into another module", () => {
		expect(one("src/runtime/x.ts", `import { Catalog } from "../readset/catalog";`).join()).toMatch(/through its index/);
	});
	test("an import against the layers (readset → runtime)", () => {
		expect(one("src/readset/x.ts", `import { Runtime } from "../runtime";`).join()).toMatch(/readset may not depend on runtime/);
	});
	test("client importing a server module", () => {
		expect(one("src/client/x.ts", `import { Runtime } from "../server";`).join()).toMatch(/client may not depend on server/);
	});
	test("client importing pg, or a node builtin", () => {
		expect(one("src/client/x.ts", `import pg from "pg";`).join()).toMatch(/server-only package pg/);
		expect(one("src/react/x.ts", `import { readFileSync } from "node:fs";`).join()).toMatch(/server-only package node:fs/);
	});
	test("an undeclared module is an error", () => {
		expect(one("src/scheduler/x.ts", `export const a = 1;`).join()).toMatch(/module scheduler has no layer/);
	});
	test("an undeclared package", () => {
		expect(one("src/runtime/x.ts", `import z from "zod";`).join()).toMatch(/zod is not declared/);
	});
	test("a test reaching a file inside a module", () => {
		expect(one("test/runtime/integration/x.test.ts", `import { CapturingClient } from "../../../src/runtime/client";`).join()).toMatch(/through its index/);
	});
	test("dynamic imports and re-exports are checked too", () => {
		expect(one("src/readset/x.ts", `const m = await import("../runtime");`).join()).toMatch(/may not depend on runtime/);
		expect(one("src/readset/x.ts", `export { Runtime } from "../runtime";`).join()).toMatch(/may not depend on runtime/);
	});
	test("what IS allowed passes", () => {
		expect(one("src/runtime/x.ts", `import { Catalog } from "../readset";\nimport { sql } from "drizzle-orm";\nimport { a } from "./local";`)).toEqual([]);
		expect(one("src/entry/server.ts", `export { functions } from "../runtime";`)).toEqual([]);
	});
	test("the layer table itself has no cycle", () => {
		const seen = new Set<string>(), stack = new Set<string>();
		const visit = (m: string): void => {
			if (stack.has(m)) throw new Error(`cycle through ${m}`);
			if (seen.has(m)) return;
			stack.add(m);
			for (const d of LAYERS[m] ?? []) visit(d);
			stack.delete(m);
			seen.add(m);
		};
		for (const m of Object.keys(LAYERS)) visit(m);
	});
});

test("the real package is clean", () => {
	const { files, pkg: real } = loadPackage(join(import.meta.dir, "..", "..", ".."));
	expect(files.filter((f) => f.path.startsWith("src/")).length).toBeGreaterThan(10); // the premise: it scanned the code
	expect(checkBoundaries(files, real)).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd packages/drizzlebase && bun test test/boundaries`
Expected: FAIL — cannot resolve `../../support/boundaries`.

- [ ] **Step 3: Implement `test/support/boundaries.ts`**

```ts
// The folder rules that make one package behave like several (docs/ARCHITECTURE.md). Without this check the
// boundaries would erode one convenient import at a time — the reason the owner's earlier split attempt failed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";

export interface SourceFile {
	path: string; // relative to the package root
	text: string;
}
export interface PackageDeps {
	dependencies: string[];
	peerDependencies: string[];
}

// Which modules each module may import. A folder under src/ that is not a key is an error.
export const LAYERS: Record<string, readonly string[]> = {
	sql: [],
	capture: [],
	readset: ["sql"],
	runtime: ["sql", "readset"],
	subscriptions: ["sql", "capture", "readset", "runtime"],
	server: ["sql", "capture", "readset", "runtime", "subscriptions", "protocol"],
	protocol: [],
	client: ["protocol"],
	react: ["protocol", "client"],
	entry: ["sql", "capture", "readset", "runtime", "subscriptions", "server", "protocol", "client", "react"],
};
const CLIENT_SIDE = new Set(["protocol", "client", "react"]);
const SERVER_ONLY_PACKAGES = new Set(["pg", "pg-logical-replication", "libpg-query", "bun", "drizzle-orm"]);
const BUILTIN = (spec: string) => spec.startsWith("node:") || spec === "bun" || spec === "bun:test";

const SPEC = /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function specifiers(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(SPEC)) out.push((m[1] ?? m[2] ?? m[3])!);
	return out;
}

const moduleOf = (path: string): string | null => (path.startsWith("src/") ? (path.split("/")[1] ?? null) : null);
const bareName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

export function checkBoundaries(files: SourceFile[], pkg: PackageDeps): string[] {
	const problems: string[] = [];
	const declared = new Set([...pkg.dependencies, ...pkg.peerDependencies]);
	for (const f of files) {
		const from = moduleOf(f.path);
		if (from !== null && !(from in LAYERS)) {
			problems.push(`${f.path}: module ${from} has no layer in LAYERS`);
			continue;
		}
		for (const spec of specifiers(f.text)) {
			if (spec.startsWith(".")) {
				const target = normalize(join(f.path, "..", spec));
				if (!target.startsWith("src/")) continue; // test → test/support, load → test/support: not a module
				const parts = target.split("/");
				const to = parts[1]!;
				if (to === from) continue; // inside its own module
				if (parts.length > 2 && !(parts.length === 3 && parts[2] === "index")) problems.push(`${f.path}: reaches into ${target}; import module ${to} through its index`);
				if (from !== null && !(LAYERS[from] ?? []).includes(to)) problems.push(`${f.path}: ${from} may not depend on ${to}`);
				if (from !== null && CLIENT_SIDE.has(from) && !CLIENT_SIDE.has(to)) problems.push(`${f.path}: client may not depend on server module ${to}`);
				continue;
			}
			if (spec.startsWith("drizzlebase/")) continue; // the package's own public entries
			if (from !== null && CLIENT_SIDE.has(from) && (BUILTIN(spec) || SERVER_ONLY_PACKAGES.has(bareName(spec))))
				problems.push(`${f.path}: ${from} imports server-only package ${spec}`);
			if (from !== null && !BUILTIN(spec) && !declared.has(bareName(spec))) problems.push(`${f.path}: ${bareName(spec)} is not declared in dependencies or peerDependencies`);
		}
	}
	return problems;
}

export function loadPackage(root: string): { files: SourceFile[]; pkg: PackageDeps } {
	const files: SourceFile[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (full.endsWith(".ts")) files.push({ path: relative(root, full), text: readFileSync(full, "utf8") });
		}
	};
	for (const top of ["src", "test", "load"]) walk(join(root, top));
	const json = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
	return { files, pkg: { dependencies: Object.keys(json.dependencies ?? {}), peerDependencies: Object.keys(json.peerDependencies ?? {}) } };
}
```

Note: the client-side message for a relative import is "client may not depend on server module X" AND the layer message; the tests match either with a regex on the joined list.

- [ ] **Step 4: Run — expect PASS**

Run: `cd packages/drizzlebase && bun test test/boundaries && bun run typecheck`
Expected: 11 pass; 0 type errors. `the real package is clean` passes only if Task 1–2 left no deep import (Task 4 adds `drizzle-orm` to `peerDependencies`; until then `drizzle-orm` is a `dependency` — both are accepted).

- [ ] **Step 5: Sabotage, then restore** — add a real violation to the package and watch the real-package test go red:

```bash
cd packages/drizzlebase && cp src/readset/readset.ts /tmp/readset.layout.bak
printf '\nexport type _Sabotage = import("../runtime").QueryRun<unknown>;\n' >> src/readset/readset.ts
bun test test/boundaries 2>&1 | grep -E "^\(fail\)|pass$|fail$"; cp /tmp/readset.layout.bak src/readset/readset.ts
```
Expected: `the real package is clean` fails (`readset may not depend on runtime`). If it stays green the SPEC regex missed the `import("…")` type form: fix the checker, not the sabotage.

- [ ] **Step 6: Commit**

```bash
cd ~/www/drizzlebase && git add packages/drizzlebase && git commit -m "test(layout): the boundary checker — module doors, layers, client/server split, declared packages"
```

---

### Task 4: The public entry, peer dependency, and the architecture doc

**Files:**
- Create: `src/entry/server.ts`, `test/e2e/entry.test.ts`, `docs/ARCHITECTURE.md`
- Modify: `package.json` (`exports`, `peerDependencies`, `devDependencies`), root `README.md`

- [ ] **Step 1: Write the failing test**

`test/e2e/entry.test.ts`:
```ts
import { expect, test } from "bun:test";

test("the public entries are the only doors", async () => {
	const server = await import("drizzlebase/server");
	expect(typeof server.functions).toBe("function");
	expect(typeof server.Runtime).toBe("function");
	for (const hidden of ["drizzlebase/runtime", "drizzlebase/capture", "drizzlebase/src/runtime/index.ts"]) {
		const outcome = await import(hidden).then(() => "resolved", () => "blocked");
		expect(`${hidden}: ${outcome}`).toBe(`${hidden}: blocked`);
	}
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd packages/drizzlebase && bun test test/e2e/entry`
Expected: FAIL — `drizzlebase/server` does not resolve (and `drizzlebase/runtime` still does).

- [ ] **Step 3: The entry and the manifest**

`src/entry/server.ts`:
```ts
// drizzlebase/server — what an application's server code imports. Everything else stays internal.
export { assertCapture, type CaptureNames, checkCapture, ensureCapture, PgoutputCapture } from "../capture";
export { ForbiddenStatementError } from "../sql";
export {
	CommitOutcomeUnknownError,
	type Ctx,
	type Db,
	functions,
	MutationAbortedError,
	MutationConflictError,
	type MutationDef,
	type MutationRun,
	type QueryDef,
	type QueryRun,
	Runtime,
} from "../runtime";
```

`package.json` (edit with a JSON rewrite, not sed — Bun reformats the file):
```bash
cd ~/www/drizzlebase/packages/drizzlebase && python3 - <<'EOF'
import json
p = "package.json"; d = json.load(open(p))
d["exports"] = {"./server": "./src/entry/server.ts"}
d["peerDependencies"] = {"drizzle-orm": ">=0.45.3 <1"}
d["dependencies"].pop("drizzle-orm", None)
d.setdefault("devDependencies", {})["drizzle-orm"] = "0.45.3"
open(p, "w").write(json.dumps(d, indent=2) + "\n")
EOF
cd ~/www/drizzlebase && bun install 2>&1 | tail -1
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd packages/drizzlebase && bun test test/e2e/entry test/boundaries && bun run typecheck`
Expected: 12 pass; 0 type errors.

- [ ] **Step 5: `docs/ARCHITECTURE.md`**

```markdown
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

`drizzle-orm` is a peer dependency: the app's Drizzle and drizzlebase's must be the same copy.

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

`protocol`, `client` and `react` never import a server module, `pg`, `libpg-query`, `drizzle-orm`, `bun` or a
`node:` builtin. A new module is added to `LAYERS` in `test/support/boundaries.ts` before its first file.

## Tests

`test/<module>/unit` (no database), `test/<module>/integration` (the test Postgres), `test/e2e` (across
modules and through the public entries), `test/support` (the database guard, fixtures, the boundary checker).
`bun run test` runs everything; `bun run test:unit` needs no database. Every property has a sabotage that
must turn it red. The boundary test fails the build on any rule above.
```

And in the root `README.md`, add under the first paragraph: ``Layout and module rules: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).``

- [ ] **Step 6: Full suite, commit**

Run: `cd packages/drizzlebase && bun run typecheck && bun test --timeout 200000 2>&1 | grep -E "Ran |pass$|fail$"`
Expected: `Ran 104 tests across 13 files` (92 + 11 boundary + 1 entry), 0 fail.

```bash
cd ~/www/drizzlebase && git add -A packages/drizzlebase docs/ARCHITECTURE.md README.md bun.lock && git commit -m "refactor(layout): drizzlebase/server is the public door; drizzle-orm is a peer dependency; ARCHITECTURE.md"
```

---

### Task 5: Final review

- [ ] **Step 1:** One fresh reviewer over `git diff main...refactor/dzb-layout`: behaviour preserved (same tests, same counts), the checker's honesty (can a violation slip past the regex — `export *`, type-only imports, `require`, template-literal specifiers?), the peer-dependency choice, and the plan's Review Focus.
- [ ] **Step 2:** Fix Critical/Important with a failing test first; merge into `main` only after the owner says so.
