import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { CellValue, TableInfo } from "../../src/contract";
import { CellEditor } from "../../src/edit/cell-editor";
import { DateTimePicker } from "../../src/edit/datetime-picker";
import { EMPTY_DRAFT, setCell, type TableDraft } from "../../src/edit/draft";
import { RowPanel } from "../../src/edit/row-panel";
import { col } from "../../src/mock";

const TSTZ = col("created_at", "timestamptz", "timestamp with time zone", { nullable: false });
const NOW = () => new Date(Date.UTC(2026, 8, 25, 15, 0, 0));

function Picker({
  start,
  kind = "timestamptz",
  nullable = false,
}: {
  start: string;
  kind?: "date" | "timestamptz";
  nullable?: boolean;
}) {
  const [text, setText] = useState<string | null>(start);
  return (
    <>
      <output data-testid="text">{String(text)}</output>
      <DateTimePicker kind={kind} text={text ?? ""} nullable={nullable} now={NOW} onPick={setText} />
    </>
  );
}
const text = () => screen.getByTestId("text").textContent;
const calendar = () => screen.getByRole("group", { name: "Pick a date" });
// The day buttons of the month shown (react-day-picker also renders the outside days of the weeks around it).
const day = (n: number) =>
  within(calendar())
    .getAllByRole("button")
    .find((b) => b.textContent === String(n) && !b.closest("[data-outside]")) as HTMLElement;
const selectedDay = () => calendar().querySelector("[aria-selected=true]")?.textContent;
const hour = (h: string) => within(screen.getByRole("group", { name: "Hour" })).getByRole("button", { name: h });

describe("the date/time picker", () => {
  test("picking a day on a timestamptz keeps its time, fraction and offset", () => {
    render(<Picker start="2026-09-25 12:43:35.257072+00" />);
    fireEvent.click(day(10));
    expect(text()).toBe("2026-09-10 12:43:35.257072+00");
  });

  test("picking a day in year 0099 keeps the century (Date years 0–99 are not 1900–1999)", () => {
    render(<Picker start="0099-01-01" kind="date" />);
    fireEvent.click(day(10));
    expect(text()).toBe("0099-01-10");
  });

  test("picking an hour keeps everything else", () => {
    render(<Picker start="2026-09-25 12:43:35.257072-03" />);
    fireEvent.click(hour("08"));
    expect(text()).toBe("2026-09-25 08:43:35.257072-03");
  });

  test("the current value is shown: its day selected, its hour pressed", () => {
    render(<Picker start="2026-09-25 12:43:35.257072+00" />);
    expect(selectedDay()).toBe("25");
    expect(hour("12").getAttribute("aria-pressed")).toBe("true");
  });

  test("shortcuts write concrete text; a date has no time columns; NULL only on nullable columns", () => {
    render(<Picker start="1980-02-07" kind="date" />);
    expect(screen.queryByRole("button", { name: "NULL" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "tomorrow" }));
    expect(text()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByRole("group", { name: "Hour" })).toBeNull();
  });

  test("NULL is offered on nullable columns and picks NULL", () => {
    render(<Picker start="2026-09-25 12:00:00+00" nullable />);
    fireEvent.click(screen.getByRole("button", { name: "NULL" }));
    expect(text()).toBe("null");
  });

  test("an empty or unparsable value starts from today", () => {
    render(<Picker start="" />);
    fireEvent.click(hour("08"));
    expect(text()).toMatch(/^\d{4}-\d{2}-\d{2} 08:00:00[+-]\d{2}(:\d{2})?$/);
  });
});

describe("the cell editor of a date/time column", () => {
  function Editor({ value }: { value: CellValue }) {
    const [out, setOut] = useState<string>("");
    return (
      <>
        <output data-testid="out">{out}</output>
        <CellEditor
          column={TSTZ}
          value={value}
          onCommit={(v) => setOut(`commit:${String(v)}`)}
          onCancel={() => setOut("cancel")}
        />
      </>
    );
  }
  const out = () => screen.getByTestId("out").textContent;

  test("opens the picker; a picked day goes to the input, Enter commits it", () => {
    render(<Editor value="2026-09-25 12:43:35.257072+00" />);
    const input = screen.getByLabelText("Edit created_at") as HTMLInputElement;
    fireEvent.mouseDown(day(10));
    fireEvent.click(day(10));
    expect(input.value).toBe("2026-09-10 12:43:35.257072+00");
    expect(out()).toBe("");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(out()).toBe("commit:2026-09-10 12:43:35.257072+00");
  });

  test("the calendar follows what is typed", () => {
    render(<Editor value="2026-09-25 12:43:35+00" />);
    fireEvent.change(screen.getByLabelText("Edit created_at"), { target: { value: "2025-01-15 10:20:30+02" } });
    expect(selectedDay()).toBe("15");
  });

  test("Esc cancels", () => {
    render(<Editor value="2026-09-25 12:43:35+00" />);
    fireEvent.keyDown(screen.getByLabelText("Edit created_at"), { key: "Escape" });
    expect(out()).toBe("cancel");
  });
});

describe("the date/time picker in the Expand Row panel", () => {
  const table: TableInfo = {
    schema: "public",
    name: "t",
    kind: "table",
    primaryKey: ["id"],
    estimatedRows: 1,
    columns: [
      col("id", "integer", "int", { isPrimaryKey: true, nullable: false }),
      col("created_at", "timestamptz", "timestamp with time zone", { nullable: false }),
    ],
  };
  const live = { id: 1, created_at: "2026-09-25 12:43:35.257072+00" };

  test("a picked day survives the field's blur", () => {
    function Harness() {
      const [draft, setDraft] = useState<TableDraft>(EMPTY_DRAFT);
      return (
        <RowPanel
          table={table}
          row={{ id: "1", isNew: false, key: { id: 1 }, live }}
          draft={draft}
          conflicts={new Set()}
          width={380}
          onResize={() => {}}
          onEditExisting={(rowId, key, column, value, original) =>
            setDraft((d) => setCell(d, rowId, key, column, value, original))
          }
          onEditNew={() => {}}
          onRevert={() => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("created_at") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Pick a date" }));
    fireEvent.focus(input);
    fireEvent.click(day(10));
    fireEvent.blur(input);
    expect(input.value).toBe("2026-09-10 12:43:35.257072+00");
  });
});
