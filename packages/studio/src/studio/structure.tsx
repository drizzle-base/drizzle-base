import type { ColumnInfo, TableInfo } from "../contract";

export interface StructurePanelProps {
  table: TableInfo;
}

const fkOf = (c: ColumnInfo): string =>
  c.references ? `${c.references.schema}.${c.references.table}.${c.references.column}` : "";

export function StructurePanel({ table }: StructurePanelProps) {
  return (
    <section aria-label="Structure" className="min-h-0 flex-1 overflow-auto p-4 text-sm">
      <table className="mb-6 w-full text-left text-xs">
        <caption className="mb-2 text-left text-sm font-medium">Columns</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium">Nullable</th>
            <th className="px-2 py-1 font-medium">Default</th>
            <th className="px-2 py-1 font-medium">PK</th>
            <th className="px-2 py-1 font-medium">FK</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name} className="border-b">
              <td className="px-2 py-1 font-medium">{c.name}</td>
              <td className="px-2 py-1 font-mono text-muted-foreground">{c.pgType}</td>
              <td className="px-2 py-1">{c.nullable ? "NULL" : "NOT NULL"}</td>
              <td className="px-2 py-1">{c.hasDefault ? "DEFAULT" : ""}</td>
              <td className="px-2 py-1">{c.isPrimaryKey ? "PK" : ""}</td>
              <td className="px-2 py-1 font-mono">{fkOf(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-left text-xs">
        <caption className="mb-2 text-left text-sm font-medium">Indexes</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Columns</th>
            <th className="px-2 py-1 font-medium">Unique</th>
            <th className="px-2 py-1 font-medium">Primary</th>
          </tr>
        </thead>
        <tbody>
          {table.indexes.map((idx) => (
            <tr key={idx.name} className="border-b">
              <td className="px-2 py-1 font-medium">{idx.name}</td>
              <td className="px-2 py-1 font-mono">{idx.columns.join(", ")}</td>
              <td className="px-2 py-1">{idx.unique ? "Unique" : ""}</td>
              <td className="px-2 py-1">{idx.primary ? "Primary" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
