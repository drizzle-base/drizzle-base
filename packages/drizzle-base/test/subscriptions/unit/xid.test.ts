import { describe, expect, test } from "bun:test";
import { lsnToBigInt } from "../../../src/capture";
import { contains, low32, visibleIn, xidPrecedes } from "../../../src/subscriptions";

const vis = (xmin: number, xmax: number, xip: number[] = []) => ({ xmin, xmax, xip: new Set(xip) });

describe("visibleIn (rule B)", () => {
  test("before xmin visible; at or after xmax not; in between visible unless running", () => {
    const v = vis(100, 110, [103, 107]);
    expect(visibleIn(99, v)).toBe(true);
    expect(visibleIn(100, vis(100, 110, [100]))).toBe(false);
    expect(visibleIn(103, v)).toBe(false);
    expect(visibleIn(105, v)).toBe(true);
    expect(visibleIn(110, v)).toBe(false);
  });

  test("across the 2^32 wraparound", () => {
    const v = vis(0xffff_fff0, 0x0000_0010, [0x0000_0005]);
    expect(visibleIn(0xffff_ffe0, v)).toBe(true);
    expect(visibleIn(0xffff_fff8, v)).toBe(true);
    expect(visibleIn(0x0000_0003, v)).toBe(true);
    expect(visibleIn(0x0000_0005, v)).toBe(false);
    expect(visibleIn(0x0000_0020, v)).toBe(false);
    expect(xidPrecedes(0xffff_fff0, 0x0000_0010)).toBe(true);
    expect(low32((5n << 32n) + 42n)).toBe(42);
  });
});

describe("contains(outer, inner): outer saw everything inner saw", () => {
  test("a later snapshot contains an earlier one; not the reverse", () => {
    const early = vis(100, 105, [102]);
    const late = vis(103, 110, [106]);
    expect(contains(late, early)).toBe(true);
    expect(contains(early, late)).toBe(false);
  });
  test("a transaction running in outer but finished in inner breaks containment", () => {
    expect(contains(vis(100, 110, [104]), vis(100, 108, []))).toBe(false);
  });
  test("equal snapshots contain each other", () => {
    expect(contains(vis(100, 110, [104]), vis(100, 110, [104]))).toBe(true);
  });
});

test("lsnToBigInt: Postgres's and the replication library's spellings are one position", () => {
  expect(lsnToBigInt("1/343C4E8")).toBe(lsnToBigInt("00000001/0343C4E8"));
  expect(lsnToBigInt("1/0")).toBeGreaterThan(lsnToBigInt("0/FFFFFFFF"));
});
