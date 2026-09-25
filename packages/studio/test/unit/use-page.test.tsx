import { expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import type { PageRequest, TableInfo } from "../../src/contract";
import { conformanceDataset, createMemoryLog, createMockDataSource } from "../../src/mock";
import { usePage } from "../../src/studio/use-page";

const ITEMS = { schema: "conformance", name: "items" };
const info = conformanceDataset().tables[0]?.info as TableInfo;
const LOG_INFO = conformanceDataset().tables[1]?.info as TableInfo;

const renders: string[] = [];

function Probe({
  ds,
  req,
  table,
}: {
  ds: ReturnType<typeof createMockDataSource>;
  req: PageRequest;
  table: TableInfo;
}) {
  const { page, changed } = usePage(ds, req, table);
  const text = page ? `${req.table.name}:${page.rows.length}:${[...changed].length}` : "none";
  renders.push(text);
  return <output>{text}</output>;
}

test("a new request starts clean: no rows from the old one, nothing marked changed", async () => {
  const ds = createMockDataSource({ dataset: conformanceDataset(), log: createMemoryLog() });
  await ds.insertRows(ITEMS, [{ label: "a" }, { label: "b" }]);
  const req = (table: typeof ITEMS, offset = 0): PageRequest => ({ table, filters: [], sort: [], limit: 50, offset });
  const view = render(<Probe ds={ds} req={req(ITEMS)} table={info} />);
  expect(await screen.findByText("items:2:0")).toBeTruthy();

  await act(async () => {
    await ds.updateRows(ITEMS, [{ key: { id: 1 }, values: { label: "A" } }]);
  });
  expect(await screen.findByText("items:2:1")).toBeTruthy();

  const logRef = { schema: "conformance", name: "log" };
  renders.length = 0;
  view.rerender(<Probe ds={ds} req={req(logRef)} table={LOG_INFO} />);
  expect(await screen.findByText("log:0:0")).toBeTruthy();
  // Every render after the switch showed either nothing or the new table's page — never items' rows as "log".
  expect(renders.filter((r) => r !== "none" && r !== "log:0:0")).toEqual([]);
});
