import type { CellValue, Row } from "../../contract";
import { col, type MockDataset, mockTable, mockView } from "../dataset";
import { mulberry32, uuidv7 } from "../ids";
import { pgBytea, pgDate, pgTimestamp, pgTimestamptz } from "../pgtext";

// Seed data never reads the clock: the same seed must give the same rows in every tab and every run.
const BASE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const ROLES = ["admin", "editor", "viewer"];
const CITIES = ["Recife", "Lisboa", "Berlin"];
const EVENTS = ["login", "logout", "export"];
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

export function demoDataset(seed: number): MockDataset {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const users: Row[] = [];
  for (let i = 1; i <= 3000; i++) {
    users.push({
      id: uuidv7(BASE + i * 1000, rand),
      email: `user${i}@example.com`,
      name: i % 7 === 0 ? null : `User ${i}`,
      role: ROLES[i % 3] ?? "viewer",
      active: i % 5 !== 0,
      score: (((i * 13) % 1000) / 10).toFixed(2),
      age: i % 11 === 0 ? null : 18 + Math.floor(rand() * 60),
      profile: JSON.stringify({ city: pick(CITIES), n: i, nested: { a: i % 2 === 0 } }),
      tags: [`t${i % 4}`, "x"],
      avatar: i % 10 === 0 ? pgBytea(new TextEncoder().encode(`id:${i}`)) : null,
      birthday: pgDate(new Date(Date.UTC(1970, 0, 1) + Math.floor(rand() * 15_000) * DAY)),
      created_at: pgTimestamptz(new Date(BASE + i * 60_000), Math.floor(rand() * 1000)),
      updated_at: i % 3 === 0 ? null : pgTimestamp(new Date(BASE + i * 3_600_000)),
    });
  }
  const userId = (n: number): CellValue => users[n % users.length]?.["id"] ?? null;

  const posts: Row[] = [];
  for (let i = 1; i <= 1500; i++) {
    posts.push({
      id: i,
      author_id: userId(i - 1),
      title: `Post ${i}`,
      body: LOREM,
      published: rand() < 0.5,
      meta: JSON.stringify({ views: Math.floor(rand() * 1000) }),
      created_at: pgTimestamptz(new Date(BASE + i * 90_000)),
    });
  }

  const comments: Row[] = [];
  for (let i = 1; i <= 2000; i++) {
    comments.push({
      id: String(i),
      post_id: 1 + (i % 1500),
      user_id: i % 13 === 0 ? null : userId(i * 7),
      body: `Comment ${i}`,
      created_at: pgTimestamptz(new Date(BASE + i * 45_000)),
    });
  }

  const audit: Row[] = [];
  for (let i = 1; i <= 50; i++) {
    audit.push({
      at: pgTimestamptz(new Date(BASE + i * 600_000)),
      event: `event.${pick(EVENTS)}`,
      ip: `10.0.${i % 4}.${i}`,
      payload: JSON.stringify({ i }),
    });
  }

  const invoices: Row[] = [];
  for (let i = 1; i <= 100; i++) {
    invoices.push({
      id: i,
      user_id: userId(i),
      amount_cents: 1000 + i * 37,
      tax_rate: [0, 0.1, 0.23][i % 3] ?? 0,
      status: i % 4 === 0 ? "refunded" : "paid",
      issued_on: pgDate(new Date(BASE + i * DAY)),
    });
  }

  const toUsers = { schema: "public", table: "users", column: "id" };
  return {
    tables: [
      mockTable(
        "public",
        "users",
        [
          col("id", "uuid", "uuid", { isPrimaryKey: true, nullable: false }),
          col("email", "text", "varchar(255)", { nullable: false }),
          col("name", "text", "text"),
          col("role", "enum", "role", { nullable: false, enumValues: ROLES }),
          col("active", "boolean", "boolean", { nullable: false }),
          col("score", "numeric", "numeric(10, 2)"),
          col("age", "integer", "integer"),
          col("profile", "json", "jsonb"),
          col("tags", "array", "text[]", { elementKind: "text" }),
          col("avatar", "bytea", "bytea"),
          col("birthday", "date", "date"),
          col("created_at", "timestamptz", "timestamp with time zone", { nullable: false }),
          col("updated_at", "timestamp", "timestamp"),
        ],
        users,
        { id: "uuidv7", role: { value: "viewer" }, active: { value: true }, created_at: "now" },
      ),
      mockTable(
        "public",
        "posts",
        [
          col("id", "integer", "serial", { isPrimaryKey: true, nullable: false }),
          col("author_id", "uuid", "uuid", { nullable: false, references: toUsers }),
          col("title", "text", "text", { nullable: false }),
          col("body", "text", "text"),
          col("published", "boolean", "boolean"),
          col("meta", "json", "json"),
          col("created_at", "timestamptz", "timestamp with time zone"),
        ],
        posts,
        { id: "serial", published: { value: false }, created_at: "now" },
      ),
      mockTable(
        "public",
        "comments",
        [
          col("id", "bigint", "bigserial", { isPrimaryKey: true, nullable: false }),
          col("post_id", "integer", "integer", {
            nullable: false,
            references: { schema: "public", table: "posts", column: "id" },
          }),
          col("user_id", "uuid", "uuid", { references: toUsers }),
          col("body", "text", "text", { nullable: false }),
          col("created_at", "timestamptz", "timestamp with time zone"),
        ],
        comments,
        { id: "serial", created_at: "now" },
      ),
      mockTable(
        "public",
        "audit_log",
        [
          col("at", "timestamptz", "timestamp with time zone"),
          col("event", "text", "text"),
          col("ip", "unknown", "inet"),
          col("payload", "json", "jsonb"),
        ],
        audit,
        { at: "now" },
      ),
      mockTable(
        "billing",
        "invoices",
        [
          col("id", "integer", "serial", { isPrimaryKey: true, nullable: false }),
          col("user_id", "uuid", "uuid", { references: toUsers }),
          col("amount_cents", "integer", "integer", { nullable: false }),
          col("tax_rate", "float", "double precision"),
          col("status", "text", "text"),
          col("issued_on", "date", "date"),
        ],
        invoices,
        { id: "serial" },
      ),
    ],
    views: [
      mockView(
        "public",
        "published_posts",
        [col("id", "integer", "integer"), col("title", "text", "text"), col("email", "text", "varchar(255)")],
        (read) => {
          const emails = new Map(read("public.users").map((u) => [u["id"] ?? null, u["email"] ?? null]));
          return read("public.posts")
            .filter((p) => p["published"] === true)
            .map((p) => ({
              id: p["id"] ?? null,
              title: p["title"] ?? null,
              email: emails.get(p["author_id"] ?? null) ?? null,
            }));
        },
      ),
    ],
  };
}
