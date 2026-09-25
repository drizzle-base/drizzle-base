import { expect, test } from "bun:test";
import { StudioDataSourceError, tableId } from "../../src/contract";

test("a data-source error is an Error that carries its code", () => {
  const e = new StudioDataSourceError("read_only", '"public.v" is a view');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("StudioDataSourceError");
  expect(e.code).toBe("read_only");
  expect(e.message).toBe('"public.v" is a view');
});

test("tableId names a relation by schema and name", () => {
  expect(tableId({ schema: "billing", name: "invoices" })).toBe("billing.invoices");
});
