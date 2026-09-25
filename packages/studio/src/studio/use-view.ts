import { useCallback, useState } from "react";
import { EMPTY_VIEW, type StudioView, sameView, type ViewChange } from "../view";

/**
 * The view, controlled by a host (`controlled` + `onViewChange`, e.g. bound to its URL) or kept here. A change equal
 * to the current view is not reported, so a host that re-renders with an equal object cannot loop.
 */
export function useControllableView(
  controlled: StudioView | undefined,
  defaultView: StudioView | undefined,
  onViewChange: ((view: StudioView, change: ViewChange) => void) | undefined,
): [StudioView, (next: StudioView, change: ViewChange) => void] {
  const [inner, setInner] = useState<StudioView>(defaultView ?? EMPTY_VIEW);
  const current = controlled ?? inner;
  const setView = useCallback(
    (next: StudioView, change: ViewChange) => {
      if (sameView(next, current)) return;
      if (controlled === undefined) setInner(next);
      onViewChange?.(next, change);
    },
    [controlled, current, onViewChange],
  );
  return [current, setView];
}
