import { expect, test } from "bun:test";
import { project, RecentCommits } from "../../../src/subscriptions";

const txn = (tables: string[]) => ({
  ddl: false,
  changes: tables.map((table) => ({
    table,
    relOid: 1,
    op: "insert" as const,
    old: null,
    new: { big: "x".repeat(1000) },
  })),
  wholeTables: new Set<string>(),
});

test("project keeps the tables, not the row images", () => {
  const p = project(txn(["a", "a", "b"]));
  expect(p.changes).toEqual([{ table: "a" }, { table: "b" }]);
  expect(JSON.stringify(p)).not.toContain("xxxx");
});

test("prune drops what precedes xmin (modulo 2^32); clear empties", () => {
  const b = new RecentCommits();
  for (const x of [98, 99, 100, 101]) b.append(x, project(txn([`t${x}`])));
  expect(b.prune(100)).toBe(2);
  expect(b.all().map((e) => e.xid)).toEqual([100, 101]);
  b.append(0xffff_fff0, project(txn(["w"])));
  expect(b.prune(0x0000_0102)).toBe(3);
  b.append(5, project(txn(["z"])));
  b.clear();
  expect(b.size).toBe(0);
});
