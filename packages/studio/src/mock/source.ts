import {
  type CellValue,
  type ColumnKind,
  type Page,
  type PageRequest,
  type Row,
  type RowKey,
  type StudioDataSource,
  StudioDataSourceError,
  type TableInfo,
  type TableRef,
  tableId,
} from "../contract";
import type { MockDataset, MockDefault, MockTable } from "./dataset";
import { mulberry32, uuidv7 } from "./ids";
import type { LogEntry, MockLog, Op } from "./log";
import { pgDate, pgTimestamp, pgTimestamptz } from "./pgtext";
import { runPage } from "./query";

export interface MockOptions {
  dataset: MockDataset;
  log: MockLog;
  /** Delay before every push and every write resolves, to see loading states. */
  latencyMs?: number;
  now?: () => Date;
  /** Seeds the ids generated on insert and the rows externalWrite() picks. */
  seed?: number;
}

export interface MockDataSource extends StudioDataSource {
  /**
   * A write as psql or Drizzle Studio would make it: straight into the log, marked external, bypassing the studio.
   * With no argument, changes a text cell of a random row.
   */
  externalWrite(op?: Op): Promise<void>;
  close(): void;
}

interface Subscription {
  req: PageRequest;
  onPage: (page: Page) => void;
  onError: (e: Error) => void;
  last: string | null;
  closed: boolean;
}

interface LiveTable {
  def: MockTable;
  rows: Row[];
  serial: number;
}

const same = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const matchesKey = (row: Row, key: RowKey): boolean => Object.entries(key).every(([k, v]) => same(row[k], v));
const refOf = (t: TableRef): TableRef => ({ schema: t.schema, name: t.name });

