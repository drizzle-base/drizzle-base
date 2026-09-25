// REVIEW-A probe: feed the P1 analyzer (spikes/p1-extract/analyze.ts) SQL shapes outside its corpus.
// Run from spikes/p1-extract: bun ../review-a/analyzer_holes.ts
import { analyzeSql } from "../p1-extract/analyze";
const cases: Record<string, string> = {
	notExists: `select * from users where not exists (select 1 from posts where posts.author_id = users.id)`,
	notInSub: `select * from users where users.id not in (select author_id from posts)`,
	orWithSub: `select * from users where users.age > 60 or users.id in (select author_id from posts where views > 50)`,
	scalarSubInSelect: `select users.id, (select count(*) from posts where posts.author_id = users.id) as n from users where users.age = 30`,
	notOr: `select * from users where not (users.age = 30 and users.name like 'D%')`,
	caseWhen: `select * from users where case when users.age > 18 then users.name else users.email end = 'Dan'`,
	recursive: `with recursive t as (select id, manager_id from users where id = $1 union all select u.id, u.manager_id from users u join t on u.manager_id = t.id) select * from t`,
	lateralLimit: `select u.id, p.title from users u cross join lateral (select title from posts where posts.author_id = u.id order by views desc limit 1) p where u.age = 30`,
	distinctOn: `select distinct on (author_id) * from posts order by author_id, views desc`,
	schemaQual: `select * from public.users where public.users.age = 30`,
	quoted: `select * from "Users" where "Users"."Age" = 30`,
	windowFn: `select * from (select *, row_number() over (partition by author_id order by views desc) rn from posts) x where rn = 1 and x.author_id = $1`,
};
for (const [k, s] of Object.entries(cases)) {
	const a = analyzeSql(s, ["0190a000-0000-7000-8000-000000000001"]);
	console.log(k.padEnd(18), a.error ? `ERROR ${a.error}` : a.accesses.map((x) => `${x.table}:${x.tier}${x.bounds.length ? `[${x.bounds.map((o) => o.map((b) => `${b.col}${b.op}${JSON.stringify(b.value)}`).join("|")).join(",")}]` : ""}${x.preds.length ? `{${x.preds.length}p}` : ""}${x.dropped.length ? `<dropped:${x.dropped.length}>` : ""}`).join("  "), [...a.flags].join("; "));
}
process.exit(0);
