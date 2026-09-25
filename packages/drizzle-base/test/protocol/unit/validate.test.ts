import { expect, test } from "bun:test";
import { parseClientFrame } from "../../../src/protocol";

test("well-formed client frames parse, their args decoded", () => {
  expect(parseClientFrame('{"t":"sub","id":"1","name":"posts.list","args":{}}')).toEqual({
    ok: true,
    frame: { t: "sub", id: "1", name: "posts.list", args: {} },
  });
  const mut = parseClientFrame(
    '{"t":"mut","id":"m","name":"posts.add","args":{"at":{"$t":"date","v":"2026-01-01T00:00:00.000Z"}}}',
  );
  expect(mut.ok && mut.frame.t === "mut" && mut.frame.args["at"] instanceof Date).toBe(true);
  expect(parseClientFrame('{"t":"unsub","id":"1"}')).toEqual({ ok: true, frame: { t: "unsub", id: "1" } });
  expect(parseClientFrame('{"t":"ping"}')).toEqual({ ok: true, frame: { t: "ping" } });
});

test("every malformed frame is refused, with the id when one could be read", () => {
  const bad: [string, string | undefined][] = [
    ["not json", undefined],
    ["[1,2]", undefined],
    ['{"id":"1"}', "1"],
    ['{"t":"nope","id":"1"}', "1"],
    ['{"t":"sub","id":1,"name":"a","args":{}}', undefined],
    ['{"t":"sub","id":"","name":"a","args":{}}', undefined],
    [`{"t":"sub","id":"${"x".repeat(65)}","name":"a","args":{}}`, undefined],
    ['{"t":"sub","id":"1","name":"","args":{}}', "1"],
    [`{"t":"sub","id":"1","name":"${"n".repeat(201)}","args":{}}`, "1"],
    ['{"t":"sub","id":"1","name":"a","args":[1]}', "1"],
    ['{"t":"sub","id":"1","name":"a","args":null}', "1"],
    ['{"t":"sub","id":"1","name":"a"}', "1"],
    ['{"t":"mut","id":"1","name":"a","args":{"__proto__":{"x":1}}}', "1"],
    ['{"t":"unsub"}', undefined],
  ];
  for (const [text, id] of bad) {
    const r = parseClientFrame(text);
    expect({ text, ok: r.ok }).toEqual({ text, ok: false });
    if (!r.ok) expect({ text, id: r.id }).toEqual({ text, id });
  }
});
