// REVIEW-A probe: the P3 oracle's evaluator primitives (copied verbatim from p1-extract/oracle.ts:130,166-167)
// against the Postgres answers in js_semantics.pg.out. A "false" where PG says t is an under-invalidation.
const likeRe = (p: string, flags: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);
const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
const out: Record<string, unknown> = {
  "nan_eq (PG t)": cmp(NaN, NaN) === 0,
  "nan_gt (PG t)": cmp(NaN, 5) > 0,
  "numdiv 2.5/2 > 1.2 (PG t)": Math.trunc(2.5 / 2) > 1.2,
  "numeq '1.0' vs '1.00' as decoded text (PG t)": "1.0" === "1.00",
  "like_nl (PG t)": likeRe("a%", "").test("a\nb"),
  "like_bs 'ab' like 'a\\%' (PG f)": likeRe("a\\%", "").test("ab"),
  "like_bs 'a%' like 'a\\%' (PG t)": likeRe("a\\%", "").test("a%"),
  "like_emoji (PG t)": likeRe("_", "").test("😀"),
  "ilike_kelvin 'K' ilike U+212A (PG t)": likeRe("\u212A", "i").test("K"),
  "ilike_dotted 'İ' ilike 'i' (PG t)": likeRe("i", "i").test("İ"),
  "lower('İ') (PG 'i')": "İ".toLowerCase(),
  "nondet collation 'Abc'='abc' (PG t)": "Abc" === "abc",
};
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(48), JSON.stringify(v));
