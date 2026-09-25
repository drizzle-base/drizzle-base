import type { Row, RowKey, TableRef, Unsubscribe } from "../contract";

export type Op =
  | { kind: "insert"; table: TableRef; rows: Row[] }
  | { kind: "update"; table: TableRef; changes: { key: RowKey; values: Row }[] }
  | { kind: "delete"; table: TableRef; keys: RowKey[] }
  | { kind: "edit"; table: TableRef; rows: Row[]; changes: { key: RowKey; values: Row }[] };

export interface LogEntry {
  seq: number;
  op: Op;
  origin: "studio" | "external";
}

/**
 * The mock's WAL: an ordered, shared record of every committed write. A data source applies writes only by reading
 * this log back — its own included — so every tab converges on the same state in the same order.
 */
export interface MockLog {
  /** Changes on reset(): a data source that sees a new epoch rebuilds from its dataset. */
  epoch(): string;
  readSince(seq: number): LogEntry[];
  /** Runs `build` under an exclusive lock across every tab; its entry, if any, gets the next sequence number. */
  commit(build: () => Omit<LogEntry, "seq"> | null): Promise<number | null>;
  /** Fires in every tab after a commit (the writer's included), never synchronously inside commit(). */
  onCommit(listener: () => void): Unsubscribe;
  reset(): Promise<void>;
  close(): void;
}

export interface LockLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

/** One lock per name, in this process: callbacks run strictly one after another, whatever they throw. */
export function createLocalLocks(): LockLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export function createMemoryLog(): MockLog {
  let entries: LogEntry[] = [];
  let epoch = 0;
  const listeners = new Set<() => void>();
  const locks = createLocalLocks();
  const announce = () =>
    queueMicrotask(() => {
      for (const l of [...listeners]) l();
    });
  return {
    epoch: () => String(epoch),
    readSince: (seq) => entries.slice(seq),
    commit: (build) =>
      locks.request("commit", () => {
        const e = build();
        if (!e) return null;
        const seq = entries.length + 1;
        entries.push({ ...e, seq });
        announce();
        return seq;
      }),
    onCommit(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () =>
      locks.request("commit", () => {
        entries = [];
        epoch++;
        announce();
      }),
    close() {
      listeners.clear();
    },
  };
}

export interface BrowserLogDeps {
  indexedDB: IDBFactory;
  openChannel(name: string): BroadcastChannel;
}

type Message = { type: "entry"; epoch: number; entry: LogEntry } | { type: "reset"; epoch: number };

const ENTRIES = "entries";
const META = "meta";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const r = factory.open(name, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore(ENTRIES);
    r.result.createObjectStore(META);
  };
  return request(r);
}

/**
 * The log shared by every tab of one origin. Entries live in IndexedDB, whose transactions are consistent across
 * tabs: a commit reads what is stored and appends inside one readwrite transaction, so sequence numbers never
 * collide. The entry then travels in a BroadcastChannel message, because another tab may see a storage write later
 * than the message (Chromium does, with localStorage). A tab opened later replays the stored log.
 */
export async function createBrowserLog(name: string, deps: Partial<BrowserLogDeps> = {}): Promise<MockLog> {
  const factory = deps.indexedDB ?? indexedDB;
  const openChannel = deps.openChannel ?? ((n: string) => new BroadcastChannel(n));
  const db = await openDatabase(factory, `dzb-studio-mock:${name}`);
  const channel = openChannel(`dzb-studio-mock:${name}`);
  const listeners = new Set<() => void>();
  let entries: LogEntry[] = []; // entries[i].seq === i + 1
  let epoch = 0;

  const notify = () => {
    for (const l of [...listeners]) l();
  };

  /** Adopts what the store holds, if it is newer than what this tab has. Returns whether anything changed. */
  const absorb = (storedEpoch: number, stored: LogEntry[]): boolean => {
    if (storedEpoch !== epoch) {
      epoch = storedEpoch;
      entries = stored;
      return true;
    }
    if (stored.length > entries.length) {
      entries = stored;
      return true;
    }
    return false;
  };

  const pull = async () => {
    const tx = db.transaction([ENTRIES, META], "readonly");
    const [storedEpoch, stored] = await Promise.all([
      request(tx.objectStore(META).get("epoch")),
      request(tx.objectStore(ENTRIES).getAll()),
    ]);
    if (absorb((storedEpoch as number | undefined) ?? 0, stored as LogEntry[])) notify();
  };

  channel.onmessage = (ev: MessageEvent<Message>) => {
    const m = ev.data;
    if (m.type === "entry" && m.epoch === epoch && m.entry.seq === entries.length + 1) {
      entries.push(m.entry);
      notify();
      return;
    }
    if (m.type === "entry" && m.epoch === epoch && m.entry.seq <= entries.length) return;
    // A gap, a reset, or a new epoch: the store has everything committed before the message was sent.
    void pull().catch(() => undefined); // a failed read is retried by the next message or commit
  };

  await pull();

  return {
    epoch: () => String(epoch),
    readSince: (seq) => entries.slice(seq),
    commit: (build) =>
      new Promise<number | null>((resolve, reject) => {
        const tx = db.transaction([ENTRIES, META], "readwrite");
        let appended: LogEntry | null = null;
        let caughtUp = false;
        let failure: unknown = null;
        const storedEpoch = tx.objectStore(META).get("epoch");
        const stored = tx.objectStore(ENTRIES).getAll();
        stored.onsuccess = () => {
          caughtUp = absorb((storedEpoch.result as number | undefined) ?? 0, stored.result as LogEntry[]);
          try {
            const e = build();
            if (e) {
              appended = { ...e, seq: entries.length + 1 };
              tx.objectStore(ENTRIES).put(appended, appended.seq);
            }
          } catch (err) {
            failure = err;
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          if (appended) {
            entries.push(appended);
            channel.postMessage({ type: "entry", epoch, entry: appended } satisfies Message);
          }
          // Entries caught up on here are dropped as stale when their own message arrives: announce them now.
          if (appended || caughtUp) queueMicrotask(notify);
          resolve(appended?.seq ?? null);
        };
        tx.onabort = () => {
          if (caughtUp) queueMicrotask(notify);
          reject(failure ?? tx.error ?? new Error("commit aborted"));
        };
      }),
    onCommit(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([ENTRIES, META], "readwrite");
        const storedEpoch = tx.objectStore(META).get("epoch");
        storedEpoch.onsuccess = () => {
          const next = ((storedEpoch.result as number | undefined) ?? 0) + 1;
          tx.objectStore(ENTRIES).clear();
          tx.objectStore(META).put(next, "epoch");
          tx.oncomplete = () => {
            epoch = next;
            entries = [];
            channel.postMessage({ type: "reset", epoch } satisfies Message);
            queueMicrotask(notify);
            resolve();
          };
        };
        tx.onabort = () => reject(tx.error ?? new Error("reset aborted"));
      }),
    close() {
      listeners.clear();
      channel.close();
      db.close();
    },
  };
}
