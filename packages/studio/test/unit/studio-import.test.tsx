import { expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import { EMPTY_DRAFT } from "../../src/edit/draft";
import { exportSql } from "../../src/grid/export";
import { applyImport } from "../../src/import/dialog";
import { col, createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

async function renderUsers() {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  await screen.findByText("User 1");
}

test("Import JSON adds pending rows; a bad enum cell is skipped", async () => {
  await renderUsers();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: JSON.stringify([{ name: "Imported", role: "not-a-role", email: "i@x.com" }]) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import rows" }));
  await screen.findByText("Imported");
  const pending = screen.getByText("Imported").closest("[role=gridcell]");
  expect(pending?.getAttribute("data-pending")).toBe("true");
  expect(screen.queryByText("not-a-role")).toBeNull();
});

test("applyImport skips a bad cell and extras; empty is null only when allowed", () => {
  const columns = [
    col("email", "text", "text", { nullable: false }),
    col("name", "text", "text"),
    col("role", "enum", "role", { nullable: false, hasDefault: true, enumValues: ["admin", "viewer"] }),
    col("id", "uuid", "uuid", { nullable: false, hasDefault: true }),
  ];
  const { draft, applied } = applyImport(EMPTY_DRAFT, columns, [
    { name: "Ada", role: "not-a-role", email: "a@x.com", extra: "ignored" },
    { name: "", email: "", role: "", id: "" },
  ]);
  expect(applied).toBe(2);
  // addRow prepends, so the last payload is inserts[0].
  expect(draft.inserts[0]?.values).toEqual({ name: null, role: null, id: null });
  expect(draft.inserts[1]?.values).toEqual({ name: "Ada", email: "a@x.com" });
});

test("a read-only table has no Import button", async () => {
  await renderUsers();
  fireEvent.click(screen.getByRole("button", { name: "audit_log" }));
  await screen.findByText("read-only");
  expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
});

test("SQL that names another table is refused and adds nothing", async () => {
  await renderUsers();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Kind"), { target: { value: "sql" } });
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: {
      value: exportSql({ schema: "public", name: "posts" }, [col("title", "text", "text")], [{ title: "Nope" }]),
    },
  });
  expect(within(dialog).getByRole("status").textContent).toMatch(/public\.posts/);
  expect(within(dialog).getByRole("button", { name: "Import rows" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Nope")).toBeNull();
});

test("Import rows is disabled when the parse fails or there are no rows", async () => {
  await renderUsers();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog");
  const confirm = () => within(dialog).getByRole("button", { name: "Import rows" });
  expect(confirm().hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "[]" } });
  expect(confirm().hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "{" } });
  expect(confirm().hasAttribute("disabled")).toBe(true);
});

test("picking a file sets the kind from its extension", async () => {
  await renderUsers();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog");
  const file = new File(["name,email\nFromCsv,c@x.com\n"], "users.csv", { type: "text/csv" });
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [file] } });
  });
  await waitFor(() => {
    expect((within(dialog).getByLabelText("Kind") as HTMLSelectElement).value).toBe("csv");
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import rows" }));
  await screen.findByText("FromCsv");
  expect(screen.getByText("FromCsv").closest("[role=gridcell]")?.getAttribute("data-pending")).toBe("true");
});