function maxSerial(def: MockTable, rows: readonly Row[], current: number): number {
  const cols = Object.entries(def.defaults)
    .filter(([, d]) => d === "serial")
    .map(([c]) => c);
  let max = current;
  for (const r of rows) {
    for (const c of cols) {
      const v = Number(r[c]);
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return max;
}

export function createMockDataSource(opts: MockOptions): MockDataSource {
  const { dataset, log } = opts;
  const latency = opts.latencyMs ?? 0;
  const now = opts.now ?? (() => new Date());
  const rand = mulberry32(opts.seed ?? 1);
  const views = new Map(dataset.views.map((v) => [tableId(v.info), v]));
  const subs = new Set<Subscription>();
  let tables = new Map<string, LiveTable>();
  let seq = 0;
  // Pages carry `revision`, not `seq`: seq restarts at 0 on a reset, and a revision must only grow.
  let revision = 0;
  let epoch: string | null = null;

  const rebuild = () => {
    tables = new Map(
      dataset.tables.map((t) => [
        tableId(t.info),
        { def: t, rows: structuredClone(t.rows), serial: maxSerial(t, t.rows, 0) },
      ]),
    );
    if (epoch !== null) revision++;
    seq = 0;
    epoch = log.epoch();
  };

  const apply = (e: LogEntry) => {
    const op = e.op;
    const t = tables.get(tableId(op.table));
    if (!t) return; // an external write to a relation this dataset lacks: nothing to apply, as in Postgres
    switch (op.kind) {
      case "insert":
        t.rows.push(...structuredClone(op.rows));
        t.serial = maxSerial(t.def, op.rows, t.serial);
        break;
      case "update":
        for (const c of op.changes)
          for (const r of t.rows) if (matchesKey(r, c.key)) Object.assign(r, structuredClone(c.values));
        break;
      case "delete":
        t.rows = t.rows.filter((r) => !op.keys.some((k) => matchesKey(r, k)));
        break;
    }
  };

  const catchUp = () => {
    if (log.epoch() !== epoch) rebuild();
    for (const e of log.readSince(seq)) {
      apply(e);
      seq = e.seq;
      revision++;
    }
  };

  const deliver = (sub: Subscription, fn: () => void) => {
    const run = () => {
      if (!sub.closed) fn();
    };
    if (latency > 0) setTimeout(run, latency);
    else queueMicrotask(run);
  };

  const relation = (ref: TableRef): { info: TableInfo; rows: readonly Row[] } => {
    const id = tableId(ref);
    const t = tables.get(id);
    if (t) return { info: t.def.info, rows: t.rows };
    const v = views.get(id);
    if (v) return { info: v.info, rows: v.compute((dep) => tables.get(dep)?.rows ?? []) };
    throw new StudioDataSourceError("unknown_table", `unknown table "${id}"`);
  };

  const evaluate = (sub: Subscription) => {
    try {
      const { info, rows } = relation(sub.req.table);
      const result = runPage(info, rows, sub.req);
      const json = JSON.stringify(result);
      if (json === sub.last) return; // pushes happen when the result changes, not on every commit
      sub.last = json;
      const page: Page = { rows: structuredClone(result.rows), total: result.total, revision };
      deliver(sub, () => sub.onPage(page));
    } catch (e) {
      if (sub.last === "error") return;
      sub.last = "error";
      const err = e instanceof Error ? e : new Error(String(e));
      deliver(sub, () => sub.onError(err));
    }
  };

  const stopListening = log.onCommit(() => {
    catchUp();
    for (const s of subs) evaluate(s);
  });

  const settle = () => new Promise<void>((resolve) => (latency > 0 ? setTimeout(resolve, latency) : resolve()));

  const writable = (ref: TableRef): LiveTable => {
    const id = tableId(ref);
    const t = tables.get(id);
    if (!t) {
      if (views.has(id)) throw new StudioDataSourceError("read_only", `"${id}" is a view`);
      throw new StudioDataSourceError("unknown_table", `unknown table "${id}"`);
    }
    if (t.def.info.primaryKey.length === 0) throw new StudioDataSourceError("read_only", `"${id}" has no primary key`);
    return t;
  };

  const checkValues = (t: LiveTable, values: Row) => {
    for (const [name, v] of Object.entries(values)) {
      const c = t.def.info.columns.find((x) => x.name === name);
      if (!c) throw new StudioDataSourceError("unknown_column", `unknown column "${name}"`);
      if (v === null && !c.nullable) throw new StudioDataSourceError("not_null", `"${name}" is NOT NULL`);
    }
  };

  const checkKey = (t: LiveTable, key: RowKey) => {
    const pk = t.def.info.primaryKey;
    const names = Object.keys(key);
    if (names.length !== pk.length || !pk.every((k) => names.includes(k))) {
      throw new StudioDataSourceError(
        "invalid_value",
        `a key of "${tableId(t.def.info)}" names exactly ${pk.join(", ")}`,
      );
    }
  };

  const keyOf = (t: LiveTable, row: Row): string => JSON.stringify(t.def.info.primaryKey.map((k) => row[k] ?? null));

  const taken = (t: LiveTable, key: string): StudioDataSourceError =>
    new StudioDataSourceError("unique_violation", `"${tableId(t.def.info)}" already has a row with key ${key}`);

  const defaultValue = (d: MockDefault, kind: ColumnKind, serial: { next: number }): CellValue => {
    if (typeof d === "object") return structuredClone(d.value);
    switch (d) {
      case "serial": {
        serial.next += 1;
        return kind === "bigint" ? String(serial.next) : serial.next;
      }
      case "uuidv7":
        return uuidv7(now().getTime(), rand);
      case "now":
        return kind === "timestamptz" ? pgTimestamptz(now()) : kind === "date" ? pgDate(now()) : pgTimestamp(now());
    }
  };

  const materialize = (t: LiveTable, input: Row, serial: { next: number }): Row => {
    checkValues(t, input);
    const row: Row = {};
    for (const c of t.def.info.columns) {
      if (Object.hasOwn(input, c.name)) {
        row[c.name] = input[c.name] ?? null;
        continue;
      }
      const d = t.def.defaults[c.name];
      if (d !== undefined) row[c.name] = defaultValue(d, c.kind, serial);
      else if (c.nullable) row[c.name] = null;
      else throw new StudioDataSourceError("not_null", `"${c.name}" is NOT NULL and has no default`);
    }
    return row;
  };

  /** `make` runs under the log's lock, after catching up: it sees every commit before it, from every tab. */
  const commit = async (make: () => Op | null, origin: LogEntry["origin"]) => {
    await log.commit(() => {
      catchUp();
      const op = make();
      return op ? { op, origin } : null;
    });
    await settle();
  };

  const randomExternalOp = (): Op | null => {
    const candidates = [...tables.values()].filter(
      (t) =>
        t.def.info.primaryKey.length > 0 &&
        t.rows.length > 0 &&
        t.def.info.columns.some((c) => c.kind === "text" && !c.isPrimaryKey),
    );
    const t = candidates[Math.floor(rand() * candidates.length)];
    // Among the first rows (seed data is stored in key order), so the change lands on a page someone is looking at.
    const row = t?.rows[Math.floor(rand() * Math.min(t.rows.length, 20))];
    const column = t?.def.info.columns.find((c) => c.kind === "text" && !c.isPrimaryKey);
    if (!t || !row || !column) return null;
    const key = Object.fromEntries(t.def.info.primaryKey.map((k) => [k, row[k] ?? null]));
    const values = { [column.name]: `external write ${Math.floor(rand() * 1_000_000)}` };
    return { kind: "update", table: refOf(t.def.info), changes: [{ key, values }] };
  };

  catchUp();

  return {
    async listTables() {
      catchUp();
      await settle();
      return [
        ...[...tables.values()].map((t) => ({ ...structuredClone(t.def.info), estimatedRows: t.rows.length })),
        ...[...views.values()].map((v) => structuredClone(v.info)),
      ];
    },

    subscribePage(req, onPage, onError) {
      const sub: Subscription = { req: structuredClone(req), onPage, onError, last: null, closed: false };
      subs.add(sub);
      queueMicrotask(() => {
        if (sub.closed) return;
        catchUp();
        evaluate(sub);
      });
      return () => {
        sub.closed = true;
        subs.delete(sub);
      };
    },

    async updateRows(ref, changes) {
      await commit(() => {
        const t = writable(ref);
        for (const c of changes) {
          checkKey(t, c.key);
          checkValues(t, c.values);
          if (!t.def.info.primaryKey.some((k) => Object.hasOwn(c.values, k))) continue;
          for (const row of t.rows.filter((r) => matchesKey(r, c.key))) {
            const k = keyOf(t, { ...row, ...c.values });
            if (t.rows.some((other) => other !== row && keyOf(t, other) === k)) throw taken(t, k);
          }
        }
        return changes.length === 0 ? null : { kind: "update", table: refOf(ref), changes: structuredClone(changes) };
      }, "studio");
    },

    async insertRows(ref, rows) {
      let keys: RowKey[] = [];
      await commit(() => {
        const t = writable(ref);
        const serial = { next: t.serial };
        const full = rows.map((r) => materialize(t, r, serial));
        const seen = new Set(t.rows.map((r) => keyOf(t, r)));
        for (const r of full) {
          const k = keyOf(t, r);
          if (seen.has(k)) throw taken(t, k);
          seen.add(k);
        }
        keys = full.map((r) => Object.fromEntries(t.def.info.primaryKey.map((k) => [k, r[k] ?? null])));
        return full.length === 0 ? null : { kind: "insert", table: refOf(ref), rows: full };
      }, "studio");
      return keys;
    },

    async deleteRows(ref, keys) {
      await commit(() => {
        const t = writable(ref);
        for (const k of keys) checkKey(t, k);
        return keys.length === 0 ? null : { kind: "delete", table: refOf(ref), keys: structuredClone(keys) };
      }, "studio");
    },

    async externalWrite(op) {
      await commit(() => op ?? randomExternalOp(), "external");
    },

    close() {
      stopListening();
      for (const s of subs) s.closed = true;
      subs.clear();
    },
  };
}
