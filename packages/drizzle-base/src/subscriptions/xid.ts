// Rule B (spec D7): a streamed transaction is reflected in a result iff its xid is visible in the result's
// snapshot. The stream's xids are 32-bit; pg_current_snapshot() is xid8. Both compare modulo 2^32 like Postgres's
// TransactionIdPrecedes (spec P-M5): live xids are within 2^31 of each other.
import type { Snapshot } from "../runtime";

const U32 = 2n ** 32n;
export const low32 = (x: bigint): number => Number(x % U32);

export function xidPrecedes(a: number, b: number): boolean {
  return ((a - b) | 0) < 0;
}

export interface Visibility {
  xmin: number;
  xmax: number;
  xip: ReadonlySet<number>;
}

export function visibilityOf(s: Snapshot): Visibility {
  return { xmin: low32(s.xmin), xmax: low32(s.xmax), xip: new Set(s.xip.map(low32)) };
}

export function visibleIn(xid: number, v: Visibility): boolean {
  if (xidPrecedes(xid, v.xmin)) return true;
  if (!xidPrecedes(xid, v.xmax)) return false;
  return !v.xip.has(xid);
}

// outer ⊇ inner: every transaction visible in inner is visible in outer. A cycle re-runs an entry at S only if S
// contains the snapshot of the value the subscribers already have — otherwise the push would go back in time.
export function contains(outer: Visibility, inner: Visibility): boolean {
  if (xidPrecedes(outer.xmax, inner.xmax)) return false; // inner saw transactions outer had not started
  for (const x of outer.xip) if (xidPrecedes(x, inner.xmax) && visibleIn(x, inner)) return false; // running in outer, done in inner
  return true;
}
