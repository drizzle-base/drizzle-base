// The test application: a Drizzle schema in "dzb_app" plus the objects that exercise the read-set's edges —
// a view, an RLS table, a partitioned table, an inheritance pair, a user SQL function, and a table outside
// the publication (public.dzb_outside).
import type { SQL } from "bun";
import { relations } from "drizzle-orm";
import { boolean, integer, pgSchema, serial, text, uuid } from "drizzle-orm/pg-core";
import { type CaptureNames, dropCapture, ensureCapture } from "../../src/capture/setup";
import { testSql, uniqueName } from "../db";

export const APP_SCHEMA = "dzb_app";
const app = pgSchema(APP_SCHEMA);

export const users = app.table("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	age: integer("age"),
});
export const posts = app.table("posts", {
	id: serial("id").primaryKey(),
	authorId: uuid("author_id").notNull(),
	title: text("title").notNull(),
	published: boolean("published").notNull().default(false),
});
export const comments = app.table("comments", {
	id: serial("id").primaryKey(),
	postId: integer("post_id").notNull(),
	body: text("body").notNull(),
});
export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
}));
export const commentsRelations = relations(comments, ({ one }) => ({ post: one(posts, { fields: [comments.postId], references: [posts.id] }) }));
export const schema = { users, posts, comments, usersRelations, postsRelations, commentsRelations };

export const APP_DDL = `
drop schema if exists ${APP_SCHEMA} cascade;
drop table if exists public.dzb_outside;
create schema ${APP_SCHEMA};
create table ${APP_SCHEMA}.users(id uuid primary key default gen_random_uuid(), name text not null, age int);
create table ${APP_SCHEMA}.posts(id serial primary key, author_id uuid not null, title text not null, published boolean not null default false);
create table ${APP_SCHEMA}.comments(id serial primary key, post_id int not null, body text not null);
create view ${APP_SCHEMA}.adults as select * from ${APP_SCHEMA}.users where age >= 18;
create table ${APP_SCHEMA}.secrets(id int primary key, owner uuid);
alter table ${APP_SCHEMA}.secrets enable row level security;
create table ${APP_SCHEMA}.events(id int, k int, primary key (id, k)) partition by list (k);
create table ${APP_SCHEMA}.events_1 partition of ${APP_SCHEMA}.events for values in (1);
create table ${APP_SCHEMA}.animals(id int primary key, name text);
create table ${APP_SCHEMA}.dogs(breed text) inherits (${APP_SCHEMA}.animals);
create function ${APP_SCHEMA}.post_count(u uuid) returns bigint language sql stable as $$ select count(*) from ${APP_SCHEMA}.posts where author_id = u $$;
create table public.dzb_outside(id int primary key);
`;

// Recreates dzb_app, then gives it its own publication + slot; both are dropped afterwards.
export async function withApp(fn: (sql: SQL, names: CaptureNames) => Promise<void>): Promise<void> {
	const sql = testSql(8);
	const names: CaptureNames = { schema: APP_SCHEMA, publication: uniqueName("pub"), slot: uniqueName("slot") };
	await sql.unsafe(APP_DDL);
	await ensureCapture(sql, names);
	try {
		await fn(sql, names);
	} finally {
		await dropCapture(sql, names);
		await sql.unsafe(`drop schema if exists ${APP_SCHEMA} cascade; drop table if exists public.dzb_outside`);
		await sql.close();
	}
}
