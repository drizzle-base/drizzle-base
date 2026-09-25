import { describe, expect, test } from "bun:test";
import { createBrowserLog, createLocalLocks, createMemoryLog, type LogEntry, type MockLog } from "../../src/mock/log";

const T = { schema: "public", name: "t" };
const entry = (label: string): Omit<LogEntry, "seq"> => ({
  op: { kind: "insert", table: T, rows: [{ label }] },
  origin: "studio",
});
const labels = (log: MockLog, since = 0) =>
  log.readSince(since).map((e) => (e.op.kind === "insert" ? e.op.rows[0]?.["label"] : null));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("memory log", () => {
  test("commits get consecutive sequence numbers; readSince returns what came after", async () => {
    const log = createMemoryLog();
    expect(await log.commit(() => entry("a"))).toBe(1);
    expect(await log.commit(() => entry("b"))).toBe(2);
    expect(labels(log)).toEqual(["a", "b"]);
    expect(labels(log, 1)).toEqual(["b"]);
  });

  test("builds run one at a time, each seeing the commits before it", async () => {
    const log = createMemoryLog();
    const seen: number[] = [];
    const seqs = await Promise.all(
      ["a", "b", "c"].map((l) =>
        log.commit(() => {
          seen.push(log.readSince(0).length);
          return entry(l);
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("a build that throws appends nothing and does not jam the log", async () => {
    const log = createMemoryLog();
    await expect(
      log.commit(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await log.commit(() => entry("a"))).toBe(1);
    expect(await log.commit(() => null)).toBeNull();
    expect(labels(log)).toEqual(["a"]);
  });

  test("every listener hears a commit, after the commit, never inside it", async () => {
    const log = createMemoryLog();
    const heard: string[] = [];
    log.onCommit(() => heard.push("x"));
    const stop = log.onCommit(() => heard.push("y"));
    const p = log.commit(() => entry("a"));
    expect(heard).toEqual([]);
    await p;
    await tick();
    expect(heard.sort()).toEqual(["x", "y"]);
    stop();
    await log.commit(() => entry("b"));
    await tick();
    expect(heard.sort()).toEqual(["x", "x", "y"]);
  });

  test("reset empties the log and changes the epoch", async () => {
    const log = createMemoryLog();
    await log.commit(() => entry("a"));
    const before = log.epoch();
    await log.reset();
    expect(log.readSince(0)).toEqual([]);
    expect(log.epoch()).not.toBe(before);
  });
});

describe("browser log", () => {
  // Two instances on one storage and one channel name are two tabs; happy-dom has no navigator.locks, so the tabs
  // share an in-process lock (the real Web Locks path runs in the Playwright test).
  const twoTabs = () => {
    const name = `t${crypto.randomUUID().replaceAll("-", "")}`;
    const locks = createLocalLocks();
    const a = createBrowserLog(name, { locks });
    const b = createBrowserLog(name, { locks });
    return { a, b };
  };

  test("a commit in one tab is announced to the other, which reads it from storage", async () => {
    const { a, b } = twoTabs();
    let heard = 0;
    b.onCommit(() => heard++);
    expect(await a.commit(() => entry("a"))).toBe(1);
    for (let i = 0; i < 50 && heard === 0; i++) await tick();
    expect(heard).toBe(1);
    expect(labels(b)).toEqual(["a"]);
    a.close();
    b.close();
  });

  test("sequence numbers continue across tabs", async () => {
    const { a, b } = twoTabs();
    expect(await a.commit(() => entry("a"))).toBe(1);
    expect(await b.commit(() => entry("b"))).toBe(2);
    expect(labels(a)).toEqual(["a", "b"]);
    a.close();
    b.close();
  });

  test("a reset in one tab empties the log for both and changes the epoch", async () => {
    const { a, b } = twoTabs();
    await a.commit(() => entry("a"));
    const before = b.epoch();
    await a.reset();
    expect(b.readSince(0)).toEqual([]);
    expect(b.epoch()).not.toBe(before);
    a.close();
    b.close();
  });
});
