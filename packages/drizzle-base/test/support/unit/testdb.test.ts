import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseName } from "../testdb";

// A checkout's root: `.git` is a directory in the main checkout and a file in a linked worktree.
function checkout(name: string, kind: "main" | "worktree"): string {
  const root = join(mkdtempSync(join(tmpdir(), "dzb-")), name);
  mkdirSync(root);
  if (kind === "main") mkdirSync(join(root, ".git"));
  else writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  return root;
}

test("the main checkout keeps dzb_test", () => {
  expect(testDatabaseName(checkout("drizzlebase", "main"))).toBe("dzb_test");
});

test("each worktree gets its own database, named after it", () => {
  const a = testDatabaseName(checkout("drizzle-base-studio", "worktree"));
  const b = testDatabaseName(checkout("drizzle-base-studio", "worktree")); // same name, another path
  expect(a).toMatch(/^dzb_test_drizzle_base_studio_[0-9a-f]{6}$/);
  expect(a).not.toBe(b);
  expect(a).not.toBe("dzb_test");
});

test("a worktree database name is always a safe, guard-passing Postgres identifier", () => {
  const name = testDatabaseName(checkout(`Weird Name-With.Dots_${"x".repeat(80)}`, "worktree"));
  expect(name).toMatch(/^[a-z0-9_]+$/);
  expect(name.length).toBeLessThanOrEqual(63);
  expect(name).toContain("test");
});
