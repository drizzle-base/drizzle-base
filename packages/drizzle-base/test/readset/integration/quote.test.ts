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

test("dollarQuote retries a tag found in the text, or one the text's end would complete early", async () => {
  // The first tag occurs in the text; the second is completed by the text's last characters followed by the
  // closing tag ("…$dzb_b" + "$dzb_b$" holds "$dzb_b$" one byte early); the third is safe.
  const text = "a $dzb_a$ b $dzb_b";
  const tags = ["$dzb_a$", "$dzb_b$", "$dzb_c$"];
  const quoted = dollarQuote(text, () => tags.shift() ?? "$dzb_z$");
  expect(quoted).toBe(`$dzb_c$${text}$dzb_c$`);
  expect(tags).toEqual([]); // the premise: both unsafe tags were drawn and refused
  const sql = testSql(1);
  try {
    const [{ t }] = await sql.unsafe(`select ${quoted}::text as t`).simple();
    expect(t).toBe(text);
  } finally {
    await sql.close();
  }
});
