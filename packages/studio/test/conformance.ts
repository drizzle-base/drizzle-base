// What every StudioDataSource must do, whatever sits behind it. The mock passes it now; the drizzle-base adapter
// must pass it unchanged. It runs against the relations of src/mock/datasets/conformance.ts, empty at the start of
// each test; `open()` returns another client of the same backend (another tab).
import { describe, expect, test } from "bun:test";
import {
  type Page,
  type PageRequest,
  type Row,
  type StudioDataSource,
  StudioDataSourceError,
  type StudioErrorCode,
} from "../src/contract";

export interface ConformanceBackend {
  open(): Promise<StudioDataSource>;
  close(): Promise<void>;
}

const ITEMS = { schema: "conformance", name: "items" };
const VIEW = { schema: "conformance", name: "items_view" };
const LOG = { schema: "conformance", name: "log" };

const req = (over: Partial<PageRequest> = {}): PageRequest => ({
  table: ITEMS,
  filters: [],
  sort: [],
  limit: 50,
  offset: 0,
  ...over,
});

async function until<T>(get: () => T | undefined, what: string, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function watch(ds: StudioDataSource, r: PageRequest) {
  const pages: Page[] = [];
  const errors: Error[] = [];
  const stop = ds.subscribePage(
    r,
    (p) => pages.push(p),
    (e) => errors.push(e),
  );
  return {
    pages,
    errors,
    stop,
    latest: (pred: (p: Page) => boolean = () => true, what = "a page") => until(() => pages.findLast(pred), what),
  };
}

const labels = (p: Page) => p.rows.map((r) => r["label"]);

async function expectCode(p: Promise<unknown>, code: StudioErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StudioDataSourceError);
    expect((e as StudioDataSourceError).code).toBe(code);
    return;
  }
  throw new Error(`expected a StudioDataSourceError "${code}"`);
}

// alpha(rank 3, note NULL), beta(1, "n"), gamma(NULL, "x"), delta(2, NULL), inserted in this order (ids ascending).
const SEED: Row[] = [
  { label: "alpha", rank: 3, note: null },
  { label: "beta", rank: 1, note: "n" },
  { label: "gamma", rank: null, note: "x" },
  { label: "delta", rank: 2, note: null },
];

