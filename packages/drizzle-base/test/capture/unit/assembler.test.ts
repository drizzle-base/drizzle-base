import { describe, expect, test } from "bun:test";
import type { Pgoutput } from "pg-logical-replication";
import { BARRIER_PREFIX, DDL_PREFIX, type StreamEvent, TxnAssembler } from "../../../src/capture";

const rel = (
  name: string,
  replicaIdentity: Pgoutput.MessageRelation["replicaIdentity"] = "full",
  oid = 1,
): Pgoutput.MessageRelation => ({
  tag: "relation",
  relationOid: oid,
  schema: "app",
  name,
  replicaIdentity,
  columns: [],
  keyColumns: ["id"],
});
const begin = (xid: number): Pgoutput.MessageBegin => ({ tag: "begin", commitLsn: "0/10", commitTime: 0n, xid });
const commit = (end = "0/20"): Pgoutput.MessageCommit => ({
  tag: "commit",
  flags: 0,
  commitLsn: "0/10",
  commitEndLsn: end,
  commitTime: 0n,
});
const bytes = (s: string) => new TextEncoder().encode(s);
const run = (a: TxnAssembler, msgs: Pgoutput.Message[]) =>
  msgs.map((m) => a.feed(m)).filter((e): e is StreamEvent => e !== null);

describe("TxnAssembler", () => {
  test("insert, update, delete become one transaction at commit", () => {
    const t = rel("posts");
    const out = run(new TxnAssembler(100), [
      begin(7),
      { tag: "insert", relation: t, new: { id: 1, v: 1 } },
      { tag: "update", relation: t, key: null, old: { id: 1, v: 1 }, new: { id: 1, v: 2 } },
      { tag: "delete", relation: t, key: null, old: { id: 1, v: 2 } },
      commit("0/99"),
    ]);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    if (ev.kind !== "txn") throw new Error("expected a txn");
    expect(ev.txn.xid).toBe(7);
    expect(ev.txn.commitEndLsn).toBe("0/99");
    expect(ev.txn.changes.map((c) => [c.op, c.table, c.old, c.new])).toEqual([
      ["insert", "app.posts", null, { id: 1, v: 1 }],
      ["update", "app.posts", { id: 1, v: 1 }, { id: 1, v: 2 }],
      ["delete", "app.posts", { id: 1, v: 2 }, null],
    ]);
    expect([...ev.txn.wholeTables]).toEqual([]);
  });

  test("update on a non-FULL relation marks the table whole", () => {
    const t = rel("users", "default");
    const [ev] = run(new TxnAssembler(100), [
      begin(1),
      { tag: "update", relation: t, key: { id: 1 }, old: null, new: { id: 1 } },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect([...ev.txn.wholeTables]).toEqual(["app.users"]);
  });

  test("a partial old image (key columns only) on a non-FULL relation is still whole", () => {
    // pgoutput sends only a key tuple ('K') unless the relation is FULL; if a parser ever surfaced it as `old`,
    // evaluating predicates on it would read missing columns as NULL — a narrowing, so the table must be whole.
    const [ev] = run(new TxnAssembler(100), [
      begin(1),
      { tag: "update", relation: rel("users", "index"), key: null, old: { id: 1 }, new: { id: 1, v: 2 } },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect([...ev.txn.wholeTables]).toEqual(["app.users"]);
    expect(ev.txn.changes).toEqual([]);
  });

  test("delete without an old image marks the table whole", () => {
    const [ev] = run(new TxnAssembler(100), [
      begin(1),
      { tag: "delete", relation: rel("c"), key: { id: 1 }, old: null },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect([...ev.txn.wholeTables]).toEqual(["app.c"]);
  });

  test("truncate marks every listed relation whole", () => {
    const [ev] = run(new TxnAssembler(100), [
      begin(1),
      { tag: "truncate", cascade: true, restartIdentity: false, relations: [rel("p"), rel("c", "full", 2)] },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect([...ev.txn.wholeTables].sort()).toEqual(["app.c", "app.p"]);
  });

  test("past the row cap images are dropped and the table is whole", () => {
    const t = rel("big");
    const msgs: Pgoutput.Message[] = [begin(1)];
    for (let i = 0; i < 25; i++) msgs.push({ tag: "insert", relation: t, new: { id: i } });
    msgs.push(commit());
    const [ev] = run(new TxnAssembler(10), msgs);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect(ev.txn.changes).toHaveLength(10);
    expect([...ev.txn.wholeTables]).toEqual(["app.big"]);
  });

  test("a transactional ddl message flags the transaction", () => {
    const [ev] = run(new TxnAssembler(10), [
      begin(1),
      {
        tag: "message",
        flags: 1,
        transactional: true,
        messageLsn: "0/11",
        prefix: DDL_PREFIX,
        content: bytes("ALTER TABLE"),
      },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect(ev.txn.ddl).toBe(true);
  });

  test("a non-transactional barrier is its own event, even between transactions", () => {
    const out = run(new TxnAssembler(10), [
      {
        tag: "message",
        flags: 0,
        transactional: false,
        messageLsn: "0/42",
        prefix: BARRIER_PREFIX,
        content: bytes("b-1"),
      },
    ]);
    expect(out).toEqual([{ kind: "barrier", id: "b-1", lsn: "0/42" }]);
  });

  test("messages with other prefixes are ignored", () => {
    const out = run(new TxnAssembler(10), [
      {
        tag: "message",
        flags: 0,
        transactional: false,
        messageLsn: "0/1",
        prefix: "someone.else",
        content: bytes("x"),
      },
    ]);
    expect(out).toEqual([]);
  });

  test("xid and relation OID are unsigned 32-bit, even when the reader returned them signed", () => {
    // The library reads both with readInt32: anything ≥ 2^31 (half of all xids after wraparound) comes back negative.
    const signed = 0xb2d05e00 | 0;
    const [ev] = run(new TxnAssembler(10), [
      begin(signed),
      { tag: "insert", relation: rel("t", "full", signed), new: { id: 1 } },
      commit(),
    ]);
    if (ev?.kind !== "txn") throw new Error("expected a txn");
    expect(ev.txn.xid).toBe(3_000_000_000);
    expect(ev.txn.changes[0]!.relOid).toBe(3_000_000_000);
  });

  test("a change outside begin/commit is a protocol error, not silently dropped", () => {
    expect(() => new TxnAssembler(10).feed({ tag: "insert", relation: rel("x"), new: { id: 1 } })).toThrow(
      /outside a transaction/,
    );
  });
});
