import type { ColumnInfo } from "../contract";
import { decodeView, encodeView, type StudioView } from "../view";

export interface ColumnLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export const EMPTY_LAYOUT: ColumnLayout = { order: [], hidden: [], widths: {} };
export const DEFAULT_WIDTH = 200;
export const MIN_WIDTH = 60;

export interface LaidOutColumn {
  column: ColumnInfo;
  width: number;
}

/** Display order: the saved order for columns that still exist, then new columns in table order. */
export function layoutColumns(
  columns: ColumnInfo[],
  layout: ColumnLayout,
): { ordered: ColumnInfo[]; visible: LaidOutColumn[] } {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const saved = layout.order.filter((n) => byName.has(n));
  const names = [...saved, ...columns.map((c) => c.name).filter((n) => !saved.includes(n))];
  const ordered = names.map((n) => byName.get(n)).filter((c): c is ColumnInfo => c !== undefined);
  const hidden = new Set(layout.hidden);
  const visible = ordered
    .filter((c) => !hidden.has(c.name))
    .map((column) => ({ column, width: Math.max(MIN_WIDTH, layout.widths[column.name] ?? DEFAULT_WIDTH) }));
  return { ordered, visible };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export interface Prefs {
  layout(table: string): ColumnLayout;
  setLayout(table: string, layout: ColumnLayout): void;
  lastView(table: string): StudioView | null;
  setLastView(table: string, view: StudioView): void;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked (sandboxed iframe, privacy settings)
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function asLayout(v: unknown): ColumnLayout | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const order = o["order"];
  const hidden = o["hidden"];
  const widths = o["widths"];
  if (!isStrings(order) || !isStrings(hidden) || typeof widths !== "object" || widths === null) return null;
  const clean: Record<string, number> = {};
  for (const [k, x] of Object.entries(widths)) if (typeof x === "number" && Number.isFinite(x)) clean[k] = x;
  return { order, hidden, widths: clean };
}

/** Per-table layouts and last views in localStorage. A convenience: unreadable or blocked storage is "nothing saved". */
export function createPrefs(namespace: string, storage: Storage | null = browserStorage()): Prefs {
  const key = (kind: string, table: string) => `dzb-studio:${namespace}:${kind}:${table}`;
  const read = (k: string): string | null => {
    try {
      return storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const write = (k: string, value: string) => {
    try {
      storage?.setItem(k, value);
    } catch {
      // quota or blocked storage: the layout still applies for this session
    }
  };
  return {
    layout(table) {
      const raw = read(key("layout", table));
      if (raw === null) return EMPTY_LAYOUT;
      try {
        return asLayout(JSON.parse(raw)) ?? EMPTY_LAYOUT;
      } catch {
        return EMPTY_LAYOUT;
      }
    },
    setLayout: (table, layout) => write(key("layout", table), JSON.stringify(layout)),
    lastView(table) {
      const raw = read(key("view", table));
      if (raw === null) return null;
      const { view, errors } = decodeView(raw);
      return errors.length === 0 && view.table === table ? view : null;
    },
    setLastView: (table, view) => write(key("view", table), encodeView(view)),
  };
}
