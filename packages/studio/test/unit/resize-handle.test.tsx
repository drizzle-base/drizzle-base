import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResizeHandle } from "../../src/grid/resize-handle";

test("unmount during a drag drops the window listeners: later pointermove does not call onResize and does not throw", () => {
  const calls: [number, boolean][] = [];
  const { unmount } = render(
    <ResizeHandle name="label" width={200} onResize={(w, commit) => calls.push([w, commit])} />,
  );
  fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize label" }), { clientX: 100 });
  expect(calls).toEqual([]);
  unmount();
  expect(() => fireEvent.pointerMove(window, { clientX: 150 })).not.toThrow();
  expect(() => fireEvent.pointerUp(window, { clientX: 160 })).not.toThrow();
  expect(calls).toEqual([]);
});
