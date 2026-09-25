// The prepared catalog batch embeds its payload as a dollar-quoted literal (EXECUTE takes no bind parameters).
// Whatever the text, the literal must come back from Postgres byte for byte: nothing inside may close it early.
import { expect, test } from "bun:test";
import { dollarQuote } from "../../../src/readset";
import { testSql } from "../../support/db";

const NASTY = [
  "plain",
  "it's",
  "$$",
  "$q$ closes a fixed tag",
  "$dzb_$ $dzb_0$ $dzb_ff$",
  "back\\slash \\' and \\\\",
  '{"name":"\\"a$q$b\'c\\""}',
  "line\nbreak\ttab",
  "; drop table dzb_app.users; --",
  "",
];

test("dollarQuote round-trips any text through Postgres unchanged", async () => {
  const sql = testSql(1);
  try {
    for (const text of NASTY) {
      const [{ t }] = await sql.unsafe(`select ${dollarQuote(text)}::text as t`).simple();
      expect(t).toBe(text);
    }
  } finally {
    await sql.close();
  }
});

test("dollarQuote never reuses a tag that occurs in the text", () => {
  for (let i = 0; i < 200; i++) {
    const quoted = dollarQuote("$dzb_ $q$");
    const tag = quoted.slice(0, quoted.indexOf("$", 1) + 1);
    expect(quoted.slice(tag.length, -tag.length)).not.toContain(tag);
  }
});
