import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";

export function CellMenu({
  x,
  y,
  onCopy,
  onPaste,
  onExpand,
  onExport,
  onClose,
}: {
  x: number;
  y: number;
  onCopy(): void;
  onPaste(): void;
  onExpand?: () => void;
  onExport(kind: "json" | "csv" | "sql"): void;
  onClose(): void;
}) {
  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()}>
      {/* Base UI's Positioner ignores left/top on the popup; this 0×0 box is the anchor. */}
      <div className="pointer-events-none fixed z-50 size-0" style={{ left: x, top: y }}>
        <DropdownMenuContent align="start" className="min-w-40">
          <DropdownMenuItem onClick={onCopy}>Copy</DropdownMenuItem>
          <DropdownMenuItem onClick={onPaste}>Paste</DropdownMenuItem>
          {onExpand && <DropdownMenuItem onClick={onExpand}>Expand Row</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => onExport("json")}>Export JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport("csv")}>Export CSV</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport("sql")}>Export SQL</DropdownMenuItem>
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  );
}
