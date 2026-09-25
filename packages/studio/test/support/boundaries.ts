import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
  path: string;
  source: string;
}

// The studio is a browser package that must work against its own contract only: no core import, no server runtime.
const FORBIDDEN: RegExp[] = [
  /^drizzle-base(\/|$)/,
  /(^|\/)drizzle-base\//,
  /^node:/,
  /^bun(:|$)/,
  /(^|\/)(test|e2e)\//,
];

const IMPORT_FORMS: RegExp[] = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

export function importsOf(source: string): string[] {
  const code = stripComments(source);
  return IMPORT_FORMS.flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ""));
}

export function boundaryViolations(files: SourceFile[]): string[] {
  return files.flatMap((f) =>
    importsOf(f.source)
      .filter((spec) => FORBIDDEN.some((re) => re.test(spec)))
      .map((spec) => `${f.path} imports "${spec}"`),
  );
}

export function collectSources(dirs: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push({ path, source: readFileSync(path, "utf8") });
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}
