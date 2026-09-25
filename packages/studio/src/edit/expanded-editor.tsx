import { useState } from "react";
import type { CellValue, ColumnInfo } from "../contract";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { CodeEditor } from "./code-editor";
import { parseCellValue, textForEditing } from "./values";

export interface ExpandedEditorProps {
  column: ColumnInfo;
  value: CellValue | undefined;
  isNew: boolean;
  /** undefined: back to DEFAULT (new rows only). */
  onSave(value: CellValue | undefined): void;
  onClose(): void;
}

export function ExpandedEditor({ column, value, isNew, onSave, onClose }: ExpandedEditorProps) {
  const [text, setText] = useState(value === undefined || value === null ? "" : textForEditing(column, value));
  const parsed = parseCellValue(column, text);
  const save = () => {
    if (parsed.ok) onSave(parsed.value ?? null);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>
          {column.name} <span className="font-mono text-xs text-muted-foreground">{column.pgType}</span>
        </DialogTitle>
        <CodeEditor
          label={`Value of ${column.name}`}
          value={text}
          onChange={setText}
          onSubmit={save}
          invalid={!parsed.ok}
        />
        {!parsed.ok && (
          <p role="alert" className="text-xs text-destructive">
            {parsed.error}
          </p>
        )}
        <DialogFooter>
          {column.nullable && (
            <Button type="button" variant="outline" onClick={() => onSave(null)}>
              Set NULL
            </Button>
          )}
          {isNew && column.hasDefault && (
            <Button type="button" variant="outline" onClick={() => onSave(undefined)}>
              Use DEFAULT
            </Button>
          )}
          {column.kind === "json" && parsed.ok && (
            <Button type="button" variant="ghost" onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}>
              Format
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!parsed.ok} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
