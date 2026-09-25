import type { Row, RowKey, TableRef, Unsubscribe } from "../contract";

export type Op =
  | { kind: "insert"; table: TableRef; rows: Row[] }
  | { kind: "update"; table: TableRef; changes: { key: RowKey; values: Row }[] }
  | { kind: "delete"; table: TableRef; keys: RowKey[] };

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
  storage: Storage;
  openChannel(name: string): BroadcastChannel;
  locks: LockLike;
}

function browserDeps(): BrowserLogDeps {
  return {
    storage: localStorage,
    openChannel: (name) => new BroadcastChannel(name),
    locks: {
      // Web Locks resolve with the callback's awaited value; lib.dom types it without unwrapping the promise.
      request: <T>(name: string, callback: () => T | Promise<T>) =>
        navigator.locks.request(name, () => callback()) as Promise<T>,
    },
  };
}

/**
 * The log shared by every tab of one origin: entries in localStorage, commits serialised by a Web Lock, and a
 * BroadcastChannel message telling the other tabs to read what is new. A tab opened later replays the stored log.
 */
export function createBrowserLog(name: string, deps: Partial<BrowserLogDeps> = {}): MockLog {
  const { storage, openChannel, locks } = { ...browserDeps(), ...deps };
  const prefix = `dzb-studio-mock:${name}:`;
  const channel = openChannel(`${prefix}commits`);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  channel.onmessage = notify;
  const head = () => Number(storage.getItem(`${prefix}head`) ?? "0");
  const epoch = () => storage.getItem(`${prefix}epoch`) ?? "0";
  const announce = () => {
    channel.postMessage("commit");
    // BroadcastChannel never delivers to its sender: this tab hears its own commit here.
    queueMicrotask(notify);
  };
  return {
    epoch,
    readSince(seq) {
      const out: LogEntry[] = [];
      for (let s = seq + 1, h = head(); s <= h; s++) {
        const raw = storage.getItem(`${prefix}entry:${s}`);
        if (raw === null) break;
        out.push(JSON.parse(raw) as LogEntry);
      }
      return out;
    },
    commit: (build) =>
      locks.request(`${prefix}lock`, () => {
        const e = build();
        if (!e) return null;
        const seq = head() + 1;
        storage.setItem(`${prefix}entry:${seq}`, JSON.stringify({ ...e, seq }));
        storage.setItem(`${prefix}head`, String(seq));
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
      locks.request(`${prefix}lock`, () => {
        for (let s = 1, h = head(); s <= h; s++) storage.removeItem(`${prefix}entry:${s}`);
        storage.setItem(`${prefix}head`, "0");
        storage.setItem(`${prefix}epoch`, String(Number(epoch()) + 1));
        announce();
      }),
    close() {
      listeners.clear();
      channel.close();
    },
  };
}
