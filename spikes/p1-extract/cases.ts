// THROWAWAY SPIKE (P1) — the corpus: every Drizzle query shape we want to classify.
import {
	and, asc, avg, between, count, countDistinct, desc, eq, exists, gt, gte, ilike, inArray, isNotNull,
	isNull, like, lt, lte, max, ne, not, notInArray, or, sql, sum,
} from "drizzle-orm";
import { alias, except, intersect, union, unionAll } from "drizzle-orm/pg-core";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import * as s from "./schema";
import { cities, comments, countries, posts, users } from "./schema";

type DB = PgRemoteDatabase<typeof s>;
export interface Case {
	id: string;
	cat: string;
	run: (db: DB) => PromiseLike<unknown>;
}

const U1 = "0190a000-0000-7000-8000-000000000001";

export const cases: Case[] = [
	// ── A. single table ────────────────────────────────────────────────
	{ id: "A01 eq pk", cat: "single", run: (db) => db.select().from(users).where(eq(users.id, U1)) },
	{ id: "A02 eq indexed", cat: "single", run: (db) => db.select().from(users).where(eq(users.email, "a@b.c")) },
	{ id: "A03 range gt/lte", cat: "single", run: (db) => db.select().from(users).where(and(gt(users.age, 18), lte(users.age, 65))) },
	{ id: "A04 between", cat: "single", run: (db) => db.select().from(users).where(between(users.age, 18, 65)) },
	{ id: "A05 inArray", cat: "single", run: (db) => db.select().from(users).where(inArray(users.age, [18, 21, 30])) },
	{ id: "A06 isNull", cat: "single", run: (db) => db.select().from(users).where(isNull(users.managerId)) },
	{ id: "A07 eq + isNotNull", cat: "single", run: (db) => db.select().from(users).where(and(eq(users.deleted, false), isNotNull(users.age))) },
	{ id: "A08 or same column", cat: "single", run: (db) => db.select().from(users).where(or(eq(users.age, 18), eq(users.age, 30))) },
	{ id: "A09 or diff columns", cat: "single", run: (db) => db.select().from(users).where(or(eq(users.age, 18), eq(users.email, "x"))) },
	{ id: "A10 ne", cat: "single", run: (db) => db.select().from(users).where(ne(users.age, 18)) },
	{ id: "A11 like", cat: "single", run: (db) => db.select().from(users).where(like(users.name, "Dan%")) },
	{ id: "A12 ilike", cat: "single", run: (db) => db.select().from(users).where(ilike(users.name, "%dan%")) },
	{ id: "A13 not(eq)", cat: "single", run: (db) => db.select().from(users).where(not(eq(users.deleted, true))) },
	{ id: "A14 notInArray", cat: "single", run: (db) => db.select().from(users).where(notInArray(users.age, [1, 2])) },
	{ id: "A15 no where", cat: "single", run: (db) => db.select().from(users) },
	{ id: "A16 order+limit", cat: "single", run: (db) => db.select().from(posts).where(eq(posts.authorId, U1)).orderBy(desc(posts.createdAt)).limit(10) },
	{ id: "A17 order+limit+offset", cat: "single", run: (db) => db.select().from(posts).orderBy(asc(posts.id)).limit(3).offset(2) },
	{ id: "A18 partial columns", cat: "single", run: (db) => db.select({ id: users.id, name: users.name }).from(users).where(eq(users.age, 30)) },
	{ id: "A19 distinct", cat: "single", run: (db) => db.selectDistinct({ age: users.age }).from(users) },
	{ id: "A20 cursor (gt, order, limit)", cat: "single", run: (db) => db.select().from(posts).where(gt(posts.id, 100)).orderBy(asc(posts.id)).limit(20) },
	{ id: "A21 expression lower()", cat: "single", run: (db) => db.select().from(users).where(eq(sql`lower(${users.email})`, "a@b.c")) },
	{ id: "A22 arithmetic", cat: "single", run: (db) => db.select().from(posts).where(gt(sql`${posts.views} * 2`, 100)) },
	{ id: "A23 column vs column", cat: "single", run: (db) => db.select().from(cities).where(gt(cities.population, cities.id)) },
	{ id: "A24 composite index prefix+range", cat: "single", run: (db) => db.select().from(posts).where(and(eq(posts.authorId, U1), gte(posts.createdAt, new Date("2026-01-01")))) },
	{ id: "A25 undefined in and()", cat: "single", run: (db) => db.select().from(users).where(and(eq(users.age, 30), undefined)) },
	{ id: "A26 sql.placeholder (prepared)", cat: "single", run: (db) => db.select().from(users).where(eq(users.id, sql.placeholder("id"))).prepare("p1").execute({ id: U1 }) },

	// ── B. joins ───────────────────────────────────────────────────────
	{ id: "B01 left join (your example)", cat: "join", run: (db) => db.select().from(countries).leftJoin(cities, eq(cities.countryId, countries.id)).where(eq(countries.id, 10)) },
	{ id: "B02 inner join + filter both", cat: "join", run: (db) => db.select().from(posts).innerJoin(users, eq(posts.authorId, users.id)).where(and(eq(posts.published, true), gt(users.age, 18))) },
	{ id: "B03 right join", cat: "join", run: (db) => db.select().from(posts).rightJoin(users, eq(posts.authorId, users.id)).where(eq(users.id, U1)) },
	{ id: "B04 full join", cat: "join", run: (db) => db.select().from(posts).fullJoin(users, eq(posts.authorId, users.id)) },
	{ id: "B05 three-way join", cat: "join", run: (db) => db.select().from(comments).innerJoin(posts, eq(comments.postId, posts.id)).innerJoin(users, eq(posts.authorId, users.id)).where(eq(users.id, U1)) },
	{ id: "B06 self join (alias)", cat: "join", run: (db) => { const m = alias(users, "manager"); return db.select().from(users).leftJoin(m, eq(users.managerId, m.id)).where(eq(users.id, U1)); } },
	{ id: "B07 join ON with extra cond", cat: "join", run: (db) => db.select().from(users).leftJoin(posts, and(eq(posts.authorId, users.id), eq(posts.published, true))).where(eq(users.age, 30)) },
	{ id: "B08 join no where", cat: "join", run: (db) => db.select().from(countries).innerJoin(cities, eq(cities.countryId, countries.id)) },
	{ id: "B09 cross join", cat: "join", run: (db) => db.select().from(countries).crossJoin(cities) },
	{ id: "B10 left join lateral", cat: "join", run: (db) => { const sq = db.select().from(posts).where(eq(posts.authorId, users.id)).orderBy(desc(posts.createdAt)).limit(3).as("recent"); return db.select().from(users).leftJoinLateral(sq, sql`true`).where(eq(users.id, U1)); } },

	// ── C. aggregates ──────────────────────────────────────────────────
	{ id: "C01 count(*)", cat: "agg", run: (db) => db.select({ n: count() }).from(posts).where(eq(posts.authorId, U1)) },
	{ id: "C02 $count", cat: "agg", run: (db) => db.$count(posts, eq(posts.published, true)) },
	{ id: "C03 groupBy + sum", cat: "agg", run: (db) => db.select({ a: posts.authorId, v: sum(posts.views) }).from(posts).groupBy(posts.authorId) },
	{ id: "C04 groupBy + having", cat: "agg", run: (db) => db.select({ a: posts.authorId, n: count() }).from(posts).groupBy(posts.authorId).having(gt(count(), 1)) },
	{ id: "C05 join + groupBy", cat: "agg", run: (db) => db.select({ c: countries.name, n: count(cities.id) }).from(countries).leftJoin(cities, eq(cities.countryId, countries.id)).groupBy(countries.id) },
	{ id: "C06 avg/max/countDistinct", cat: "agg", run: (db) => db.select({ a: avg(users.age), m: max(users.age), d: countDistinct(users.email) }).from(users).where(eq(users.deleted, false)) },

	// ── D. subqueries / CTE ────────────────────────────────────────────
	{ id: "D01 inArray(subquery)", cat: "subq", run: (db) => db.select().from(posts).where(inArray(posts.authorId, db.select({ id: users.id }).from(users).where(gt(users.age, 30)))) },
	{ id: "D02 exists correlated", cat: "subq", run: (db) => db.select().from(users).where(exists(db.select().from(posts).where(and(eq(posts.authorId, users.id), eq(posts.published, true))))) },
	{ id: "D03 CTE $with", cat: "subq", run: (db) => { const adults = db.$with("adults").as(db.select().from(users).where(gte(users.age, 18))); return db.with(adults).select().from(adults); } },
	{ id: "D04 subquery in FROM", cat: "subq", run: (db) => { const sq = db.select({ a: posts.authorId, n: count().as("n") }).from(posts).groupBy(posts.authorId).as("sq"); return db.select().from(sq).where(gt(sq.n, 3)); } },
	{ id: "D05 scalar subquery column", cat: "subq", run: (db) => db.select({ id: users.id, n: sql<number>`(select count(*) from ${posts} where ${posts.authorId} = ${users.id})` }).from(users).where(eq(users.id, U1)) },
	{ id: "D06 join to subquery", cat: "subq", run: (db) => { const sq = db.select().from(posts).where(eq(posts.published, true)).as("pp"); return db.select().from(users).innerJoin(sq, eq(sq.authorId, users.id)).where(eq(users.id, U1)); } },

	// ── E. relational queries (RQB v1) ─────────────────────────────────
	{ id: "E01 findMany + with posts", cat: "rqb", run: (db) => db.query.users.findMany({ with: { posts: true } }) },
	{ id: "E02 findFirst by id + with", cat: "rqb", run: (db) => db.query.users.findFirst({ where: eq(users.id, U1), with: { posts: true } }) },
	{ id: "E03 nested with", cat: "rqb", run: (db) => db.query.users.findMany({ where: eq(users.age, 30), with: { posts: { with: { comments: true } } } }) },
	{ id: "E04 with filtered+limited", cat: "rqb", run: (db) => db.query.users.findFirst({ where: eq(users.id, U1), with: { posts: { where: eq(posts.published, true), orderBy: desc(posts.createdAt), limit: 5 } } }) },
	{ id: "E05 one() relation", cat: "rqb", run: (db) => db.query.posts.findMany({ where: eq(posts.published, true), with: { author: true } }) },
	{ id: "E06 self relation", cat: "rqb", run: (db) => db.query.users.findFirst({ where: eq(users.id, U1), with: { manager: true } }) },
	{ id: "E07 columns + extras", cat: "rqb", run: (db) => db.query.users.findMany({ columns: { id: true }, extras: { lname: sql<string>`lower(${users.name})`.as("lname") }, where: eq(users.age, 30) }) },
	{ id: "E08 where callback", cat: "rqb", run: (db) => db.query.users.findMany({ where: (u, { and, eq, gt }) => and(eq(u.deleted, false), gt(u.age, 18)), limit: 10, orderBy: (u, { asc }) => asc(u.createdAt) }) },
	{ id: "E09 your example (countries/cities)", cat: "rqb", run: (db) => db.query.countries.findFirst({ where: eq(countries.id, 10), with: { cities: true } }) },

	// ── F. raw / non-deterministic ─────────────────────────────────────
	{ id: "F01 sql`` in where", cat: "raw", run: (db) => db.select().from(users).where(sql`${users.age} > ${18}`) },
	{ id: "F02 now()", cat: "raw", run: (db) => db.select().from(posts).where(gt(posts.createdAt, sql`now() - interval '1 day'`)) },
	{ id: "F03 random order", cat: "raw", run: (db) => db.select().from(posts).orderBy(sql`random()`).limit(1) },
	{ id: "F04 db.execute raw", cat: "raw", run: (db) => db.execute(sql`select * from users where age > ${18}`) },
	{ id: "F05 db.execute raw string", cat: "raw", run: (db) => db.execute(sql.raw("select u.*, p.title from users u join posts p on p.author_id = u.id where u.age = 30")) },
	{ id: "F06 jsonb/array op", cat: "raw", run: (db) => db.select().from(users).where(sql`${users.email} = any(${["a", "b"]})`) },

	// ── G. set operations ──────────────────────────────────────────────
	{ id: "G01 union", cat: "setop", run: (db) => union(db.select({ id: users.id }).from(users).where(eq(users.age, 1)), db.select({ id: posts.authorId }).from(posts).where(eq(posts.published, true))) },
	{ id: "G02 unionAll", cat: "setop", run: (db) => unionAll(db.select({ n: users.name }).from(users), db.select({ n: countries.name }).from(countries)) },
	{ id: "G03 intersect", cat: "setop", run: (db) => intersect(db.select({ id: users.id }).from(users).where(gt(users.age, 18)), db.select({ id: posts.authorId }).from(posts)) },
	{ id: "G04 except", cat: "setop", run: (db) => except(db.select({ id: users.id }).from(users), db.select({ id: posts.authorId }).from(posts)) },

	// ── W. writes (what the capture would have to know) ────────────────
	{ id: "W01 insert values", cat: "write", run: (db) => db.insert(posts).values({ id: 1, authorId: U1, title: "t" }) },
	{ id: "W02 insert default uuid", cat: "write", run: (db) => db.insert(users).values({ name: "n", email: "e" }) },
	{ id: "W03 update by pk", cat: "write", run: (db) => db.update(users).set({ name: "x" }).where(eq(users.id, U1)) },
	{ id: "W04 update by predicate", cat: "write", run: (db) => db.update(posts).set({ published: true }).where(like(posts.title, "draft%")) },
	{ id: "W05 update expression", cat: "write", run: (db) => db.update(posts).set({ views: sql`${posts.views} + 1` }).where(eq(posts.id, 1)) },
	{ id: "W06 delete by predicate", cat: "write", run: (db) => db.delete(comments).where(eq(comments.authorId, U1)) },
	{ id: "W07 upsert", cat: "write", run: (db) => db.insert(posts).values({ id: 1, authorId: U1, title: "t" }).onConflictDoUpdate({ target: posts.id, set: { title: "t2" } }) },
	{ id: "W08 insert from select", cat: "write", run: (db) => db.insert(comments).select(db.select({ id: posts.id, postId: posts.id, authorId: posts.authorId, body: posts.title }).from(posts).where(eq(posts.published, true))) },
	{ id: "W09 update from join", cat: "write", run: (db) => db.update(posts).set({ published: false }).from(users).where(and(eq(posts.authorId, users.id), eq(users.deleted, true))) },
];
