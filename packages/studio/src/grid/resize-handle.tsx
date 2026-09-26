import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { MIN_WIDTH } from "../studio/prefs";

export interface ResizeHandleProps {
  name: string;
  width: number;
  /** `commit` is false while dragging (render only) and true when the width should be saved. */
  onResize(width: number, commit: boolean): void;
  /** Left: dragging left widens (a panel docked on the right). Default right. */
  edge?: "right" | "left";
}

const STEP = 16;

export function ResizeHandle({ name, width, onResize, edge = "right" }: ResizeHandleProps) {
  const moveRef = useRef<(ev: PointerEvent) => void>(() => {});
  const upRef = useRef<(ev: PointerEvent) => void>(() => {});
  // Listeners are on window so a drag can leave the handle; they must come off on unmount
  // or a later move calls onResize of a dead column.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", moveRef.current);
      window.removeEventListener("pointerup", upRef.current);
    };
  }, []);
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const at = (x: number) =>
      Math.max(MIN_WIDTH, Math.round(edge === "left" ? width - (x - startX) : width + x - startX));
    const move = (ev: PointerEvent) => onResize(at(ev.clientX), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResize(at(ev.clientX), true);
    };
    moveRef.current = move;
    upRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const widen = edge === "left" ? e.key === "ArrowLeft" : e.key === "ArrowRight";
    onResize(Math.max(MIN_WIDTH, width + (widen ? STEP : -STEP)), true);
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
      className={`absolute top-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-ring/60 focus-visible:bg-ring ${edge === "left" ? "left-0" : "right-0"}`}
    />
  );
}
