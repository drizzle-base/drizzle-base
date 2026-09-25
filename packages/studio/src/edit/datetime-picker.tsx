import type { MouseEvent } from "react";
import { cn } from "../lib/cn";
import {
  browserOffset,
  formatPgTime,
  type PgTime,
  parsePgTime,
  type Shortcut,
  shortcut,
  type TimeKind,
  withDay,
  withTime,
} from "../lib/pgtime";
import { Calendar } from "../ui/calendar";

export interface DateTimePickerProps {
  kind: TimeKind;
  /** The text being edited; what does not parse is replaced by today when a part is picked. */
  text: string;
  nullable: boolean;
  now?: () => Date;
  /** null: NULL. */
  onPick(text: string | null): void;
}

const SHORTCUTS: Shortcut[] = ["now", "today", "tomorrow", "yesterday"];
const ITEM =
  "h-7 rounded-md px-2 text-left font-mono text-xs hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground";
// A pick must not take focus from the editor's input: its blur would commit.
const keepFocus = (e: MouseEvent) => e.preventDefault();

function TimeColumn({
  label,
  count,
  value,
  onPick,
}: {
  label: string;
  count: number;
  value: number | null;
  onPick(n: number): void;
}) {
  return (
    <fieldset aria-label={label} className="m-0 flex h-72 min-w-0 flex-col overflow-y-auto border-0 border-l p-1">
      {Array.from({ length: count }, (_, n) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is the numbers 0…count-1
          key={n}
          type="button"
          aria-pressed={n === value}
          onMouseDown={keepFocus}
          onClick={() => onPick(n)}
          className={cn(ITEM, "shrink-0 text-center")}
        >
          {String(n).padStart(2, "0")}
        </button>
      ))}
    </fieldset>
  );
}

/** Shortcuts, a month and (timestamps) hour/minute/second. Every pick changes only the part picked. */
export function DateTimePicker({ kind, text, nullable, now = () => new Date(), onPick }: DateTimePickerProps) {
  const current = parsePgTime(kind, text);
  const base = (): PgTime => current ?? shortcut(kind, "today", now(), browserOffset(now()));
  const pick = (t: PgTime) => onPick(formatPgTime(t));
  // The calendar's Date is a local calendar day: only its year, month and day are read, never its instant.
  const selected = current ? new Date(current.year, current.month - 1, current.day) : undefined;
  return (
    <div className="flex">
      <div className="flex min-w-24 flex-col gap-0.5 border-r p-1.5">
        {nullable && (
          <button type="button" className={ITEM} onMouseDown={keepFocus} onClick={() => onPick(null)}>
            NULL
          </button>
        )}
        {SHORTCUTS.map((s) => (
          <button
            key={s}
            type="button"
            className={ITEM}
            onMouseDown={keepFocus}
            onClick={() => pick(shortcut(kind, s, now(), browserOffset(now())))}
          >
            {s}
          </button>
        ))}
      </div>
      <fieldset aria-label="Pick a date" className="m-0 min-w-0 border-0 p-0" onMouseDown={keepFocus}>
        <Calendar
          mode="single"
          // Keyed by month: the calendar shows the month of what is typed, not the one it opened on.
          key={current ? `${current.year}-${current.month}` : "today"}
          defaultMonth={selected}
          selected={selected}
          onSelect={(d) => {
            if (d) pick(withDay(base(), d.getFullYear(), d.getMonth() + 1, d.getDate()));
          }}
        />
      </fieldset>
      {kind !== "date" && (
        <>
          <TimeColumn
            label="Hour"
            count={24}
            value={current?.hour ?? null}
            onPick={(n) => pick(withTime(base(), "hour", n))}
          />
          <TimeColumn
            label="Minute"
            count={60}
            value={current?.minute ?? null}
            onPick={(n) => pick(withTime(base(), "minute", n))}
          />
          <TimeColumn
            label="Second"
            count={60}
            value={current?.second ?? null}
            onPick={(n) => pick(withTime(base(), "second", n))}
          />
        </>
      )}
    </div>
  );
}
