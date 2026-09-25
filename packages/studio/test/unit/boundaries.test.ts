import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boundaryViolations, collectSources } from "../support/boundaries";

const root = join(import.meta.dir, "..", "..");

describe("boundaries", () => {
  test("the checker sees every import form", () => {
    const files = [
      { path: "src/a.ts", source: 'import { x } from "drizzle-base/server";' },
      { path: "src/b.ts", source: 'export * from "../../drizzle-base/src/sql";' },
      { path: "src/c.ts", source: 'const m = await import("node:fs");' },
      { path: "src/d.ts", source: 'import "bun:test";' },
      { path: "src/e.ts", source: 'import { t } from "../test/support/dom";' },
      { path: "src/ok.ts", source: '// import "drizzle-base"\nimport { useState } from "react";' },
    ];
    expect(boundaryViolations(files)).toEqual([
      'src/a.ts imports "drizzle-base/server"',
      'src/b.ts imports "../../drizzle-base/src/sql"',
      'src/c.ts imports "node:fs"',
      'src/d.ts imports "bun:test"',
      'src/e.ts imports "../test/support/dom"',
    ]);
  });

  test("src/ and playground/ respect them", () => {
    const files = collectSources([join(root, "src"), join(root, "playground")]).map((f) => ({
      ...f,
      path: f.path.slice(root.length + 1),
    }));
    expect(files.length).toBeGreaterThan(0);
    expect(boundaryViolations(files)).toEqual([]);
  });
});
