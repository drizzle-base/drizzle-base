import { expect, test } from "bun:test";
import { stableHash } from "../../../src/subscriptions";

test("key order does not matter; values, dates, bigints, bytes, maps and sets do", () => {
  expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  expect(stableHash(new Date(0))).not.toBe(stableHash(new Date(1)));
  expect(stableHash({ n: 1n })).not.toBe(stableHash({ n: 2n }));
  expect(stableHash(new Uint8Array([1]))).not.toBe(stableHash(new Uint8Array([2])));
  expect(stableHash(new Map([["a", 1]]))).not.toBe(stableHash(new Map([["a", 2]])));
  expect(stableHash(new Set([1]))).not.toBe(stableHash(new Set([2])));
  expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  expect(stableHash(undefined)).toBe(stableHash(null));
});

test("an unknown class instance never compares equal (always pushed): widening, not silence", () => {
  class Point {
    constructor(readonly x: number) {}
  }
  expect(stableHash(new Point(1))).not.toBe(stableHash(new Point(1)));
});
