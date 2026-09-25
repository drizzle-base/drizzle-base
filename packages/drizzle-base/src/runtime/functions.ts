// Function definitions, typed by the app's Drizzle schema: `const { query, mutation } = functions<typeof schema>()`.
// The handler's return type is inferred; nothing here runs anything (see runtime.ts). A definition may carry an
// `args` validator in the Standard Schema form (https://standardschema.dev — zod, valibot and arktype implement it):
// the server validates wire args with it before the handler runs, and the handler receives the schema's OUTPUT.
// Without one, the handler receives the decoded JSON as sent.
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";

export type Db<S extends Record<string, unknown>> = BunSQLDatabase<S>;
export interface Ctx<S extends Record<string, unknown>> {
  db: Db<S>;
}

// The Standard Schema v1 interface, declared here so no validator library is a dependency.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string; readonly path?: readonly unknown[] }[] };

export interface QueryDef<S extends Record<string, unknown>, A, R, I = A> {
  kind: "query";
  args?: StandardSchemaV1<I, A>;
  handler: (ctx: Ctx<S>, args: A) => Promise<R>;
}
export interface MutationDef<S extends Record<string, unknown>, A, R, I = A> {
  kind: "mutation";
  args?: StandardSchemaV1<I, A>;
  handler: (ctx: Ctx<S>, args: A) => Promise<R>;
}

type Handler<S extends Record<string, unknown>, A, R> = (ctx: Ctx<S>, args: A) => Promise<R>;
type WithArgs<S extends Record<string, unknown>, A, R, I> = { args: StandardSchemaV1<I, A>; handler: Handler<S, A, R> };

export function functions<S extends Record<string, unknown>>() {
  function query<A, R>(handler: Handler<S, A, R>): QueryDef<S, A, R>;
  function query<A, R, I>(def: WithArgs<S, A, R, I>): QueryDef<S, A, R, I>;
  function query<A, R, I>(x: Handler<S, A, R> | WithArgs<S, A, R, I>): QueryDef<S, A, R, I> {
    return typeof x === "function"
      ? { kind: "query", handler: x }
      : { kind: "query", args: x.args, handler: x.handler };
  }
  function mutation<A, R>(handler: Handler<S, A, R>): MutationDef<S, A, R>;
  function mutation<A, R, I>(def: WithArgs<S, A, R, I>): MutationDef<S, A, R, I>;
  function mutation<A, R, I>(x: Handler<S, A, R> | WithArgs<S, A, R, I>): MutationDef<S, A, R, I> {
    return typeof x === "function"
      ? { kind: "mutation", handler: x }
      : { kind: "mutation", args: x.args, handler: x.handler };
  }
  return { query, mutation };
}

export type ArgsCheck<A> = { ok: true; value: A } | { ok: false; issues: string[] };

// Runs a definition's validator over untrusted args; without one, the args pass through as decoded.
export async function validateArgs<A>(
  def: { args?: StandardSchemaV1<unknown, A> },
  raw: unknown,
): Promise<ArgsCheck<A>> {
  if (!def.args) return { ok: true, value: raw as A };
  const result = await def.args["~standard"].validate(raw);
  if (result.issues) return { ok: false, issues: result.issues.map((i) => i.message) };
  return { ok: true, value: result.value };
}
