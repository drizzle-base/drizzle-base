// The folder rules that make one package behave like several (docs/ARCHITECTURE.md). Without this check the
// boundaries would erode one convenient import at a time — the reason the owner's earlier split attempt failed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";

export interface SourceFile {
  path: string; // relative to the package root
  text: string;
}
export interface PackageDeps {
  dependencies: string[];
  peerDependencies: string[];
}

// Which modules each module may import. A folder under src/ that is not a key is an error.
export const LAYERS: Record<string, readonly string[]> = {
  sql: [],
  capture: [],
  readset: ["sql"],
  runtime: ["sql", "readset"],
  subscriptions: ["sql", "capture", "readset", "runtime"],
  server: ["sql", "capture", "readset", "runtime", "subscriptions", "protocol"],
  protocol: [],
  client: ["protocol"],
  react: ["protocol", "client"],
  entry: ["sql", "capture", "readset", "runtime", "subscriptions", "server", "protocol", "client", "react"],
};
const CLIENT_SIDE = new Set(["protocol", "client", "react"]);
const SERVER_ONLY_PACKAGES = new Set(["pg", "pg-logical-replication", "libpg-query", "bun", "drizzle-orm"]);
const BUILTIN = (spec: string) => spec.startsWith("node:") || spec === "bun" || spec === "bun:test";

// Comments are blanked first — a quote inside a comment (`// don't`) used to hide the import around it, and an
// import mentioned in a comment was reported as one. Strings are kept intact: the specifiers live in them.
export function stripComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!,
      next = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const block = text.slice(i, end < 0 ? text.length : end + 2);
      out += block.replace(/[^\n]/g, " ");
      i += block.length - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

const STATIC = /(?:^|[;{}\s])(?:import|export)\s[^;"'`]*?\sfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT = /(?:^|[;{}\s])import\s*["']([^"']+)["']/g;
const DYNAMIC = /\b(?:import|require)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*\)/g;

export function specifiers(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  for (const m of code.matchAll(STATIC)) out.push(m[1]!);
  for (const m of code.matchAll(SIDE_EFFECT)) out.push(m[1]!);
  for (const m of code.matchAll(DYNAMIC)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

const CODE = /\.(?:c|m)?[jt]sx?$/;
const moduleOf = (path: string): string | null => (path.startsWith("src/") ? (path.split("/")[1] ?? null) : null);
const bareName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

export function checkBoundaries(files: SourceFile[], pkg: PackageDeps): string[] {
  const problems: string[] = [];
  const declared = new Set([...pkg.dependencies, ...pkg.peerDependencies]);
  for (const f of files) {
    const from = moduleOf(f.path);
    if (from !== null && !(from in LAYERS)) {
      problems.push(`${f.path}: module ${from} has no layer in LAYERS`);
      continue;
    }
    for (const spec of specifiers(f.text)) {
      if (spec.startsWith(".")) {
        const target = normalize(join(f.path, "..", spec));
        if (!target.startsWith("src/")) {
          // test → test/support, load → test/support are fine; production code never reaches outside src/
          if (from !== null)
            problems.push(
              `${f.path}: imports ${target}, outside src/ (production code may not depend on tests or benches)`,
            );
          continue;
        }
        const parts = target.split("/");
        const to = parts[1]!;
        if (to === from) continue; // inside its own module
        if (parts.length > 2 && !(parts.length === 3 && parts[2] === "index"))
          problems.push(`${f.path}: reaches into ${target}; import module ${to} through its index`);
        if (from !== null && !(LAYERS[from] ?? []).includes(to))
          problems.push(`${f.path}: ${from} may not depend on ${to}`);
        if (from !== null && CLIENT_SIDE.has(from) && !CLIENT_SIDE.has(to))
          problems.push(`${f.path}: client may not depend on server module ${to}`);
        continue;
      }
      if (spec === "drizzlebase" || spec.startsWith("drizzlebase/")) {
        // Tests may use the public door; a module may not — the self-reference would bypass every layer rule
        // (a client importing drizzlebase/server would pull pg into the browser bundle).
        if (from !== null)
          problems.push(`${f.path}: imports the package's own public entry ${spec}; import the module instead`);
        continue;
      }
      if (from !== null && CLIENT_SIDE.has(from) && (BUILTIN(spec) || SERVER_ONLY_PACKAGES.has(bareName(spec))))
        problems.push(`${f.path}: ${from} imports server-only package ${spec}`);
      if (from !== null && !BUILTIN(spec) && !declared.has(bareName(spec)))
        problems.push(`${f.path}: ${bareName(spec)} is not declared in dependencies or peerDependencies`);
    }
  }
  return problems;
}

export function loadPackage(root: string): { files: SourceFile[]; pkg: PackageDeps } {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      // test/boundaries holds deliberate violations as fixture strings: the checker's own test data.
      if (statSync(full).isDirectory()) {
        if (relative(root, full) !== join("test", "boundaries")) walk(full);
      } else if (CODE.test(full)) files.push({ path: relative(root, full), text: readFileSync(full, "utf8") });
    }
  };
  for (const top of ["src", "test", "load"]) if (existsSync(join(root, top))) walk(join(root, top));
  const json = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return {
    files,
    pkg: {
      dependencies: Object.keys(json.dependencies ?? {}),
      peerDependencies: Object.keys(json.peerDependencies ?? {}),
    },
  };
}
