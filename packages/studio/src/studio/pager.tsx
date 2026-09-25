import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";

export interface PagerProps {
  offset: number;
  limit: number;
  shown: number;
  total: number | null;
  onOffsetChange(offset: number): void;
}

export function Pager({ offset, limit, shown, total, onOffsetChange }: PagerProps) {
  const of = total ?? "?";
  const label = shown === 0 ? `0 of ${of}` : `${offset + 1} - ${offset + shown} of ${of}`;
  const hasNext = total === null ? shown === limit : offset + limit < total;
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Previous page"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft />
      </Button>
      <span className="px-2 text-sm tabular-nums">{label}</span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Next page"
        disabled={!hasNext}
        onClick={() => onOffsetChange(offset + limit)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
