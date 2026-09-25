// Function definitions, typed by the app's Drizzle schema: `const { query, mutation } = functions<typeof schema>()`.
// The handler's return type is inferred; nothing here runs anything (see runtime.ts).
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";

export type Db<S extends Record<string, unknown>> = BunSQLDatabase<S>;
export interface Ctx<S extends Record<string, unknown>> {
  db: Db<S>;
}
export interface QueryDef<S extends Record<string, unknown>, A, R> {
  kind: "query";
  handler: (ctx: Ctx<S>, args: A) => Promise<R>;
}
export interface MutationDef<S extends Record<string, unknown>, A, R> {
  kind: "mutation";
  handler: (ctx: Ctx<S>, args: A) => Promise<R>;
}

export function functions<S extends Record<string, unknown>>() {
  return {
    query: <A, R>(handler: (ctx: Ctx<S>, args: A) => Promise<R>): QueryDef<S, A, R> => ({ kind: "query", handler }),
    mutation: <A, R>(handler: (ctx: Ctx<S>, args: A) => Promise<R>): MutationDef<S, A, R> => ({
      kind: "mutation",
      handler,
    }),
  };
}
