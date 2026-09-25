import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { MIN_WIDTH } from "../studio/prefs";

export interface ResizeHandleProps {
  name: string;
  width: number;
  /** `commit` is false while dragging (render only) and true when the width should be saved. */
  onResize(width: number, commit: boolean): void;
}

const STEP = 16;

export function ResizeHandle({ name, width, onResize }: ResizeHandleProps) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const at = (x: number) => Math.max(MIN_WIDTH, Math.round(width + x - startX));
    const move = (ev: PointerEvent) => onResize(at(ev.clientX), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResize(at(ev.clientX), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onResize(Math.max(MIN_WIDTH, width + (e.key === "ArrowRight" ? STEP : -STEP)), true);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator has no native element
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${name}`}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-ring/60 focus-visible:bg-ring"
    />
  );
}
