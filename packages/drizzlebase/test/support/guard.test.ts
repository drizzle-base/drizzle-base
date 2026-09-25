import { expect, test } from "bun:test";
import { assertTestDatabase } from "./db";

test("the guard refuses a database whose name lacks 'test'", () => {
  expect(() => assertTestDatabase("dzb_prod")).toThrow(/refusing/);
  expect(() => assertTestDatabase("")).toThrow(/refusing/);
});

test("the guard accepts the test database", () => {
  expect(() => assertTestDatabase("dzb_test")).not.toThrow();
});
