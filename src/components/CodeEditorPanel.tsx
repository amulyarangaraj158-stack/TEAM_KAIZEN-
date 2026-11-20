import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';

export interface InlineMarker {
  lineNumber: number;
  column?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

interface CodeEditorPanelProps {
  value: string;
  language: string;
  onChange?: (val: string) => void;
  readOnly?: boolean;
  height?: string;
  markers?: InlineMarker[];
  highlightLine?: number | null;
}

export const CodeEditorPanel: React.FC<CodeEditorPanelProps> = ({
  value,
  language,
  onChange,
  readOnly = false,
  height = '460px',
  markers = [],
  highlightLine = null,
}) => {
  const [monacoReady, setMonacoReady] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!monacoReady) setUseFallback(true);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [monacoReady]);

  const applyMarkers = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    try {
      const model = editor.getModel();
      if (!model || model.isDisposed()) return;

      const monacoMarkers = markers.map((m) => ({
        startLineNumber: Math.max(1, m.lineNumber),
        startColumn: Math.max(1, m.column ?? 1),
        endLineNumber: Math.max(1, m.lineNumber),
        endColumn: Math.max(2, model.getLineMaxColumn(Math.min(m.lineNumber, model.getLineCount()))),
        message: m.message,
        severity:
          m.severity === 'critical' || m.severity === 'high'
            ? monaco.MarkerSeverity.Error
            : m.severity === 'medium'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      }));
      monaco.editor.setModelMarkers(model, 'autopatch', monacoMarkers);
    } catch {
      // ignore transient model disposal during rapid file switches
    }
  };

  useEffect(() => {
    if (monacoReady) applyMarkers();
  }, [markers, monacoReady, value]);

  useEffect(() => {
    if (monacoReady && highlightLine && editorRef.current) {
      try {
        editorRef.current.revealLineInCenter(highlightLine);
        editorRef.current.setPosition({ lineNumber: highlightLine, column: 1 });
      } catch {
        // ignore if editor is unmounting
      }
    }
  }, [highlightLine, monacoReady]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setMonacoReady(true);
    setUseFallback(false);

    monaco.editor.defineTheme('autopatch-cyber', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '64748B', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'A855F7' },
        { token: 'string', foreground: '39FF88' },
        { token: 'number', foreground: 'FFB020' },
        { token: 'type', foreground: '00F5FF' },
      ],
      colors: {
        'editor.background': '#0B1220',
        'editor.foreground': '#F1F5F9',
        'editor.lineHighlightBackground': '#142238',
        'editorLineNumber.foreground': '#475569',
        'editorLineNumber.activeForeground': '#00F5FF',
        'editor.selectionBackground': '#00F5FF33',
      },
    });
    monaco.editor.setTheme('autopatch-cyber');
    applyMarkers();
  };

  const markerMap = useMemo(() => {
    const map = new Map<number, InlineMarker>();
    for (const m of markers) map.set(m.lineNumber, m);
    return map;
  }, [markers]);

  if (useFallback) {
    const lines = value.split(/\r?\n/);
    return (
      <div
        className="w-full overflow-auto rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] font-mono text-xs"
        style={{ height }}
      >
        {readOnly ? (
          <div className="p-3 space-y-0.5">
            {lines.map((line, i) => {
              const ln = i + 1;
              const marker = markerMap.get(ln);
              const isHighlighted = highlightLine === ln;
              return (
                <div
                  key={ln}
                  className={`flex items-start gap-3 px-2 py-0.5 rounded ${
                    marker
                      ? 'bg-[#FF3864]/15'
                      : isHighlighted
                        ? 'bg-[#00F5FF]/12'
                        : 'hover:bg-[#142238]/60'
                  }`}
                >
                  <span className="w-8 shrink-0 select-none text-right text-[#64748B] tabular-nums">{ln}</span>
                  <span className="whitespace-pre text-[#F1F5F9] flex-1">{line || ' '}</span>
                  {marker && (
                    <span className="text-[11px] text-[#FF3864] shrink-0 max-w-xs truncate" title={marker.message}>
                      {marker.message}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <textarea
            aria-label="Code editor"
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-[#0B1220] p-4 font-mono text-xs leading-6 text-[#F1F5F9] focus:outline-none"
          />
        )}
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-lg border border-[#00F5FF]/15 bg-[#0B1220]" style={{ height }}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme="vs-dark"
        onMount={handleMount}
        onChange={(v) => onChange?.(v ?? '')}
        options={{
          readOnly,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: 'all',
        }}
      />
    </div>
  );
};

interface CodeDiffPanelProps {
  original: string;
  modified: string;
  language: string;
  height?: string;
}

export const CodeDiffPanel: React.FC<CodeDiffPanelProps> = ({
  original,
  modified,
  language,
  height = '400px',
}) => {
  const [monacoReady, setMonacoReady] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const diffEditorRef = useRef<{
    getModel: () => { original?: { dispose: () => void; isDisposed: () => boolean }; modified?: { dispose: () => void; isDisposed: () => boolean } } | null;
    setModel: (model: null) => void;
  } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!monacoReady) setUseFallback(true);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [monacoReady]);

  // Dispose diff models strictly AFTER DiffEditorWidget detaches/disposes to avoid
  // Monaco 0.55 "TextModel got disposed before DiffEditorWidget model got reset" error.
  useEffect(() => {
    return () => {
      const editor = diffEditorRef.current;
      diffEditorRef.current = null;
      if (!editor) return;
      try {
        const model = editor.getModel();
        editor.setModel(null);
        window.setTimeout(() => {
          try {
            if (model?.original && !model.original.isDisposed()) model.original.dispose();
            if (model?.modified && !model.modified.isDisposed()) model.modified.dispose();
          } catch {
            // already disposed
          }
        }, 0);
      } catch {
        // ignore if already disposed
      }
    };
  }, []);

  if (useFallback) {
    const origLines = original.split(/\r?\n/);
    const modLines = modified.split(/\r?\n/);
    const maxLen = Math.max(origLines.length, modLines.length);
    return (
      <div
        className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#00F5FF]/15 overflow-auto rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] font-mono text-xs"
        style={{ height }}
      >
        <div className="p-3">
          <div className="mb-2 text-[11px] font-semibold text-[#FF3864]">Original Code</div>
          {Array.from({ length: maxLen }).map((_, i) => {
            const changed = (origLines[i] ?? '') !== (modLines[i] ?? '');
            return (
              <div key={i} className={`flex gap-2 px-1.5 py-0.5 ${changed ? 'bg-[#FF3864]/15 text-[#F1F5F9]' : 'text-[#94A3B8]'}`}>
                <span className="w-7 text-right text-[#64748B] select-none tabular-nums">{i + 1}</span>
                <span className="whitespace-pre-wrap break-all">{origLines[i] ?? ''}</span>
              </div>
            );
          })}
        </div>
        <div className="p-3">
          <div className="mb-2 text-[11px] font-semibold text-[#39FF88]">Proposed / Approved Code</div>
          {Array.from({ length: maxLen }).map((_, i) => {
            const changed = (origLines[i] ?? '') !== (modLines[i] ?? '');
            return (
              <div key={i} className={`flex gap-2 px-1.5 py-0.5 ${changed ? 'bg-[#39FF88]/12 text-[#F1F5F9]' : 'text-[#94A3B8]'}`}>
                <span className="w-7 text-right text-[#64748B] select-none tabular-nums">{i + 1}</span>
                <span className="whitespace-pre-wrap break-all">{modLines[i] ?? ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-lg border border-[#00F5FF]/15 bg-[#0B1220]" style={{ height }}>
      <DiffEditor
        height={height}
        language={language}
        original={original}
        modified={modified}
        theme="vs-dark"
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(editor) => {
          diffEditorRef.current = editor as unknown as typeof diffEditorRef.current;
          setMonacoReady(true);
          setUseFallback(false);
        }}
        options={{
          readOnly: true,
          renderSideBySide: true,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12.5,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
};
