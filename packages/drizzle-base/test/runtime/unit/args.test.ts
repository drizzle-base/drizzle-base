// Optional args validation through Standard Schema (the interface zod, valibot and arktype implement): a local
// schema object stands in for them, so no validator library is a dependency.
import { expect, test } from "bun:test";
import { functions, type StandardSchemaV1, validateArgs } from "../../../src/runtime";

type Issue = { message: string };
const idSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) => {
      const o = v as { id?: unknown };
      if (typeof o?.id !== "string") return { issues: [{ message: "id must be a string" }] as Issue[] };
      return { value: { id: o.id.trim() } }; // a transform: the handler sees the OUTPUT
    },
  },
};
const asyncSchema: StandardSchemaV1<{ n: number }, { n: number }> = {
  "~standard": { version: 1, vendor: "test", validate: async (v) => ({ value: v as { n: number } }) },
};

const { query, mutation } = functions<Record<string, never>>();

test("a definition without a schema passes the decoded args through", async () => {
  const q = query(async (_ctx, a: { x: number }) => a.x);
  expect(await validateArgs(q, { x: 1 })).toEqual({ ok: true, value: { x: 1 } });
});

test("a schema's output is what the handler gets; its issues refuse the call", async () => {
  const q = query({ args: idSchema, handler: async (_ctx, a) => a.id });
  expect(await validateArgs(q, { id: "  u1 " })).toEqual({ ok: true, value: { id: "u1" } });
  expect(await validateArgs(q, { id: 7 })).toEqual({ ok: false, issues: ["id must be a string"] });
  const m = mutation({ args: asyncSchema, handler: async (_ctx, a) => a.n });
  expect(await validateArgs(m, { n: 2 })).toEqual({ ok: true, value: { n: 2 } });
});
