import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

test("STRUCTURE lists the primary-key index; DATA comes back on the other tab", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  await screen.findByText("User 1");
  fireEvent.click(screen.getByRole("button", { name: "STRUCTURE" }));
  const pane = screen.getByRole("region", { name: "Structure" });
  expect(pane.textContent).toMatch(/users_pkey/);
  expect(pane.textContent).toMatch(/uuid/);
  expect(screen.queryByRole("grid")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "DATA" }));
  expect(await screen.findByRole("grid")).toBeTruthy();
});

test("switching DATA and STRUCTURE keeps the row selected", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  await screen.findByText("User 1");
  const box = screen.getAllByRole("checkbox", { name: "Select row" })[0] as HTMLInputElement;
  fireEvent.click(box);
  expect(box.checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "STRUCTURE" }));
  fireEvent.click(screen.getByRole("button", { name: "DATA" }));
  const again = (await screen.findAllByRole("checkbox", { name: "Select row" }))[0] as HTMLInputElement;
  expect(again.checked).toBe(true);
});