export function describeConformance(name: string, makeBackend: () => Promise<ConformanceBackend>): void {
  const it = (title: string, body: (open: () => Promise<StudioDataSource>) => Promise<void>) =>
    test(title, async () => {
      const backend = await makeBackend();
      try {
        await body(() => backend.open());
      } finally {
        await backend.close();
      }
    });

  describe(`StudioDataSource conformance: ${name}`, () => {
    it("lists tables and views with their shape", async (open) => {
      const tables = await (await open()).listTables();
      const items = tables.find((t) => t.schema === "conformance" && t.name === "items");
      expect(items?.kind).toBe("table");
      expect(items?.primaryKey).toEqual(["id"]);
      expect(items?.columns.find((c) => c.name === "id")).toMatchObject({ isPrimaryKey: true, hasDefault: true });
      expect(items?.columns.find((c) => c.name === "label")).toMatchObject({ kind: "text", nullable: false });
      expect(tables.find((t) => t.name === "items_view")).toMatchObject({ kind: "view", primaryKey: [] });
      expect(tables.find((t) => t.name === "log")).toMatchObject({ kind: "table", primaryKey: [] });
    });

    it("pushes the first page asynchronously, never inside subscribePage", async (open) => {
      const ds = await open();
      let called = false;
      const stop = ds.subscribePage(
        req(),
        () => {
          called = true;
        },
        () => {},
      );
      expect(called).toBe(false);
      await until(() => (called ? true : undefined), "the first page");
      stop();
    });

    it("an insert re-pushes the page with a higher revision; defaults fill omitted columns", async (open) => {
      const ds = await open();
      const w = watch(ds, req());
      const first = await w.latest();
      const keys = await ds.insertRows(ITEMS, [{ label: "new" }]);
      expect(keys).toEqual([{ id: expect.any(Number) }]);
      const p = await w.latest((x) => labels(x).includes("new"), "the inserted row");
      expect(p.revision).toBeGreaterThan(first.revision);
      expect(p.total).toBe((first.total ?? 0) + 1);
      expect(p.rows.find((r) => r["label"] === "new")).toEqual({
        id: keys[0]?.["id"] ?? -1,
        label: "new",
        rank: null,
        note: null,
      });
      w.stop();
    });

    it("an update re-pushes the changed row", async (open) => {
      const ds = await open();
      const [key] = await ds.insertRows(ITEMS, [{ label: "before" }]);
      const w = watch(ds, req());
      await w.latest((p) => labels(p).includes("before"));
      await ds.updateRows(ITEMS, [{ key: key ?? {}, values: { label: "after", rank: 7 } }]);
      const p = await w.latest((x) => labels(x).includes("after"), "the updated row");
      expect(p.rows.find((r) => r["label"] === "after")?.["rank"]).toBe(7);
      w.stop();
    });

    it("a delete removes the row from open pages and from the total", async (open) => {
      const ds = await open();
      const keys = await ds.insertRows(ITEMS, SEED);
      const w = watch(ds, req());
      await w.latest((p) => p.total === 4);
      await ds.deleteRows(ITEMS, [keys[1] ?? {}]);
      const p = await w.latest((x) => x.total === 3, "the page without the deleted row");
      expect(labels(p)).toEqual(["alpha", "gamma", "delta"]);
      w.stop();
    });

    it("a write through one client re-pushes a page open on another", async (open) => {
      const tabA = await open();
      const tabB = await open();
      const w = watch(tabB, req());
      await w.latest();
      await tabA.insertRows(ITEMS, [{ label: "from A" }]);
      await w.latest((p) => labels(p).includes("from A"), "tab A's row in tab B");
      w.stop();
    });

    it("a view re-pushes when its base table changes", async (open) => {
      const ds = await open();
      const w = watch(ds, req({ table: VIEW }));
      await w.latest();
      await ds.insertRows(ITEMS, [{ label: "seen through the view" }]);
      await w.latest((p) => labels(p).includes("seen through the view"), "the row in the view");
      w.stop();
    });

    it("unsubscribing stops pushes", async (open) => {
      const ds = await open();
      const w = watch(ds, req());
      const control = watch(ds, req());
      await w.latest();
      await control.latest();
      w.stop();
      const count = w.pages.length;
      await ds.insertRows(ITEMS, [{ label: "unseen" }]);
      // The premise: this insert does push to a page that is still open.
      await control.latest((p) => labels(p).includes("unseen"), "the insert on the control subscription");
      expect(w.pages.length).toBe(count);
      control.stop();
    });

    it("filters, with SQL NULL semantics, combined with AND", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const cases: [PageRequest["filters"], string[]][] = [
        [[{ column: "label", op: "eq", value: "alpha" }], ["alpha"]],
        [[{ column: "rank", op: "neq", value: 3 }], ["beta", "delta"]],
        [[{ column: "rank", op: "lt", value: 3 }], ["beta", "delta"]],
        [[{ column: "rank", op: "lte", value: 2 }], ["beta", "delta"]],
        [[{ column: "rank", op: "gt", value: 1 }], ["alpha", "delta"]],
        [[{ column: "rank", op: "gte", value: 3 }], ["alpha"]],
        [[{ column: "label", op: "like", value: "_e%" }], ["beta", "delta"]],
        [[{ column: "label", op: "ilike", value: "B%" }], ["beta"]],
        [[{ column: "label", op: "notLike", value: "%ta" }], ["alpha", "gamma"]],
        [[{ column: "rank", op: "in", value: [1, 3] }], ["alpha", "beta"]],
        [[{ column: "note", op: "isNull" }], ["alpha", "delta"]],
        [[{ column: "note", op: "isNotNull" }], ["beta", "gamma"]],
        [
          [
            { column: "rank", op: "gte", value: 1 },
            { column: "note", op: "isNull" },
          ],
          ["alpha", "delta"],
        ],
      ];
      for (const [filters, expected] of cases) {
        const w = watch(ds, req({ filters }));
        expect({ filters, labels: labels(await w.latest()) }).toEqual({ filters, labels: expected });
        w.stop();
      }
    });

    it("sorts: multi-column, ASC NULLS LAST, DESC NULLS FIRST, ties by primary key", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const cases: [PageRequest["sort"], string[]][] = [
        [[{ column: "rank", dir: "asc" }], ["beta", "delta", "alpha", "gamma"]],
        [[{ column: "rank", dir: "desc" }], ["gamma", "alpha", "delta", "beta"]],
        [[{ column: "note", dir: "asc" }], ["beta", "gamma", "alpha", "delta"]],
        [
          [
            { column: "note", dir: "asc" },
            { column: "label", dir: "desc" },
          ],
          ["beta", "gamma", "delta", "alpha"],
        ],
      ];
      for (const [sort, expected] of cases) {
        const w = watch(ds, req({ sort }));
        expect({ sort, labels: labels(await w.latest()) }).toEqual({ sort, labels: expected });
        w.stop();
      }
    });

    it("limit and offset page the ordered rows; total counts them all", async (open) => {
      const ds = await open();
      await ds.insertRows(ITEMS, SEED);
      const w = watch(ds, req({ limit: 2, offset: 1 }));
      const p = await w.latest();
      expect(labels(p)).toEqual(["beta", "gamma"]);
      expect(p.total).toBe(4);
      w.stop();
    });

    it("read-only relations refuse writes: views and tables without a primary key", async (open) => {
      const ds = await open();
      for (const t of [VIEW, LOG]) {
        await expectCode(ds.insertRows(t, [{ label: "x", msg: "x" }]), "read_only");
        await expectCode(ds.updateRows(t, [{ key: { id: 1 }, values: { label: "x" } }]), "read_only");
        await expectCode(ds.deleteRows(t, [{ id: 1 }]), "read_only");
      }
    });

    it("an insert missing a NOT NULL column without default is refused and commits nothing", async (open) => {
      const ds = await open();
      await expectCode(ds.insertRows(ITEMS, [{ label: "ok" }, { rank: 1 }]), "not_null");
      const w = watch(ds, req());
      expect((await w.latest()).total).toBe(0);
      w.stop();
    });

    it("a primary key already taken is refused, on insert and on update, and commits nothing", async (open) => {
      const ds = await open();
      const [a, b] = await ds.insertRows(ITEMS, [{ label: "a" }, { label: "b" }]);
      await expectCode(ds.insertRows(ITEMS, [{ id: a?.["id"] ?? null, label: "clash" }]), "unique_violation");
      await expectCode(
        ds.insertRows(ITEMS, [
          { id: 99, label: "x" },
          { id: 99, label: "y" },
        ]),
        "unique_violation",
      );
      await expectCode(ds.updateRows(ITEMS, [{ key: b ?? {}, values: { id: a?.["id"] ?? null } }]), "unique_violation");
      const w = watch(ds, req());
      expect(labels(await w.latest())).toEqual(["a", "b"]);
      w.stop();
    });

    it("unknown tables and columns are reported with their codes", async (open) => {
      const ds = await open();
      const bad = watch(ds, req({ filters: [{ column: "nope", op: "isNull" }] }));
      const e1 = await until(() => bad.errors[0], "an unknown_column error");
      expect((e1 as StudioDataSourceError).code).toBe("unknown_column");
      bad.stop();
      const missing = watch(ds, req({ table: { schema: "conformance", name: "nope" } }));
      const e2 = await until(() => missing.errors[0], "an unknown_table error");
      expect((e2 as StudioDataSourceError).code).toBe("unknown_table");
      missing.stop();
      await expectCode(ds.insertRows({ schema: "conformance", name: "nope" }, [{}]), "unknown_table");
      await expectCode(ds.updateRows(ITEMS, [{ key: { id: 1 }, values: { nope: 1 } }]), "unknown_column");
    });
  });
}
