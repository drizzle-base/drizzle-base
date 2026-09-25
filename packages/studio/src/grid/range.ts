export interface CellRef {
  rowId: string;
  column: string;
}

export function cellsInRect(
  anchor: CellRef,
  focus: CellRef,
  rowIds: readonly string[],
  columns: readonly string[],
): CellRef[] {
  const ri = (id: string) => rowIds.indexOf(id);
  const ci = (name: string) => columns.indexOf(name);
  const rs = [ri(anchor.rowId), ri(focus.rowId)].filter((i) => i >= 0);
  const cs = [ci(anchor.column), ci(focus.column)].filter((i) => i >= 0);
  if (rs.length === 0 || cs.length === 0) return [];
  const r0 = Math.min(...rs);
  const r1 = Math.max(...rs);
  const c0 = Math.min(...cs);
  const c1 = Math.max(...cs);
  const out: CellRef[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const rowId = rowIds[r];
      const column = columns[c];
      if (rowId !== undefined && column !== undefined) out.push({ rowId, column });
    }
  }
  return out;
}

const needsQuote = (s: string) => /[\t\n\r"]/.test(s);
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.map((c) => (needsQuote(c) ? quote(c) : c)).join("\t")).join("\n");
}

/** RFC-ish TSV: quotes wrap a field; `""` inside a quoted field is `"`. */
export function parseTsv(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = src.endsWith("\n") ? src.slice(0, -1) : src;
  if (trimmed === "") return [];
  const rows: string[][] = [];
  for (const line of trimmed.split("\n")) {
    const cells: string[] = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let s = "";
        i += 1;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          if (line[i] === '"') {
            i += 1;
            break;
          }
          s += line[i];
          i += 1;
        }
        cells.push(s);
        if (line[i] === "\t") i += 1;
        else if (i >= line.length) break;
      } else {
        const tab = line.indexOf("\t", i);
        if (tab < 0) {
          cells.push(line.slice(i));
          break;
        }
        cells.push(line.slice(i, tab));
        i = tab + 1;
      }
    }
    rows.push(cells);
  }
  return rows;
}
