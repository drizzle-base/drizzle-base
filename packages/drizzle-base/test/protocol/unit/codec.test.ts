import { expect, test } from "bun:test";
import { DecodeError, decodeValue, EncodeError, encodeValue, MAX_DEPTH } from "../../../src/protocol";

const roundTrip = (v: unknown) => decodeValue(JSON.parse(JSON.stringify(encodeValue(v))));

test("what JSON loses in a Drizzle result survives: dates, bigints, bytes, nested", () => {
  const v = {
    at: new Date("2026-09-25T12:00:00.000Z"),
    n: 12345678901234567890n,
    raw: new Uint8Array([0, 1, 254, 255]),
    list: [1, "a", null, { deep: [new Date(0)] }],
  };
  expect(roundTrip(v)).toEqual(v);
  expect(roundTrip(Buffer.from("hi"))).toEqual(new Uint8Array([104, 105]));
});

test("an application object that looks like a tag comes back as itself", () => {
  const looksLikeTag = { $t: "date", v: "not a date" };
  expect(roundTrip(looksLikeTag)).toEqual(looksLikeTag);
  expect(roundTrip([{ $t: "obj", v: {} }])).toEqual([{ $t: "obj", v: {} }]);
});

test("undefined behaves as JSON: dropped in objects, null in arrays and at the top", () => {
  expect(roundTrip({ a: undefined, b: 1 })).toEqual({ b: 1 });
  expect(roundTrip([undefined])).toEqual([null]);
  expect(roundTrip(undefined)).toBeNull();
});

test("what cannot be sent faithfully is refused, never turned into {} or null", () => {
  class Point {
    constructor(readonly x: number) {}
  }
  for (const bad of [
    new Point(1),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => 1,
    Symbol("s"),
    new Date("x"),
    new Map(),
  ])
    expect(() => encodeValue(bad)).toThrow(EncodeError);
});

test("prototype keys are refused on decode (a JSON __proto__ is an own key until copied)", () => {
  expect(() => decodeValue(JSON.parse('{"a":{"__proto__":{"isAdmin":true}}}'))).toThrow(DecodeError);
  expect(() => decodeValue(JSON.parse('{"$t":"obj","v":{"__proto__":{"x":1}}}'))).toThrow(DecodeError);
  expect(() => decodeValue({ constructor: 1 })).toThrow(DecodeError);
  expect(() => decodeValue({ prototype: 1 })).toThrow(DecodeError);
});

test("nesting deeper than MAX_DEPTH is refused both ways, and an unknown tag is refused", () => {
  let deep: unknown = 1;
  for (let i = 0; i <= MAX_DEPTH; i++) deep = [deep];
  expect(() => encodeValue(deep)).toThrow(EncodeError);
  expect(() => decodeValue(deep)).toThrow(DecodeError);
  let ok: unknown = 1;
  for (let i = 0; i < MAX_DEPTH - 1; i++) ok = [ok];
  expect(roundTrip(ok)).toEqual(ok);
  expect(() => decodeValue({ $t: "regexp", v: "x" })).toThrow(DecodeError);
});
