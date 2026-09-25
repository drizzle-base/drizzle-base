import { describe, expect, test } from "bun:test";
import type { Page, PageRequest, StudioDataSource } from "../../src/contract";
import {
  conformanceDataset,
  createBrowserLog,
  createLocalLocks,
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
    await ds.externalWrite();
    expect(log.readSince(0)).toHaveLength(1);
    expect(log.readSince(0)[0]?.op.kind).toBe("update");
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
    // Two browser logs are two tabs: the other tab's commit arrives by BroadcastChannel, later than the next build
    // may run, so a build must catch up from storage itself.
    const name = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const locks = createLocalLocks();
    const a = createMockDataSource({ dataset: demoDataset(1), log: createBrowserLog(name, { locks }) });
    const b = createMockDataSource({ dataset: demoDataset(1), log: createBrowserLog(name, { locks }) });
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
    await ds.insertRows({ schema: "billing", name: "invoices" }, [{ amount_cents: 1 }]);
    await tick();
    expect(pages).toHaveLength(1);
  });
});
