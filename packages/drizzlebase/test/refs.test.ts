import { beforeAll, describe, expect, test } from "bun:test";
import { collectRefs } from "../src/readset/refs";
import { loadParser, parseStatement } from "../src/sql/parse";

beforeAll(loadParser);
const rels = (sqlText: string) => collectRefs(parseStatement(sqlText).stmt).relations.map((r) => (r.schema ? `${r.schema}.${r.name}` : r.name)).sort();

describe("collectRefs", () => {
	// The five shapes review A found missing from the spike's read-set (spikes/review-a/analyzer_holes.out).
	test.each([
		["not exists", `select * from users u where not exists (select 1 from posts p where p.author_id = u.id)`, ["posts", "users"]],
		["not in (subquery)", `select * from users where id not in (select author_id from posts)`, ["posts", "users"]],
		["or with a subquery", `select * from users where age > 60 or id in (select author_id from posts)`, ["posts", "users"]],
		["case with a subquery", `select case when exists (select 1 from posts) then 1 end from users`, ["posts", "users"]],
		["quoted mixed case", `select * from "Users" where "Users"."Age" = 30`, ["Users"]],
	])("%s keeps every table", (_name, sqlText, expected) => {
		expect(rels(sqlText)).toEqual(expected);
	});

	test("schema-qualified names, joins, set operations, lateral, scalar subqueries", () => {
		expect(rels(`select (select count(*) from app.comments) from app.users join app.posts on true intersect select 1 from cities`)).toEqual(["app.comments", "app.posts", "app.users", "cities"]);
		expect(rels(`select * from users left join lateral (select * from posts limit 3) p on true`)).toEqual(["posts", "users"]);
	});

	test("CTE names are reported, and a table referenced inside the CTE is kept", () => {
		const r = collectRefs(parseStatement(`with recursive t as (select id from nodes union all select n.id from nodes n join t on n.parent = t.id) select * from t`).stmt);
		expect([...r.cteNames]).toEqual(["t"]);
		expect(r.relations.map((x) => x.name).sort()).toEqual(["nodes", "nodes", "t", "t"]); // t: the recursive arm and the outer FROM
	});

	test("functions, qualified or not, and SQL value functions", () => {
		const r = collectRefs(parseStatement(`select now(), app.score(u.id), lower(name), current_date from users u where created_at > now() - interval '1 day'`).stmt);
		expect(r.functions.map((f) => (f.schema ? `${f.schema}.${f.name}` : f.name)).sort()).toEqual(["app.score", "lower", "now", "now"]);
		expect(r.valueFunctions).toEqual(["SVFOP_CURRENT_DATE"]);
	});

	test("the target of a write is a relation too", () => {
		expect(rels(`update posts set views = views + 1 from users where posts.author_id = users.id`)).toEqual(["posts", "users"]);
	});
});
