import { beforeAll, describe, expect, test } from "bun:test";
import { ForbiddenStatementError, loadParser, parseStatement } from "../src/sql/parse";

beforeAll(loadParser);

describe("parseStatement", () => {
	test("the four allowed kinds", () => {
		expect(parseStatement("select 1").kind).toBe("select");
		expect(parseStatement("insert into t values (1)").kind).toBe("insert");
		expect(parseStatement("update t set a = 1").kind).toBe("update");
		expect(parseStatement("delete from t").kind).toBe("delete");
		expect(parseStatement("with x as (select 1) insert into t select * from x").kind).toBe("insert");
	});

	test.each([
		["begin", /TransactionStmt/],
		["commit", /TransactionStmt/],
		["savepoint a", /TransactionStmt/],
		["set transaction isolation level read committed", /VariableSetStmt/],
		["create table x(id int)", /CreateStmt/],
		["truncate t", /TruncateStmt/],
		["select 1; delete from t", /exactly one statement/],
		[";", /exactly one statement/],
		["", /empty/],
		["selec 1", /unparseable/],
	])("refuses %p", (sqlText, reason) => {
		expect(() => parseStatement(sqlText)).toThrow(ForbiddenStatementError);
		expect(() => parseStatement(sqlText)).toThrow(reason);
	});

	test("a repeated text is parsed once (the same object comes back)", () => {
		const a = parseStatement('select * from "users" where "users"."id" = $1');
		expect(parseStatement('select * from "users" where "users"."id" = $1')).toBe(a);
	});
});
