import { expect, test } from "bun:test";
import { demoDataset } from "../../src/mock";
import { EMPTY_VIEW, toPageRequest } from "../../src/view";

const users = demoDataset(1).tables[0]?.info;
if (!users) throw new Error("demo dataset has no users table");

test("typed filters, sort, paging and withTotal reach the request", () => {
  const { req, ignored } = toPageRequest(
    {
      ...EMPTY_VIEW,
      table: "public.users",
      filters: [
        { column: "age", op: "gte", text: "30" },
        { column: "role", op: "in", text: "admin, editor" },
        { column: "name", op: "isNull", text: "" },
      ],
      sort: [{ column: "age", dir: "desc" }],
      limit: 100,
      offset: 100,
    },
    users,
    false,
  );
  expect(ignored).toEqual([]);
  expect(req).toEqual({
    table: { schema: "public", name: "users" },
    filters: [
      { column: "age", op: "gte", value: 30 },
      { column: "role", op: "in", value: ["admin", "editor"] },
      { column: "name", op: "isNull" },
    ],
    sort: [{ column: "age", dir: "desc" }],
    limit: 100,
    offset: 100,
    withTotal: false,
  });
});

test("the resolver lists what it ignored: unknown columns and values the column cannot hold", () => {
  const { req, ignored } = toPageRequest(
    {
      ...EMPTY_VIEW,
      table: "public.users",
      filters: [
        { column: "nope", op: "eq", text: "1" },
        { column: "age", op: "eq", text: "old" },
        { column: "email", op: "ilike", text: "%@example.com" },
      ],
      sort: [{ column: "gone", dir: "asc" }],
    },
    users,
    true,
  );
  expect(req.filters).toEqual([{ column: "email", op: "ilike", value: "%@example.com" }]);
  expect(req.sort).toEqual([]);
  expect(ignored).toEqual([
    'filter on "nope": no such column',
    'filter on "age": "old" is not an integer',
    'sort by "gone": no such column',
  ]);
});
