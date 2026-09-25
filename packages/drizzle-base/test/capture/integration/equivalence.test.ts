import { expect, test } from "bun:test";
import type { CapturedTxn } from "../../../src/capture";
import { emitBarrier, ensureCapture, PgoutputCapture } from "../../../src/capture";
import { pgConfig, withCaptureSchema } from "../../../test/support/db";

const STEPS = Number(process.env["EQUIV_STEPS"] ?? 200);

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test.each([1, 2, 3])(
  "capture ⊇ snapshot diff (seed %i)",
  async (seed) => {
    await withCaptureSchema(async (sql, n) => {
      const S = `"${n.schema}"`;
      await sql.unsafe(`
			create table ${S}.users(id int primary key, name text not null, age int);
			create table ${S}.parents(id int primary key, v int not null);
			create table ${S}.children(id int primary key, parent_id int not null references ${S}.parents(id) on delete cascade on update cascade, v int not null);
			create table ${S}.audit(id bigserial primary key, parent_id int, note text);
			create function ${S}.audit_fn() returns trigger language plpgsql as $$
			  begin insert into ${S}.audit(parent_id, note) values (new.id, tg_op); return null; end $$;
			create trigger audit_parents after update on ${S}.parents for each row execute function ${S}.audit_fn();`);
      await ensureCapture(sql, n);
      const txns: CapturedTxn[] = [];
      const errors: Error[] = [];
      const waiters = new Map<string, () => void>();
      const cap = new PgoutputCapture({ connection: pgConfig, names: n });
      await cap.start({
        onEvent: (e) => {
          if (e.kind === "txn") txns.push(e.txn);
          else waiters.get(e.id)?.();
        },
        onError: (e) => errors.push(e),
      });
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const TABLES = ["users", "parents", "children", "audit"];
      const snapshot = async () => {
        const out = new Map<string, string>();
        for (const t of TABLES)
          for (const r of await sql.unsafe(`select id::text as id, to_jsonb(x)::text as j from ${S}.${t} x`))
            out.set(`${t}|${r.id}`, r.j);
        return out;
      };
      const write = async (): Promise<string> => {
        const k = rnd();
        if (k < 0.25) {
          await sql.unsafe(`insert into ${S}.users values ($1, $2, $3) on conflict do nothing`, [
            1 + Math.floor(rnd() * 10),
            pick(["Dan", "Ana"]),
            pick([null, 18, 30]),
          ]);
          return "insert";
        }
        if (k < 0.35) {
          await sql.unsafe(`insert into ${S}.parents values ($1, 0) on conflict do nothing`, [
            1 + Math.floor(rnd() * 4),
          ]);
          return "insert-parent";
        }
        if (k < 0.45) {
          await sql.unsafe(
            `insert into ${S}.children select $1, id, 0 from ${S}.parents order by random() limit 1 on conflict do nothing`,
            [1 + Math.floor(rnd() * 12)],
          );
          return "insert-child";
        }
        if (k < 0.55) {
          await sql.unsafe(`update ${S}.users set age = coalesce(age, 0) + 1 where age < 30`);
          return "update-many";
        }
        if (k < 0.62) {
          await sql.unsafe(`delete from ${S}.parents where id = $1`, [1 + Math.floor(rnd() * 4)]);
          return "delete-cascade";
        }
        if (k < 0.7) {
          await sql.unsafe(`update ${S}.parents set v = v + 1 where id = $1`, [1 + Math.floor(rnd() * 4)]);
          return "user-trigger";
        }
        if (k < 0.75) {
          await sql.unsafe(
            `update ${S}.parents set id = $2 where id = $1 and not exists (select 1 from ${S}.parents where id = $2)`,
            [1 + Math.floor(rnd() * 4), 5 + Math.floor(rnd() * 3)],
          );
          return "pk-move-cascade";
        }
        if (k < 0.8) {
          await sql.unsafe(
            `insert into ${S}.users values ($1, 'U', 1) on conflict (id) do update set age = ${S}.users.age + 1`,
            [1 + Math.floor(rnd() * 10)],
          );
          return "upsert";
        }
        if (k < 0.83) {
          await sql.unsafe(`truncate ${S}.users`);
          return "truncate";
        }
        if (k < 0.9) {
          await sql
            .begin(async (tx) => {
              await tx.unsafe(`update ${S}.users set name = 'X'`);
              throw new Error("abort");
            })
            .catch(() => {});
          return "rollback";
        }
        await sql.begin(async (tx) => {
          await tx.unsafe(`update ${S}.users set age = 1 where id = $1`, [1 + Math.floor(rnd() * 10)]);
          await tx.unsafe(`delete from ${S}.children where v = 0 and id % 2 = 0`);
        });
        return "two-statements";
      };
      const sync = async (id: string) => {
        const seen = new Promise<void>((r) => waiters.set(id, r));
        await emitBarrier(sql, id);
        await seen;
      };
      try {
        await sync("seed");
        let before = await snapshot();
        let checkedRows = 0;
        for (let i = 0; i < STEPS; i++) {
          const from = txns.length;
          const kind = await write();
          await sync(`s${i}`);
          const after = await snapshot();
          const got = new Set<string>();
          const whole = new Set<string>();
          for (const t of txns.slice(from)) {
            for (const w of t.wholeTables) whole.add(w.split(".")[1]!);
            for (const c of t.changes) {
              const tbl = c.table.split(".")[1]!;
              if (c.old) got.add(`${tbl}|${String(c.old["id"])}|old`);
              if (c.new) got.add(`${tbl}|${String(c.new["id"])}|new`);
            }
          }
          const missing: string[] = [];
          for (const [key, o] of before) {
            const nw = after.get(key);
            if (nw === o) continue;
            const [tbl, id] = key.split("|");
            checkedRows++;
            if (!whole.has(tbl!) && !got.has(`${tbl}|${id}|old`)) missing.push(`${key} old (${kind})`);
            if (nw && !whole.has(tbl!) && !got.has(`${tbl}|${id}|new`)) missing.push(`${key} new (${kind})`);
          }
          for (const key of after.keys()) {
            if (before.has(key)) continue;
            const [tbl, id] = key.split("|");
            checkedRows++;
            if (!whole.has(tbl!) && !got.has(`${tbl}|${id}|new`)) missing.push(`${key} new (${kind})`);
          }
          expect(missing).toEqual([]);
          before = after;
        }
        expect(checkedRows).toBeGreaterThan(STEPS / 2); // the property ran on real changes, not on an idle table
        expect(errors).toEqual([]);
      } finally {
        await cap.stop();
      }
    });
  },
  180_000,
);
