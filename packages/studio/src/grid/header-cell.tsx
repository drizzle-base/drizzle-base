import { ArrowDown, ArrowUp } from "lucide-react";
import type { ColumnInfo } from "../contract";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { HeaderSortAction } from "../view";
import { ResizeHandle } from "./resize-handle";

export interface HeaderCellProps {
  index: number;
  column: ColumnInfo;
  width: number;
  sorted: { dir: "asc" | "desc"; position: number } | null;
  onSort(action: HeaderSortAction): void;
  onResize(width: number, commit: boolean): void;
}

export function HeaderCell({ index, column, width, sorted, onSort, onResize }: HeaderCellProps) {
  const Arrow = sorted?.dir === "desc" ? ArrowDown : ArrowUp;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtualised grid positions rows absolutely; <table> layout cannot
    <div
      role="columnheader"
      tabIndex={-1}
      aria-colindex={index + 1}
      aria-sort={sorted ? (sorted.dir === "asc" ? "ascending" : "descending") : undefined}
      className="relative flex h-8 shrink-0 items-center border-r"
      style={{ width }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted">
          <span className="truncate font-semibold">{column.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">{column.pgType}</span>
          {sorted && (
            <span aria-hidden="true" className="ml-auto flex shrink-0 items-center text-muted-foreground">
              <Arrow className="size-3.5" />
              {sorted.position > 0 && <span className="text-[10px]">{sorted.position}</span>}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => onSort("asc")}>Sort ascending</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort("desc")}>Sort descending</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort("add")}>Add to sort</DropdownMenuItem>
          {sorted && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSort("clear")}>Clear sort</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ResizeHandle name={column.name} width={width} onResize={onResize} />
    </div>
  );
}
