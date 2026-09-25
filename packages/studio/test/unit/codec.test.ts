import { describe, expect, test } from "bun:test";
import { decodeView, EMPTY_VIEW, encodeView, type StudioView } from "../../src/view";

const view = (over: Partial<StudioView>): StudioView => ({ ...EMPTY_VIEW, ...over });

describe("encodeView", () => {
  test("a readable, stable link", () => {
    const v = view({
      table: "public.users",
      filters: [
        { column: "role", op: "in", text: "admin,editor" },
        { column: "name", op: "isNull", text: "" },
      ],
      sort: [
        { column: "age", dir: "desc" },
        { column: "id", dir: "asc" },
      ],
      limit: 100,
      offset: 200,
    });
    expect(decodeURIComponent(encodeView(v)).replaceAll("+", " ")).toBe(
      "v=1&table=public.users&where=role.in.admin,editor&where=name.isnull&order=age.desc,id.asc&limit=100&offset=200",
    );
  });
  test("defaults are left out; no table means an empty string", () => {
    expect(encodeView(view({ table: "public.t" }))).toBe("v=1&table=public.t");
    expect(encodeView(EMPTY_VIEW)).toBe("");
  });
});

describe("round trip", () => {
  const cases: StudioView[] = [
    view({ table: "public.users", filters: [{ column: "name", op: "ilike", text: "a.b %c, d & e=f" }] }),
    view({ table: 'odd."schema".t', filters: [{ column: 'my.col "x"', op: "eq", text: "1.5" }] }),
    view({
      table: "t",
      filters: [{ column: "tags", op: "in", text: '"a,b", c' }],
      sort: [{ column: "a,b", dir: "asc" }],
    }),
    view({ table: "t", filters: [{ column: "n", op: "notLike", text: "" }] }),
  ];
  for (const v of cases) {
    test(JSON.stringify(v.filters), () => {
      expect(decodeView(`?${encodeView(v)}`)).toEqual({ view: v, errors: [] });
    });
  }
});

describe("decodeView", () => {
  test("a bad piece is reported and skipped; the rest is kept", () => {
    const { view: v, errors } = decodeView("?v=1&table=public.users&where=role.bogus.1&where=age.gt.3&limit=-5");
    expect(v).toEqual(view({ table: "public.users", filters: [{ column: "age", op: "gt", text: "3" }] }));
    expect(errors).toEqual([
      'filter "role.bogus.1": not column.operator.value',
      'limit "-5": not a whole number from 1 to 1000',
    ]);
  });
  test("a link cannot ask for any page size: digits only, at most the largest page size", () => {
    for (const limit of ["1000000000", "0x32", "1e3", "0", ""]) {
      const { view: v, errors } = decodeView(`?table=t&limit=${limit}`);
      expect({ limit, got: v.limit, errors: errors.length }).toEqual({ limit, got: 50, errors: 1 });
    }
    expect(decodeView("?table=t&limit=500").view.limit).toBe(500);
    expect(decodeView("?table=t&offset=%2B7").errors).toEqual(['offset "+7": not a whole number from 0']);
  });
  test("an unknown version is ignored as a whole", () => {
    expect(decodeView("?v=2&table=public.users")).toEqual({
      view: EMPTY_VIEW,
      errors: ['link version "2" (this studio reads version 1)'],
    });
  });
  test("parameters that are not the studio's are left alone; a link without v reads as v1", () => {
    expect(decodeView("?latency=300&table=public.t").view).toEqual(view({ table: "public.t" }));
  });
});
