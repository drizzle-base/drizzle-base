import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Page, TableInfo } from "../../src/contract";
import { EMPTY_DRAFT, setCell, setNewCell, type TableDraft } from "../../src/edit/draft";
import type { ClipboardIO } from "../../src/grid/clipboard";
import { DataGrid } from "../../src/grid/data-grid";
import { demoDataset } from "../../src/mock";
import { EMPTY_LAYOUT, layoutColumns } from "../../src/studio/prefs";

const users = demoDataset(1).tables[0]?.info as TableInfo;
const rows = (demoDataset(1).tables[0]?.rows ?? []).slice(0, 5);
const page: Page = { rows, total: 5, hasMore: false, revision: 1 };

function memory(): ClipboardIO & { text: string } {
  const io = { text: "" };
  return {
    get text() {
      return io.text;
    },
    set text(v: string) {
      io.text = v;
    },
    write: async (t) => {
      io.text = t;
    },
    read: async () => io.text,
  };
}

function Harness({ clip }: { clip: ClipboardIO }) {
  const [draft, setDraft] = useState<TableDraft>(EMPTY_DRAFT);
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <DataGrid
        table={users}
        page={page}
        changed={new Set()}
        columns={layoutColumns(users.columns, EMPTY_LAYOUT).visible}
        sort={[]}
        onSort={() => {}}
        onResize={() => {}}
        clipboard={clip}
        editing={{
          draft,
          conflicts: new Set(),
          selectedRows: new Set(),
          onToggleRow: () => {},
          onToggleAll: () => {},
          onEditExisting: (rowId, key, column, value, original) =>
            setDraft((d) => setCell(d, rowId, key, column, value, original)),
          onEditNew: (id, column, value) => setDraft((d) => setNewCell(d, id, column, value)),
          onRemoveNew: () => {},
          onExpandRow: () => {},
          onFocusRow: () => {},
        }}
      />
    </>
  );
}

describe("clipboard", () => {
  test("copy writes TSV of the rectangle; paste applies it as pending edits", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    fireEvent.click(screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement);
    fireEvent.click(screen.getByText("User 2").closest("[role=gridcell]") as HTMLElement, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    await act(() => Promise.resolve());
    expect(clip.text).toBe("User 1\nUser 2");
    fireEvent.click(screen.getByText("User 3").closest("[role=gridcell]") as HTMLElement);
    await act(async () => {
      clip.text = "From TSV\nAlso";
      fireEvent.keyDown(screen.getByRole("grid"), { key: "v", metaKey: true });
      await Promise.resolve();
    });
    const draft = JSON.parse(screen.getByTestId("draft").textContent ?? "");
    const names = Object.values(draft.updates as Record<string, { cells: Record<string, { value: unknown }> }>).map(
      (u) => u.cells["name"]?.value,
    );
    expect(names).toContain("From TSV");
    expect(names).toContain("Also");
  });

  test("an unparsable paste cell is skipped; a valid neighbour still applies", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    fireEvent.click(screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement);
    await act(async () => {
      // One row, two columns: name (text) then role (enum). Tab, not newline.
      clip.text = "Pasted\tnot-a-role";
      fireEvent.keyDown(screen.getByRole("grid"), { key: "v", metaKey: true });
      await Promise.resolve();
    });
    const draft = JSON.parse(screen.getByTestId("draft").textContent ?? "");
    const cells = Object.values(draft.updates as Record<string, { cells: Record<string, { value: unknown }> }>)[0]
      ?.cells;
    expect(cells?.["name"]?.value).toBe("Pasted");
    expect(cells?.["role"]).toBeUndefined();
  });

  test("the context menu copies the same TSV as ⌘C", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    const name = screen.getByText("User 1").closest("[role=gridcell]") as HTMLElement;
    fireEvent.contextMenu(name);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
      await Promise.resolve();
    });
    expect(clip.text).toBe("User 1");
  });

  test("copy writes wire text for a boolean, not TRUE", async () => {
    const clip = memory();
    render(<Harness clip={clip} />);
    const row = screen.getByText("User 1").closest("[role=row]") as HTMLElement;
    const active = [...row.querySelectorAll("[role=gridcell]")].find((el) => el.textContent === "TRUE");
    fireEvent.click(active as HTMLElement);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    await act(() => Promise.resolve());
    expect(clip.text).toBe("true");
  });
});
