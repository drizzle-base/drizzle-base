import { describe, expect, test } from "bun:test";
import type { ReadSet } from "../../../src/readset";
import { RecentCommits, Registry } from "../../../src/subscriptions";

const rs = (tables: string[], opaque: string[] = []): ReadSet => ({ tables: new Set(tables), opaque, volatile: [] });
const txn = (tables: string[], ddl = false) => ({
  ddl,
  changes: tables.map((table) => ({ table })),
  wholeTables: new Set<string>(),
});
const vis = (xmin: number, xmax: number, xip: number[] = []) => ({ xmin, xmax, xip: new Set(xip) });

describe("Registry", () => {
  test("marks what a transaction changed — unless the snapshot already saw it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("posts", rs(["app.posts"]), vis(100, 105), b);
    r.register("users", rs(["app.users"]), vis(100, 105), b);
    expect(r.apply(99, txn(["app.posts"]))).toEqual([]);
    expect(r.apply(107, txn(["app.posts"]))).toEqual(["posts"]);
    expect(r.apply(108, txn(["app.posts"]))).toEqual([]);
    expect(r.dirtyKeys()).toEqual(["posts"]);
    expect(r.dirtyCount).toBe(1);
  });

  test("an opaque read-set is touched by any change", () => {
    const r = new Registry<string>();
    r.register("view", rs([], ["view app.v"]), vis(100, 100), new RecentCommits());
    expect(r.apply(120, txn(["app.other"]))).toEqual(["view"]);
  });

  test("DDL dirties every entry, even one whose snapshot saw it (its catalog may predate it)", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("a", rs(["app.posts"]), vis(200, 200), b);
    r.register("b", rs(["app.users"]), vis(200, 200), b);
    expect(r.apply(150, txn([], true)).sort()).toEqual(["a", "b"]);
  });

  test("registration replays the buffer: a commit the snapshot did not see makes it dirty from birth", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    b.append(103, txn(["app.posts"]));
    b.append(90, txn(["app.posts"]));
    expect(r.register("a", rs(["app.posts"]), vis(100, 110, [103]), b)).toBe(true);
    expect(r.register("b", rs(["app.users"]), vis(100, 110, [103]), b)).toBe(false);
  });

  test("re-registering clears the dirty bit and replaces the read-set; remove forgets it", () => {
    const r = new Registry<string>();
    const b = new RecentCommits();
    r.register("q", rs(["app.posts"]), vis(100, 100), b);
    r.apply(150, txn(["app.posts"]));
    r.register("q", rs(["app.users"]), vis(160, 160), b);
    expect(r.dirtyCount).toBe(0);
    expect(r.apply(170, txn(["app.posts"]))).toEqual([]);
    r.remove("q");
    expect(r.apply(171, txn(["app.users"]))).toEqual([]);
    expect(r.size).toBe(0);
  });

  test("clearDirty and markDirty move a registered key in and out of the dirty set", () => {
    const r = new Registry<string>();
    r.register("q", rs(["app.posts"]), vis(100, 100), new RecentCommits());
    r.apply(150, txn(["app.posts"]));
    r.clearDirty("q");
    expect(r.dirtyCount).toBe(0);
    expect(r.markDirty("q")).toBe(true);
    expect(r.dirtyKeys()).toEqual(["q"]);
    expect(r.markDirty("nope")).toBe(false);
  });
});
