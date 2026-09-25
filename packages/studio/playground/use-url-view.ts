import { useCallback, useEffect, useState } from "react";
import { decodeView, encodeView, type StudioView, VIEW_PARAM_KEYS, type ViewChange } from "../src";

// The playground's binding of the studio's view to the address bar. A host app does the same with its router;
// the studio itself never touches the URL. Other query parameters (e.g. ?latency) are kept.
export function useUrlView(): {
  view: StudioView;
  notices: string[];
  onViewChange(view: StudioView, change: ViewChange): void;
} {
  const [state, setState] = useState(() => decodeView(location.search));
  useEffect(() => {
    const onPop = () => setState(decodeView(location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const onViewChange = useCallback((view: StudioView, change: ViewChange) => {
    const params = new URLSearchParams(location.search);
    for (const key of VIEW_PARAM_KEYS) params.delete(key);
    for (const [key, value] of new URLSearchParams(encodeView(view))) params.append(key, value);
    const query = params.toString();
    const url = `${location.pathname}${query ? `?${query}` : ""}`;
    if (change.history === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    setState({ view, errors: [] });
  }, []);
  return { view: state.view, notices: state.errors, onViewChange };
}
