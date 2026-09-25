import { expect, test } from "bun:test";

test("the public entries are the only doors", async () => {
	const server = await import("drizzlebase/server");
	expect(typeof server.functions).toBe("function");
	expect(typeof server.Runtime).toBe("function");
	for (const hidden of ["drizzlebase/runtime", "drizzlebase/capture", "drizzlebase/src/runtime/index.ts"]) {
		const outcome = await import(hidden).then(() => "resolved", () => "blocked");
		expect(`${hidden}: ${outcome}`).toBe(`${hidden}: blocked`);
	}
});
