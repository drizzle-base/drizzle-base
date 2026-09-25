import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createBrowserLog, createMemoryLog, type LogEntry, type MockLog } from "../../src/mock/log";

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
  // Two logs on one IndexedDB and one channel name are two tabs. IndexedDB here is fake-indexeddb, one factory per
  // "browser"; the real one runs in the Playwright test.
  const unique = () => `t${crypto.randomUUID().replaceAll("-", "")}`;
  const twoTabs = async () => {
    const name = unique();
    const idb = new IDBFactory();
    const a = await createBrowserLog(name, { indexedDB: idb });
    const b = await createBrowserLog(name, { indexedDB: idb });
    return { a, b };
  };
  const heardBy = (log: MockLog) => {
    let n = 0;
    log.onCommit(() => n++);
    return async (count: number) => {
      for (let i = 0; i < 100 && n < count; i++) await tick();
      return n;
    };
  };

  test("a commit in one tab is announced to the other, which can read it", async () => {
    const { a, b } = await twoTabs();
    const heard = heardBy(b);
    expect(await a.commit(() => entry("a"))).toBe(1);
    expect(await heard(1)).toBe(1);
    expect(labels(b)).toEqual(["a"]);
    a.close();
    b.close();
  });

  test("the entry travels in its message: a tab whose store view lags still applies it", async () => {
    // Chromium shows another tab's storage writes asynchronously; here tab B's store never sees tab A's write at all.
    const name = unique();
    const a = await createBrowserLog(name, { indexedDB: new IDBFactory() });
    const b = await createBrowserLog(name, { indexedDB: new IDBFactory() });
    const heard = heardBy(b);
    await a.commit(() => entry("a"));
    expect(await heard(1)).toBe(1);
    expect(labels(b)).toEqual(["a"]);
    a.close();
    b.close();
  });

  test("commits from two tabs at once get distinct, consecutive sequence numbers", async () => {
    // The store is the serial point, not the messages: these tabs share IndexedDB but hear nothing from each other.
    const name = unique();
    const idb = new IDBFactory();
    const a = await createBrowserLog(name, { indexedDB: idb, openChannel: (n) => new BroadcastChannel(`${n}:a`) });
    const b = await createBrowserLog(name, { indexedDB: idb, openChannel: (n) => new BroadcastChannel(`${n}:b`) });
    const seqs = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).commit(() => entry(`e${i}`))));
    expect([...seqs].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    a.close();
    b.close();
  });

  test("a tab opened later replays the stored log", async () => {
    const name = unique();
    const idb = new IDBFactory();
    const a = await createBrowserLog(name, { indexedDB: idb });
    await a.commit(() => entry("a"));
    await a.commit(() => entry("b"));
    const late = await createBrowserLog(name, { indexedDB: idb });
    expect(labels(late)).toEqual(["a", "b"]);
    a.close();
    late.close();
  });

  test("a build that throws commits nothing", async () => {
    const { a, b } = await twoTabs();
    await expect(
      a.commit(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await b.commit(() => entry("x"))).toBe(1);
    a.close();
    b.close();
  });

  test("a reset in one tab empties the log for both and changes the epoch", async () => {
    const { a, b } = await twoTabs();
    const heard = heardBy(b);
    await a.commit(() => entry("a"));
    expect(await heard(1)).toBe(1);
    const before = b.epoch();
    await a.reset();
    expect(await heard(2)).toBe(2);
    expect(b.readSince(0)).toEqual([]);
    expect(b.epoch()).not.toBe(before);
    a.close();
    b.close();
  });
});
