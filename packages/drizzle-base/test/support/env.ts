// Preloaded by bunfig: every test run is NODE_ENV=test, reads the password from the workspace .env (which
// scripts/gen-env.sh wrote) and picks this checkout's test database. Bun only auto-loads .env from the cwd (this
// package), hence the manual read.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabaseName } from "./testdb";

process.env.NODE_ENV = "test";
const rootEnv = join(import.meta.dir, "..", "..", "..", "..", ".env");
if (!process.env["POSTGRES_PASSWORD"] && existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m?.[1] && m[2] !== undefined && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
// One database per checkout: a linked worktree's suite never touches the main checkout's (testdb.ts).
process.env["DZB_TEST_DB"] ??= testDatabaseName(join(import.meta.dir, "..", "..", "..", ".."));
