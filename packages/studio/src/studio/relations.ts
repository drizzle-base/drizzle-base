import type { TableInfo, TableRef } from "../contract";

export interface Relation {
  kind: "forward" | "reverse";
  name: string;
  table: TableRef;
  column: string;
  local: string;
}

/** Forwards in column order, then incoming FKs in `all` order. */
export function relationsOf(table: TableInfo, all: TableInfo[]): Relation[] {
  const forwards: Relation[] = [];
  for (const c of table.columns) {
    const ref = c.references;
    if (!ref) continue;
    forwards.push({
      kind: "forward",
      name: ref.table,
      table: { schema: ref.schema, name: ref.table },
      column: ref.column,
      local: c.name,
    });
  }

  const incoming: { from: TableInfo; column: string; local: string }[] = [];
  for (const other of all) {
    for (const c of other.columns) {
      const ref = c.references;
      if (!ref || ref.schema !== table.schema || ref.table !== table.name) continue;
      incoming.push({ from: other, column: c.name, local: ref.column });
    }
  }
  const perTable = new Map<string, number>();
  for (const inc of incoming) {
    const id = `${inc.from.schema}.${inc.from.name}`;
    perTable.set(id, (perTable.get(id) ?? 0) + 1);
  }
  const reverses: Relation[] = incoming.map((inc) => {
    const id = `${inc.from.schema}.${inc.from.name}`;
    const collide = (perTable.get(id) ?? 0) > 1;
    return {
      kind: "reverse",
      name: collide ? `${inc.from.name}_${inc.column}` : inc.from.name,
      table: { schema: inc.from.schema, name: inc.from.name },
      column: inc.column,
      local: inc.local,
    };
  });
  return [...forwards, ...reverses];
}
