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
