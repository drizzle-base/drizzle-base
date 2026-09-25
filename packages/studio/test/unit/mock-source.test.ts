import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { Page, PageRequest, StudioDataSource } from "../../src/contract";
import {
  conformanceDataset,
  createBrowserLog,
  createMemoryLog,
  createMockDataSource,
  demoDataset,
  type MockDataSource,
} from "../../src/mock";
import { describeConformance } from "../conformance";

describeConformance("mock", async () => {
  const log = createMemoryLog();
  const opened: MockDataSource[] = [];
  return {
    open: async () => {
      const ds = createMockDataSource({ dataset: conformanceDataset(), log });
      opened.push(ds);
      return ds;
    },
    close: async () => {
      for (const ds of opened) ds.close();
    },
  };
});

const USERS = { schema: "public", name: "users" };
const firstPage = (ds: StudioDataSource, r: Partial<PageRequest> = {}) =>
  new Promise<Page>((resolve, reject) => {
    const stop = ds.subscribePage(
      { table: USERS, filters: [], sort: [], limit: 50, offset: 0, ...r },
      (p) => {
        stop();
        resolve(p);
      },
      reject,
    );
  });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("mock data source", () => {
  test("an external write reaches pages open on other sources, marked external in the log", async () => {
    const log = createMemoryLog();
    const tab = createMockDataSource({ dataset: demoDataset(1), log });
    const psql = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    tab.subscribePage(
      { table: USERS, filters: [], sort: [], limit: 5, offset: 0 },
      (p) => pages.push(p),
      () => {},
    );
    await tick();
    const id = pages[0]?.rows[0]?.["id"] ?? null;
    await psql.externalWrite({
      kind: "update",
      table: USERS,
      changes: [{ key: { id }, values: { name: "from psql" } }],
    });
    await tick();
    expect(pages.at(-1)?.rows[0]?.["name"]).toBe("from psql");
    expect(log.readSince(0).map((e) => e.origin)).toEqual(["external"]);
  });

  test("externalWrite() with no argument changes some row and pushes", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log, seed: 7 });
    for (let i = 0; i < 20; i++) await ds.externalWrite();
    const ops = log.readSince(0).map((e) => e.op);
    expect(ops).toHaveLength(20);
    // It lands where a person is looking: among the first 20 rows (by key) of its table, so the first page shows it.
    const dataset = demoDataset(1);
    for (const op of ops) {
      expect(op.kind).toBe("update");
      if (op.kind !== "update") continue;
      const rows =
        dataset.tables.find((t) => t.info.schema === op.table.schema && t.info.name === op.table.name)?.rows ?? [];
      const firstKeys = rows.slice(0, 20).map((r) => JSON.stringify(r["id"] ?? null));
      expect(firstKeys).toContain(JSON.stringify(op.changes[0]?.key["id"] ?? "missing"));
    }
  });

  test("a source opened after writes replays the log", async () => {
    const log = createMemoryLog();
    const early = createMockDataSource({ dataset: demoDataset(1), log });
    const [key] = await early.insertRows(USERS, [{ email: "late@example.com" }]);
    const late = createMockDataSource({ dataset: demoDataset(1), log });
    const p = await firstPage(late, { filters: [{ column: "email", op: "eq", value: "late@example.com" }] });
    expect(p.rows.map((r) => r["id"])).toEqual([key?.["id"] ?? "missing"]);
    expect(p.revision).toBe(1);
  });

  test("concurrent inserts from two tabs get distinct serial ids", async () => {
    const name = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const idb = new IDBFactory();
    // Separate channels: neither hears the other, so only catching up from the store inside the commit prevents a clash.
    const tab = (id: string) =>
      createBrowserLog(name, { indexedDB: idb, openChannel: (n) => new BroadcastChannel(`${n}:${id}`) });
    const a = createMockDataSource({ dataset: demoDataset(1), log: await tab("a") });
    const b = createMockDataSource({ dataset: demoDataset(1), log: await tab("b") });
    const posts = { schema: "public", name: "posts" };
    const author = demoDataset(1).tables[0]?.rows[0]?.["id"] ?? null;
    const keys = await Promise.all([
      a.insertRows(posts, [{ author_id: author, title: "a" }]),
      b.insertRows(posts, [{ author_id: author, title: "b" }]),
    ]);
    const ids = keys.flat().map((k) => k["id"]);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual([1501, 1502]);
  });

  test("a reset returns every source to the dataset and re-pushes", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log });
    const other = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    other.subscribePage(
      { table: USERS, filters: [], sort: [], limit: 1, offset: 0 },
      (p) => pages.push(p),
      () => {},
    );
    await ds.insertRows(USERS, [{ email: "x@example.com" }]);
    await tick();
    expect(pages.at(-1)?.total).toBe(3001);
    await log.reset();
    await tick();
    expect(pages.at(-1)?.total).toBe(3000);
    // The contract: a page pushed because of a change carries a higher revision than any page before it.
    const revisions = pages.map((p) => p.revision);
    expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  test("latency delays the first page", async () => {
    const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog(), latencyMs: 40 });
    const t0 = performance.now();
    await firstPage(ds);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(35);
  });

  test("an unchanged result is not pushed again", async () => {
    const log = createMemoryLog();
    const ds = createMockDataSource({ dataset: demoDataset(1), log });
    const pages: Page[] = [];
    ds.subscribePage(
      { table: USERS, filters: [], sort: [], limit: 5, offset: 0 },
      (p) => pages.push(p),
      () => {},
    );
    await tick();
    const invoices: Page[] = [];
    ds.subscribePage(
      { table: { schema: "billing", name: "invoices" }, filters: [], sort: [], limit: 1, offset: 0 },
      (p) => invoices.push(p),
      () => {},
    );
    await tick();
    await ds.insertRows({ schema: "billing", name: "invoices" }, [{ amount_cents: 1 }]);
    await tick();
    // The premise: the write happened and did push where it changed something.
    expect(invoices.map((p) => p.total)).toEqual([100, 101]);
    expect(pages).toHaveLength(1);
  });
});
