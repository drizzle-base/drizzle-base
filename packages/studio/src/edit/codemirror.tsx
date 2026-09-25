import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { CodeEditorProps } from "./code-editor";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  "&.cm-focused": { outline: "none" },
});

export function CodeMirrorEditor({ label, value, onChange, onBlur, onSubmit, invalid, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur, onSubmit });
  handlers.current = { onChange, onBlur, onSubmit };

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; later values arrive through the effect below
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle),
          json(),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                handlers.current.onSubmit?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
          ]),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              handlers.current.onBlur?.();
              return false;
            },
          }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  // A value set from outside (Format, a push while not editing) replaces the document; typing does not loop back.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      data-invalid={invalid || undefined}
      className={`h-64 w-full overflow-hidden rounded-lg border border-input data-invalid:border-destructive ${className ?? ""}`}
    />
  );
}
