import { expect, test } from "bun:test";
import { demoDataset } from "../../src/mock";
import { relationsOf } from "../../src/studio/relations";

test("posts.author_id is a forward relation to users; users has reverse posts", () => {
  const tables = demoDataset(1).tables.map((t) => t.info);
  const posts = tables.find((t) => t.name === "posts");
  const users = tables.find((t) => t.name === "users");
  if (!posts || !users) throw new Error("demo");
  expect(relationsOf(posts, tables)).toContainEqual({
    kind: "forward",
    name: "users",
    table: { schema: "public", name: "users" },
    column: "id",
    local: "author_id",
  });
  expect(relationsOf(users, tables).some((r) => r.kind === "reverse" && r.table.name === "posts")).toBe(true);
});
