export type ImportKind = "json" | "csv" | "sql";
export type ImportResult =
  | {
      ok: true;
      rows: Record<string, string>[];
      table?: { schema: string; name: string };
    }
  | { ok: false; error: string };

const fail = (error: string): ImportResult => ({ ok: false, error });

const fieldText = (value: unknown): string => {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

function parseJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("JSON is not valid");
  }
  if (!Array.isArray(parsed)) return fail("JSON must be an array of objects");
  const rows: Record<string, string>[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return fail("JSON must be an array of objects");
    }
    rows.push(Object.fromEntries(Object.entries(item).map(([k, v]) => [k, fieldText(v)])));
  }
  return { ok: true, rows };
}

function parseCsv(text: string): ImportResult {
  let s = text;
  if (s.endsWith("\r\n")) s = s.slice(0, -2);
  else if (s.endsWith("\n")) s = s.slice(0, -1);
  if (s === "") return fail("CSV needs a header row");

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) return fail("CSV has an unclosed quote");
  row.push(field);
  records.push(row);

  const header = records[0];
  if (!header) return fail("CSV needs a header row");
  const rows = records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) obj[header[j]!] = r[j] ?? "";
    return obj;
  });
  return { ok: true, rows };
}

const IDENT = /^"((?:[^"]|"")*)"/;
const DOLLAR = /^\$([a-z][a-z0-9]*)\$/;
const NUMBER = /^-?(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?/;

function parseSql(text: string): ImportResult {
  const s = text.endsWith("\n") ? text.slice(0, -1) : text;
  let i = 0;

  const eat = (lit: string): boolean => {
    if (!s.startsWith(lit, i)) return false;
    i += lit.length;
    return true;
  };

  const ident = (): string | null => {
    const m = IDENT.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[1]!.replaceAll('""', '"');
  };

  const literal = (): string | null => {
    if (eat("NULL")) return "";
    if (eat("TRUE")) return "true";
    if (eat("FALSE")) return "false";
    const num = NUMBER.exec(s.slice(i));
    if (num && Number.isFinite(Number(num[0]))) {
      i += num[0].length;
      return num[0];
    }
    const tag = DOLLAR.exec(s.slice(i));
    if (!tag) return null;
    const open = tag[0];
    i += open.length;
    const closeAt = s.indexOf(open, i);
    if (closeAt < 0) return null;
    const value = s.slice(i, closeAt);
    i = closeAt + open.length;
    return value;
  };

  if (!eat("INSERT INTO ")) return fail("SQL must be our INSERT");
  const schema = ident();
  if (schema == null || !eat(".")) return fail("SQL must be our INSERT");
  const name = ident();
  if (name == null || !eat(" (")) return fail("SQL must be our INSERT");

  const columns: string[] = [];
  if (!eat(")")) {
    for (;;) {
      const col = ident();
      if (col == null) return fail("SQL must be our INSERT");
      columns.push(col);
      if (eat(")")) break;
      if (!eat(", ")) return fail("SQL must be our INSERT");
    }
  }
  if (!eat(" VALUES ")) return fail("SQL must be our INSERT");

  const rows: Record<string, string>[] = [];
  if (!eat(";")) {
    for (;;) {
      if (!eat("(")) return fail("SQL must be our INSERT");
      const values: string[] = [];
      if (!eat(")")) {
        for (;;) {
          const value = literal();
          if (value == null) return fail("SQL must be our INSERT");
          values.push(value);
          if (eat(")")) break;
          if (!eat(", ")) return fail("SQL must be our INSERT");
        }
      }
      if (values.length !== columns.length) return fail("SQL must be our INSERT");
      rows.push(Object.fromEntries(columns.map((c, idx) => [c, values[idx]!])));
      if (eat(";")) break;
      if (!eat(", ")) return fail("SQL must be our INSERT");
    }
  }
  if (i !== s.length) return fail("SQL must be our INSERT");
  return { ok: true, rows, table: { schema, name } };
}

export function parseImport(text: string, kind: ImportKind): ImportResult {
  if (kind === "json") return parseJson(text);
  if (kind === "csv") return parseCsv(text);
  return parseSql(text);
}
