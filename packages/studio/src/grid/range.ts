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

/** RFC-ish TSV: quotes wrap a field; `""` inside a quoted field is `"`. Newlines inside quotes are cell data. */
export function parseTsv(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = src.endsWith("\n") ? src.slice(0, -1) : src;
  if (body === "") return [];

  const rows: string[][] = [];
  let cells: string[] = [];
  let i = 0;

  const finishRow = () => {
    rows.push(cells);
    cells = [];
  };

  while (i <= body.length) {
    if (i === body.length) {
      if (cells.length > 0) finishRow();
      break;
    }

    if (body[i] === '"') {
      let s = "";
      i += 1;
      while (i < body.length) {
        if (body[i] === '"' && body[i + 1] === '"') {
          s += '"';
          i += 2;
          continue;
        }
        if (body[i] === '"') {
          i += 1;
          break;
        }
        s += body[i];
        i += 1;
      }
      cells.push(s);
      if (body[i] === "\t") {
        i += 1;
        if (i === body.length) cells.push("");
      } else if (body[i] === "\n") {
        i += 1;
        finishRow();
      }
    } else {
      const tab = body.indexOf("\t", i);
      const nl = body.indexOf("\n", i);
      let end = body.length;
      if (tab >= 0 && (nl < 0 || tab < nl)) end = tab;
      else if (nl >= 0) end = nl;
      cells.push(body.slice(i, end));
      if (end === tab) {
        i = tab + 1;
        if (i === body.length) cells.push("");
      } else if (end === nl) {
        i = nl + 1;
        finishRow();
      } else i = body.length;
    }
  }

  return rows;
}
