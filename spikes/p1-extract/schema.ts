// THROWAWAY SPIKE (P1) — a small schema that exercises joins, self-references and relations.
import { relations } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const countries = pgTable("countries", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	population: integer("population"),
});

export const cities = pgTable(
	"cities",
	{
		id: integer("id").primaryKey(),
		countryId: integer("country_id").references(() => countries.id),
		name: text("name").notNull(),
		population: integer("population"),
	},
	(t) => [index("cities_country").on(t.countryId)],
);

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		age: integer("age"),
		managerId: uuid("manager_id"),
		deleted: boolean("deleted").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [index("users_email").on(t.email), index("users_age").on(t.age)],
);

export const posts = pgTable(
	"posts",
	{
		id: integer("id").primaryKey(),
		authorId: uuid("author_id").notNull(),
		title: text("title").notNull(),
		published: boolean("published").notNull().default(false),
		views: integer("views").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(t) => [index("posts_author").on(t.authorId, t.createdAt)],
);

export const comments = pgTable("comments", {
	id: integer("id").primaryKey(),
	postId: integer("post_id").notNull(),
	authorId: uuid("author_id").notNull(),
	body: text("body").notNull(),
});

export const usersRelations = relations(users, ({ many, one }) => ({
	posts: many(posts),
	comments: many(comments),
	manager: one(users, { fields: [users.managerId], references: [users.id], relationName: "manager" }),
}));
export const postsRelations = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
}));
export const commentsRelations = relations(comments, ({ one }) => ({
	post: one(posts, { fields: [comments.postId], references: [posts.id] }),
	author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
export const countriesRelations = relations(countries, ({ many }) => ({ cities: many(cities) }));
export const citiesRelations = relations(cities, ({ one }) => ({
	country: one(countries, { fields: [cities.countryId], references: [countries.id] }),
}));
