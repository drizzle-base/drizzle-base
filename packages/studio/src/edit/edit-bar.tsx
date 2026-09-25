import { formatCell } from "../studio/format";
import { Button } from "../ui/button";
import type { Conflict } from "./draft";

export interface SaveError {
  message: string;
  /** The row the failure is about (a conflict), when the data source says. */
  rowId: string | null;
}

export interface EditBarProps {
  changes: number;
  missing: number;
  conflicts: Conflict[];
  error: SaveError | null;
  saving: boolean;
  onSave(): void;
  onDiscard(): void;
  onResolve(conflict: Conflict, choice: "mine" | "theirs"): void;
  onDiscardRow(rowId: string): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function EditBar(p: EditBarProps) {
  const blocked = p.saving || p.missing > 0 || p.conflicts.length > 0;
  return (
    <section aria-label="Unsaved changes" className="flex flex-col gap-1 border-b bg-edit/50 px-3 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-medium text-edit-foreground">
          {plural(p.changes, "unsaved change", "unsaved changes")}
        </span>
        {p.missing > 0 && (
          <span className="text-destructive">
            {plural(p.missing, "required value missing", "required values missing")}
          </span>
        )}
        {p.conflicts.length > 0 && (
          <span className="text-destructive">{plural(p.conflicts.length, "conflict", "conflicts")} to resolve</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={p.onDiscard}>
            Discard changes
          </Button>
          <Button type="button" size="xs" disabled={blocked} onClick={p.onSave}>
            {p.saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
      {p.conflicts.map((c) => (
        <div key={`${c.rowId}:${c.column}`} className="flex items-center gap-2">
          <span>
            “{c.column}” changed elsewhere to <code>{formatCell(c.theirs)}</code> — yours:{" "}
            <code>{formatCell(c.mine)}</code>
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => p.onResolve(c, "mine")}>
            Keep mine
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => p.onResolve(c, "theirs")}>
            Use theirs
          </Button>
        </div>
      ))}
      {p.error && (
        <div role="alert" className="flex items-center gap-2 text-destructive">
          <span>Not saved: {p.error.message}. Nothing was written.</span>
          {p.error.rowId !== null && (
            <Button type="button" size="xs" variant="link" onClick={() => p.onDiscardRow(p.error?.rowId ?? "")}>
              Discard this row's edits
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
