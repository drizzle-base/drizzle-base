// Which database a checkout's tests use. Tests drop and recreate their fixture schema (dzb_app) and read the
// database's logical stream, so two checkouts running suites on one database corrupt each other's runs. The main
// checkout keeps `dzb_test`; each linked git worktree (where `.git` is a file) gets its own database, named after
// the worktree's directory plus a hash of its path. DZB_TEST_DB overrides the choice.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";

export function testDatabaseName(checkoutRoot: string): string {
  let worktree = false;
  try {
    worktree = statSync(join(checkoutRoot, ".git")).isFile();
  } catch {
    // no .git at all (an exported tree): the default database
  }
  if (!worktree) return "dzb_test";
  const slug = basename(checkoutRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 6);
  return `dzb_test_${slug}_${hash}`;
}
