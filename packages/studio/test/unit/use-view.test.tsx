import { expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useControllableView } from "../../src/studio/use-view";
import { EMPTY_VIEW, type StudioView, type ViewChange } from "../../src/view";

const users: StudioView = { ...EMPTY_VIEW, table: "public.users" };

test("uncontrolled: the hook keeps the view and still reports changes", () => {
  const seen: [StudioView, ViewChange][] = [];
  const { result } = renderHook(() => useControllableView(undefined, EMPTY_VIEW, (v, c) => seen.push([v, c])));
  act(() => result.current[1](users, { history: "push" }));
  expect(result.current[0]).toEqual(users);
  expect(seen).toEqual([[users, { history: "push" }]]);
});

test("controlled: only the host's view counts, and an equal view is not reported", () => {
  const seen: StudioView[] = [];
  const { result, rerender } = renderHook(({ view }) => useControllableView(view, undefined, (v) => seen.push(v)), {
    initialProps: { view: EMPTY_VIEW },
  });
  act(() => result.current[1](users, { history: "push" }));
  expect(result.current[0]).toEqual(EMPTY_VIEW);
  rerender({ view: users });
  act(() => result.current[1]({ ...users }, { history: "replace" }));
  expect(seen).toEqual([users]);
});
