import { expect, test } from "bun:test";
import { functions } from "../../../src/runtime";
import { DrizzleBaseError, defineApi, registryOf, toWireError } from "../../../src/server";
import { EngineDownError } from "../../../src/subscriptions";

const { query, mutation } = functions<Record<string, never>>();
const list = query(async () => [1]);
const add = mutation(async () => 1);

test("defineApi maps nested keys to dotted names and returns the tree itself", () => {
  const api = defineApi({ posts: { list, add }, health: query(async () => "ok"), deep: { a: { b: list } } });
  expect(api.posts.list).toBe(list);
  const reg = registryOf(api);
  expect([...reg.keys()].sort()).toEqual(["deep.a.b", "health", "posts.add", "posts.list"]);
  expect(reg.get("posts.add")).toBe(add);
});

test("defineApi refuses a dotted key, a non-definition leaf, an empty tree, and an unregistered object", () => {
  expect(() => defineApi({ "a.b": list })).toThrow(/dot/);
  expect(() => defineApi({ posts: { list: 42 as never } })).toThrow(/not a query or a mutation/);
  expect(() => defineApi({})).toThrow(/empty/);
  expect(() => defineApi({ posts: {} })).toThrow(/empty/);
  expect(() => registryOf({ posts: { list } })).toThrow(/defineApi/);
});

test("only an application error carries its message; everything else is redacted", () => {
  expect(toWireError(new DrizzleBaseError("not yours", { id: 1n }))).toEqual({
    code: "app",
    message: "not yours",
    data: { id: { $t: "bigint", v: "1" } },
  });
  const secret = Object.assign(new Error("select * from users where email = 'a@b.c'"), {
    name: "PostgresError",
    errno: "23505",
  });
  const wrapped = Object.assign(new Error(`Failed query: insert ... params: a@b.c`), {
    name: "DrizzleQueryError",
    cause: secret,
  });
  const wire = toWireError(wrapped);
  expect(wire).toEqual({ code: "internal" });
  expect(JSON.stringify(wire)).not.toContain("a@b.c");
  expect(toWireError(new EngineDownError())).toEqual({ code: "unavailable" });
  class Weird {}
  expect(toWireError(new DrizzleBaseError("bad data", new Weird()))).toEqual({ code: "internal" });
});

test("toWireError never throws, whatever the application error holds", () => {
  const data = {
    get boom(): never {
      throw new Error("a getter that throws");
    },
  };
  expect(toWireError(new DrizzleBaseError("x", data))).toEqual({ code: "internal" });
});
