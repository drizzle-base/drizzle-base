// The application's API: a nested object of query and mutation definitions. `defineApi` returns the object itself
// — its TYPE is what the client imports (`import type { api }`: tRPC's model, no codegen) — and records the flat
// registry the server calls by dotted name ("posts.list"). Only names in the registry are callable.
// Structural on purpose: any query or mutation definition, whatever its schema, args and return types. The server
// only needs to validate and call it.
export interface AnyDef {
  kind: "query" | "mutation";
  args?: { readonly "~standard": { readonly validate: (value: unknown) => unknown } } | undefined;
  handler: (...a: never[]) => Promise<unknown>;
}
export interface ApiTree {
  readonly [key: string]: AnyDef | ApiTree;
}

const registries = new WeakMap<object, ReadonlyMap<string, AnyDef>>();

const isDef = (x: unknown): x is AnyDef =>
  typeof x === "object" &&
  x !== null &&
  ((x as AnyDef).kind === "query" || (x as AnyDef).kind === "mutation") &&
  typeof (x as AnyDef).handler === "function";

export function defineApi<T extends ApiTree>(tree: T): T {
  const reg = new Map<string, AnyDef>();
  const walk = (node: object, prefix: string) => {
    const keys = Object.keys(node);
    if (!keys.length) throw new Error(`defineApi: ${prefix || "the API"} is empty`);
    for (const key of keys) {
      if (key.includes(".")) throw new Error(`defineApi: the key ${JSON.stringify(key)} contains a dot`);
      const name = prefix ? `${prefix}.${key}` : key;
      const child: unknown = (node as Record<string, unknown>)[key];
      if (isDef(child)) reg.set(name, child);
      else if (typeof child === "object" && child !== null && !Array.isArray(child)) walk(child, name);
      else throw new Error(`defineApi: ${name} is not a query or a mutation`);
    }
  };
  walk(tree, "");
  registries.set(tree, reg);
  return tree;
}

export function registryOf(api: object): ReadonlyMap<string, AnyDef> {
  const reg = registries.get(api);
  if (!reg) throw new Error("this API was not created with defineApi()");
  return reg;
}
