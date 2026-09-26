import { expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import { download, setDownloadForTests } from "../../src/grid/export";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

function setupDownload() {
  const calls: string[] = [];
  const orig = download;
  setDownloadForTests((name, text) => {
    calls.push(name, text);
  });
  return {
    calls,
    restore: () => setDownloadForTests(orig),
  };
}

async function renderUsers() {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  render(<Studio dataSource={ds} codeEditor="textarea" defaultView={{ ...EMPTY_VIEW, table: "public.users" }} />);
  await screen.findByText("User 1");
}

test("Export JSON downloads the selected row, not the whole page", async () => {
  const { calls, restore } = setupDownload();
  try {
    await renderUsers();
    fireEvent.click(screen.getAllByLabelText("Select row")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "JSON" }));
    });
    expect(calls[0]).toMatch(/users\.json$/);
    const parsed = JSON.parse(calls[1] ?? "[]");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.email).toBe("user1@example.com");
  } finally {
    restore();
  }
});

test("cell menu Export JSON downloads the range's rows, not the checkbox selection", async () => {
  const { calls, restore } = setupDownload();
  try {
    await renderUsers();
    fireEvent.click(screen.getAllByLabelText("Select row")[1]!);
    fireEvent.contextMenu(screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Export JSON" }));
    });
    const parsed = JSON.parse(calls[1] ?? "[]");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.email).toBe("user1@example.com");
  } finally {
    restore();
  }
});
