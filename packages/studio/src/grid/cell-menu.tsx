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
  const pointer = {
    getBoundingClientRect: () => ({
      x,
      y,
      top: y,
      left: x,
      right: x,
      bottom: y,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }),
  };
  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuContent align="start" side="bottom" className="min-w-40" anchor={pointer}>
        <DropdownMenuItem onClick={onCopy}>Copy</DropdownMenuItem>
        <DropdownMenuItem onClick={onPaste}>Paste</DropdownMenuItem>
        {onExpand && <DropdownMenuItem onClick={onExpand}>Expand Row</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => onExport("json")}>Export JSON</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("csv")}>Export CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("sql")}>Export SQL</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
