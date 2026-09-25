import { type ComponentType, createContext, useContext, useEffect, useState } from "react";

export type CodeEditorMode = "codemirror" | "textarea";

/** The studio provides "codemirror"; anything rendered outside it stays a textarea. */
export const CodeEditorContext = createContext<CodeEditorMode>("textarea");

export interface CodeEditorProps {
  label: string;
  value: string;
  onChange(text: string): void;
  onBlur?(): void;
  /** Cmd/Ctrl+Enter. */
  onSubmit?(): void;
  invalid?: boolean;
  className?: string;
}

let loaded: ComponentType<CodeEditorProps> | null = null;

const TEXTAREA =
  "h-64 w-full resize-y rounded-lg border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring aria-invalid:border-destructive";

/** Multi-line code (json, arrays). CodeMirror is its own chunk: fetched the first time one is shown, never before. */
export function CodeEditor(props: CodeEditorProps) {
  const mode = useContext(CodeEditorContext);
  const [Editor, setEditor] = useState<ComponentType<CodeEditorProps> | null>(() =>
    mode === "codemirror" ? loaded : null,
  );
  useEffect(() => {
    if (mode !== "codemirror" || Editor) return;
    let live = true;
    import("./codemirror").then(
      (m) => {
        loaded = m.CodeMirrorEditor;
        if (live) setEditor(() => m.CodeMirrorEditor);
      },
      // A chunk that cannot load (offline, a CSP) leaves the textarea, which edits the same text.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [mode, Editor]);
  if (Editor) return <Editor {...props} />;
  return (
    <textarea
      aria-label={props.label}
      className={props.className ? `${TEXTAREA} ${props.className}` : TEXTAREA}
      value={props.value}
      aria-invalid={props.invalid || undefined}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") props.onSubmit?.();
      }}
    />
  );
}
