import { expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CodeEditor } from "../../src/edit/code-editor";

test("outside a studio it is a plain textarea, and stays one", async () => {
  let text = "";
  render(<CodeEditor label="Value of profile" value="{}" onChange={(t) => (text = t)} />);
  await act(() => new Promise((r) => setTimeout(r, 300)));
  const area = screen.getByLabelText("Value of profile");
  expect(area.tagName).toBe("TEXTAREA");
  fireEvent.change(area, { target: { value: '{"a":1}' } });
  expect(text).toBe('{"a":1}');
});

test("in codemirror mode the textarea works until the editor has loaded, then CodeMirror replaces it", async () => {
  // A fresh module instance: earlier files rendering <Studio> have already filled the shared one's cache.
  const fresh = "../../src/edit/code-editor.tsx?unloaded";
  const { CodeEditor, CodeEditorContext }: typeof import("../../src/edit/code-editor") = await import(fresh);
  render(
    <CodeEditorContext value="codemirror">
      <CodeEditor label="Value of profile" value='{"a":1}' onChange={() => {}} />
    </CodeEditorContext>,
  );
  expect(screen.getByLabelText("Value of profile").tagName).toBe("TEXTAREA");
  await act(() => new Promise((r) => setTimeout(r, 300)));
  const content = screen.getByLabelText("Value of profile");
  expect(content.classList.contains("cm-content")).toBe(true);
  expect(content.textContent).toContain('"a"');
});
