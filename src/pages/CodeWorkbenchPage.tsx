import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Code2,
  FileCode2,
  GitCompare,
  History,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { CircularGauge } from '../components/CircularGauge';
import { CodeDiffPanel, CodeEditorPanel, type InlineMarker } from '../components/CodeEditorPanel';

interface ProjectFile {
  id: string;
  relative_path: string;
  language: string;
  size_bytes: number;
  content: string;
  sha256: string;
}

interface ScoreFactor {
  name: string;
  impact: string;
  weight: number;
  detail: string;
}

interface SuggestedFix {
  id: string;
  bug_id: string;
  file_path: string;
  original_code: string;
  proposed_code: string;
  approved_code?: string | null;
  explanation: string;
  prevention_tips: string;
  relatedConcepts: string[];
  confidence_score: number;
  confidenceFactors: ScoreFactor[];
  confidence_explanation: string;
  risk_score: number;
  risk_level: 'Low' | 'Medium' | 'High' | 'Critical';
  riskFactors: ScoreFactor[];
  risk_explanation: string;
  validation_status: string;
  validation_details: string;
  status: string;
}

interface BugItem {
  id: string;
  file_id: string | null;
  file_path: string;
  line_number: number;
  column_number: number;
  language: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  error_message: string;
  root_cause: string;
  affected_code: string;
  status: string;
  source_tool: string;
  latestFix: SuggestedFix | null;
}

interface PatchSnapshot {
  id: string;
  bug_id: string | null;
  fix_id: string | null;
  file_path: string;
  original_content: string;
  patched_content: string;
  status: string;
  applied_by: string;
  applied_at: string;
  rolled_back_at: string | null;
}

function toMonacoLang(language: string): string {
  const m: Record<string, string> = {
    Python: 'python',
    JavaScript: 'javascript',
    TypeScript: 'typescript',
    Java: 'java',
    C: 'c',
    'C++': 'cpp',
    Go: 'go',
    Rust: 'rust',
    SQL: 'sql',
    HTML: 'html',
    CSS: 'css',
    JSON: 'json',
    PHP: 'php',
    'C#': 'csharp',
  };
  return m[language] ?? 'plaintext';
}

const SEV_COLOR: Record<string, string> = {
  critical: '#FF3864',
  high: '#A855F7',
  medium: '#FFB020',
  low: '#3B82F6',
};

const RISK_COLOR: Record<string, string> = {
  Critical: '#FF3864',
  High: '#A855F7',
  Medium: '#FFB020',
  Low: '#39FF88',
};

export const CodeWorkbenchPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { activeProjectId, refreshProjects, addToast } = useAppStore();

  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [snapshots, setSnapshots] = useState<PatchSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const [fileFilter, setFileFilter] = useState('');
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'editor' | 'diff' | 'snapshots'>('editor');
  const [generatingFix, setGeneratingFix] = useState(false);
  const [editableApprovedCode, setEditableApprovedCode] = useState('');
  const [applyingFix, setApplyingFix] = useState(false);

  // Rollback modal / conflict handling
  const [selectedSnapshot, setSelectedSnapshot] = useState<PatchSnapshot | null>(null);
  const [rollbackConflict, setRollbackConflict] = useState<{ snapshotId: string; message: string } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const loadWorkspace = useCallback(async () => {
    if (!activeProjectId) {
      setFiles([]);
      setBugs([]);
      setSnapshots([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [fRes, bRes, sRes] = await Promise.all([
        apiFetch<{ files: ProjectFile[] }>(`/api/projects/${activeProjectId}/files`),
        apiFetch<{ bugs: BugItem[] }>(`/api/projects/${activeProjectId}/bugs`),
        apiFetch<{ snapshots: PatchSnapshot[] }>(`/api/projects/${activeProjectId}/snapshots`),
      ]);
      setFiles(fRes.files);
      setBugs(bRes.bugs);
      setSnapshots(sRes.snapshots);

      const paramBugId = searchParams.get('bugId');
      const paramFile = searchParams.get('file');

      if (paramBugId) {
        const b = bRes.bugs.find((x) => x.id === paramBugId);
        if (b) {
          setSelectedBugId(b.id);
          const f = fRes.files.find((x) => x.relative_path === b.file_path);
          if (f) {
            setSelectedFileId(f.id);
            setEditorContent(f.content);
            setDirty(false);
          }
          return;
        }
      }

      if (paramFile) {
        const f = fRes.files.find((x) => x.relative_path === paramFile);
        if (f) {
          setSelectedFileId(f.id);
          setEditorContent(f.content);
          setDirty(false);
          return;
        }
      }

      setSelectedFileId((prev) => {
        const match = fRes.files.find((x) => x.id === prev) ?? fRes.files[0] ?? null;
        if (match) {
          setEditorContent(match.content);
          setDirty(false);
        }
        return match?.id ?? null;
      });
      setSelectedBugId((prev) => {
        const match = bRes.bugs.find((x) => x.id === prev) ?? bRes.bugs.find((x) => x.status === 'open') ?? bRes.bugs[0] ?? null;
        return match?.id ?? null;
      });
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to load workbench', message: err instanceof Error ? err.message : '' });
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, searchParams, addToast]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const selectedFile = useMemo(() => files.find((f) => f.id === selectedFileId) ?? null, [files, selectedFileId]);
  const selectedBug = useMemo(() => bugs.find((b) => b.id === selectedBugId) ?? null, [bugs, selectedBugId]);

  useEffect(() => {
    if (selectedBug?.latestFix) {
      setEditableApprovedCode(selectedBug.latestFix.approved_code || selectedBug.latestFix.proposed_code);
    } else {
      setEditableApprovedCode('');
    }
  }, [selectedBug]);

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) => f.relative_path.toLowerCase().includes(q) || f.content.toLowerCase().includes(q),
    );
  }, [files, fileFilter]);

  const fileMarkers: InlineMarker[] = useMemo(() => {
    if (!selectedFile) return [];
    return bugs
      .filter((b) => b.file_path === selectedFile.relative_path && b.status !== 'resolved')
      .map((b) => ({
        lineNumber: b.line_number,
        column: b.column_number,
        severity: b.severity,
        message: `[${b.severity.toUpperCase()}] ${b.title}: ${b.error_message}`,
      }));
  }, [bugs, selectedFile]);

  const handleSelectFile = (f: ProjectFile) => {
    setSelectedFileId(f.id);
    setEditorContent(f.content);
    setDirty(false);
    setViewMode('editor');
  };

  const handleSelectBug = (b: BugItem) => {
    setSelectedBugId(b.id);
    const f = files.find((x) => x.relative_path === b.file_path);
    if (f) {
      setSelectedFileId(f.id);
      setEditorContent(f.content);
      setDirty(false);
    }
  };

  const handleSaveFile = async () => {
    if (!activeProjectId || !selectedFile) return;
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${activeProjectId}/files/${selectedFile.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editorContent }),
      });
      setFiles((prev) => prev.map((f) => (f.id === selectedFile.id ? { ...f, content: editorContent } : f)));
      setDirty(false);
      addToast({ type: 'success', title: 'File saved', message: selectedFile.relative_path });
    } catch (err) {
      addToast({ type: 'error', title: 'Save failed', message: err instanceof Error ? err.message : '' });
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateFix = async () => {
    if (!selectedBug) return;
    setGeneratingFix(true);
    try {
      const res = await apiFetch<{ fix: SuggestedFix; rootCause: string }>(`/api/bugs/${selectedBug.id}/generate-fix`, {
        method: 'POST',
      });
      setBugs((prev) =>
        prev.map((b) =>
          b.id === selectedBug.id ? { ...b, root_cause: res.rootCause || b.root_cause, latestFix: res.fix } : b,
        ),
      );
      setEditableApprovedCode(res.fix.proposed_code);
      setViewMode('diff');
      addToast({
        type: 'success',
        title: 'AI patch generated',
        message: `Confidence ${res.fix.confidence_score}/100 · ${res.fix.risk_level} Risk. Inspect diff before approving.`,
      });
    } catch (err) {
      addToast({ type: 'error', title: 'AI patch generation failed', message: err instanceof Error ? err.message : '' });
    } finally {
      setGeneratingFix(false);
    }
  };

  const handleApproveAndApply = async () => {
    if (!selectedBug?.latestFix) return;
    setApplyingFix(true);
    try {
      const res = await apiFetch<{ applied: boolean; snapshotId: string; validation: { status: string; details: string } }>(
        `/api/fixes/${selectedBug.latestFix.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ approvedCode: editableApprovedCode || selectedBug.latestFix.proposed_code }),
        },
      );
      addToast({
        type: 'success',
        title: 'Patch approved & applied',
        message: `${res.validation.details} Snapshot ${res.snapshotId} archived.`,
      });
      await Promise.all([loadWorkspace(), refreshProjects()]);
      setViewMode('editor');
    } catch (err) {
      addToast({ type: 'error', title: 'Patch apply failed', message: err instanceof Error ? err.message : '' });
    } finally {
      setApplyingFix(false);
    }
  };

  const handleRejectFix = async () => {
    if (!selectedBug?.latestFix) return;
    try {
      await apiFetch(`/api/fixes/${selectedBug.latestFix.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Rejected by engineer in Code Workbench' }),
      });
      addToast({ type: 'info', title: 'Patch rejected', message: 'Recorded in Patch Audit Trail.' });
      await loadWorkspace();
    } catch (err) {
      addToast({ type: 'error', title: 'Reject failed', message: err instanceof Error ? err.message : '' });
    }
  };

  const handleRollback = async (snapshotId: string, force = false) => {
    setRollingBack(true);
    setRollbackConflict(null);
    try {
      await apiFetch(`/api/snapshots/${snapshotId}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      addToast({ type: 'warning', title: 'Rollback completed', message: 'Original code restored and audit trail preserved.' });
      setSelectedSnapshot(null);
      await Promise.all([loadWorkspace(), refreshProjects()]);
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      if (e.status === 409) {
        setRollbackConflict({ snapshotId, message: e.message });
      } else {
        addToast({ type: 'error', title: 'Rollback failed', message: e.message });
      }
    } finally {
      setRollingBack(false);
    }
  };

  if (!activeProjectId) {
    return (
      <div className="cyber-panel rounded-xl p-10 text-center text-sm text-[#94A3B8]">
        Select or create a project to open the Code Workbench.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#F1F5F9]">Code Workbench</h1>
          <p className="text-xs text-[#94A3B8]">
            Inspect source files, inline bug markers, AI confidence & risk scores, Monaco diffs, explicit patch approval, and one-click rollback snapshots.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] p-1 self-start">
          <button
            type="button"
            onClick={() => setViewMode('editor')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === 'editor' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            <Code2 className="h-3.5 w-3.5 shrink-0" />
            Editor
          </button>
          <button
            type="button"
            onClick={() => setViewMode('diff')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === 'diff' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            <GitCompare className="h-3.5 w-3.5 shrink-0" />
            Patch Diff
          </button>
          <button
            type="button"
            onClick={() => setViewMode('snapshots')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              viewMode === 'snapshots' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            <History className="h-3.5 w-3.5 shrink-0" />
            Snapshots ({snapshots.length})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="cyber-panel rounded-xl p-12 text-center text-sm text-[#94A3B8]">Loading workspace files and diagnostics...</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          {/* Left Column: File Explorer + Detected Bugs List */}
          <div className="xl:col-span-3 space-y-4">
            <section className="cyber-panel rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-[#F1F5F9]">File Explorer</h2>
                <span className="font-mono text-[11px] text-[#94A3B8] tabular-nums">{files.length} files</span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
                <input
                  type="search"
                  aria-label="Filter files and code"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder="Search files or code..."
                  className="w-full rounded-md border border-[#00F5FF]/15 bg-[#070B14] py-1.5 pl-8 pr-2.5 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
                />
              </div>
              <div className="max-h-52 overflow-y-auto space-y-1">
                {filteredFiles.map((f) => {
                  const openCount = bugs.filter((b) => b.file_path === f.relative_path && b.status !== 'resolved').length;
                  const active = f.id === selectedFileId;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => handleSelectFile(f)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        active ? 'bg-[#00F5FF]/14 text-[#00F5FF]' : 'text-[#94A3B8] hover:bg-[#142238] hover:text-[#F1F5F9]'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate font-mono">
                        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{f.relative_path}</span>
                      </span>
                      {openCount > 0 && (
                        <span className="font-mono text-[11px] font-semibold text-[#FF3864] tabular-nums shrink-0">
                          {openCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="cyber-panel rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-[#F1F5F9]">Detected Bugs</h2>
                <span className="font-mono text-[11px] text-[#94A3B8] tabular-nums">
                  {bugs.filter((b) => b.status === 'open').length} open / {bugs.length} total
                </span>
              </div>
              <div className="max-h-[380px] overflow-y-auto space-y-1.5">
                {bugs.length === 0 ? (
                  <div className="py-6 text-center text-xs text-[#94A3B8]">No bugs recorded for this project.</div>
                ) : (
                  bugs.map((b) => {
                    const active = b.id === selectedBugId;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => handleSelectBug(b)}
                        className={`w-full rounded-lg border p-2.5 text-left text-xs transition-colors ${
                          active
                            ? 'border-[#00F5FF]/50 bg-[#142238]'
                            : 'border-[#00F5FF]/10 bg-[#0B1220] hover:border-[#00F5FF]/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="font-mono text-[10px] font-semibold uppercase"
                            style={{ color: b.status === 'resolved' ? '#39FF88' : SEV_COLOR[b.severity] }}
                          >
                            {b.status === 'resolved' ? 'Resolved' : b.severity}
                          </span>
                          <span className="font-mono text-[10px] text-[#94A3B8] tabular-nums">L{b.line_number}</span>
                        </div>
                        <div className="mt-1 font-medium text-[#F1F5F9] line-clamp-2">{b.title}</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-[#94A3B8]">{b.file_path}</div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          {/* Center & Right Column: Editor / Diff / Snapshots + Bug & Patch Approval Panel */}
          <div className="xl:col-span-9 space-y-5">
            {viewMode === 'snapshots' ? (
              <section className="cyber-panel rounded-xl p-5 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-[#F1F5F9]">One-Click Rollback Snapshots</h2>
                  <p className="text-xs text-[#94A3B8]">
                    Every approved patch archives the original file and SHA-256 hash before modifying code. Conflicts are detected prior to restore.
                  </p>
                </div>

                {rollbackConflict && (
                  <div className="rounded-lg border border-[#FFB020]/50 bg-[#FFB020]/10 p-4 text-xs space-y-2.5">
                    <div className="flex items-center gap-2 font-semibold text-[#FFB020]">
                      <AlertTriangle className="h-4 w-4" />
                      File Conflict Detected Before Rollback
                    </div>
                    <p className="text-[#F1F5F9]">{rollbackConflict.message}</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={rollingBack}
                        onClick={() => handleRollback(rollbackConflict.snapshotId, true)}
                        className="rounded-md bg-[#FFB020] px-3 py-1.5 text-xs font-semibold text-[#070B14]"
                      >
                        Confirm Force Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => setRollbackConflict(null)}
                        className="rounded-md border border-[#94A3B8]/30 px-3 py-1.5 text-xs text-[#F1F5F9]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {snapshots.length === 0 ? (
                  <div className="py-10 text-center text-xs text-[#94A3B8]">
                    No patch snapshots yet. Approve and apply a patch to create a recoverable snapshot.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {snapshots.map((snap) => (
                      <div
                        key={snap.id}
                        className="rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"
                      >
                        <div className="space-y-1 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-[#F1F5F9]">{snap.file_path}</span>
                            <span className="text-[#94A3B8]">·</span>
                            <span
                              className={`font-mono text-[11px] ${
                                snap.status === 'applied' ? 'text-[#39FF88]' : 'text-[#FFB020]'
                              }`}
                            >
                              {snap.status === 'applied' ? 'Active Patch' : 'Rolled Back'}
                            </span>
                          </div>
                          <div className="text-[#94A3B8] font-mono text-[11px]">
                            Snapshot {snap.id} · Applied by {snap.applied_by} on {new Date(snap.applied_at).toLocaleString()}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setSelectedSnapshot(selectedSnapshot?.id === snap.id ? null : snap)}
                            className="rounded-lg border border-[#00F5FF]/25 px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
                          >
                            {selectedSnapshot?.id === snap.id ? 'Hide Diff' : 'Compare Diff'}
                          </button>
                          {snap.status === 'applied' && (
                            <button
                              type="button"
                              disabled={rollingBack}
                              onClick={() => handleRollback(snap.id, false)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#FFB020]/45 bg-[#FFB020]/10 px-3 py-1.5 text-xs font-semibold text-[#FFB020] hover:bg-[#FFB020]/20 disabled:opacity-50"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Roll Back Patch
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {selectedSnapshot && (
                  <div className="pt-2 space-y-2">
                    <div className="text-xs font-medium text-[#94A3B8]">
                      Comparing pre-patch original (left) vs patched version (right) for{' '}
                      <span className="font-mono text-[#00F5FF]">{selectedSnapshot.file_path}</span>
                    </div>
                    <CodeDiffPanel
                      original={selectedSnapshot.original_content}
                      modified={selectedSnapshot.patched_content}
                      language={toMonacoLang(
                        files.find((f) => f.relative_path === selectedSnapshot.file_path)?.language ?? 'TypeScript',
                      )}
                      height="340px"
                    />
                  </div>
                )}
              </section>
            ) : (
              <>
                {/* Main Editor or Diff Surface */}
                <section className="cyber-panel rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-[#F1F5F9]">
                        {selectedFile?.relative_path || 'No file selected'}
                      </span>
                      {selectedFile && (
                        <>
                          <span className="text-[#94A3B8]">·</span>
                          <span className="text-[#00F5FF]">{selectedFile.language}</span>
                          {dirty && <span className="text-[#FFB020]">· Unsaved changes</span>}
                        </>
                      )}
                    </div>
                    {viewMode === 'editor' && selectedFile && (
                      <button
                        type="button"
                        disabled={!dirty || saving}
                        onClick={handleSaveFile}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#00F5FF] px-3 py-1.5 text-xs font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-40"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {saving ? 'Saving...' : 'Save File'}
                      </button>
                    )}
                  </div>

                  {viewMode === 'diff' && selectedBug?.latestFix ? (
                    <CodeDiffPanel
                      original={selectedBug.latestFix.original_code}
                      modified={editableApprovedCode || selectedBug.latestFix.proposed_code}
                      language={toMonacoLang(selectedBug.language)}
                      height="400px"
                    />
                  ) : selectedFile ? (
                    <CodeEditorPanel
                      value={editorContent}
                      language={toMonacoLang(selectedFile.language)}
                      onChange={(val) => {
                        setEditorContent(val);
                        setDirty(val !== selectedFile.content);
                      }}
                      markers={fileMarkers}
                      highlightLine={
                        selectedBug && selectedBug.file_path === selectedFile.relative_path
                          ? selectedBug.line_number
                          : null
                      }
                      height="400px"
                    />
                  ) : (
                    <div className="py-16 text-center text-xs text-[#94A3B8]">Upload source files to begin editing.</div>
                  )}
                </section>

                {/* Selected Bug Details + AI Patch Confidence/Risk + Explicit Approval */}
                {selectedBug && (
                  <section className="cyber-panel rounded-xl p-5 space-y-5">
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                          <span
                            className="font-semibold uppercase"
                            style={{ color: selectedBug.status === 'resolved' ? '#39FF88' : SEV_COLOR[selectedBug.severity] }}
                          >
                            {selectedBug.status === 'resolved' ? 'Resolved' : `${selectedBug.severity} severity`}
                          </span>
                          <span className="text-[#94A3B8]">·</span>
                          <span className="text-[#94A3B8]">{selectedBug.category}</span>
                          <span className="text-[#94A3B8]">·</span>
                          <span className="text-[#00F5FF]">
                            {selectedBug.file_path}:{selectedBug.line_number}
                          </span>
                          <span className="text-[#94A3B8]">·</span>
                          <span className="text-[#94A3B8]">{selectedBug.source_tool}</span>
                        </div>
                        <h2 className="text-lg font-semibold text-[#F1F5F9]">{selectedBug.title}</h2>
                        <p className="text-xs text-[#FF3864] font-mono">{selectedBug.error_message}</p>
                        <p className="text-xs text-[#94A3B8] leading-relaxed">
                          <strong className="text-[#F1F5F9]">Root cause:</strong> {selectedBug.root_cause}
                        </p>
                      </div>

                      {selectedBug.status !== 'resolved' && (
                        <button
                          type="button"
                          disabled={generatingFix}
                          onClick={handleGenerateFix}
                          className="inline-flex items-center gap-2 rounded-lg bg-[#A855F7] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#A855F7]/90 disabled:opacity-50 shrink-0"
                        >
                          {generatingFix ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                          {generatingFix
                            ? 'Generating AI Patch...'
                            : selectedBug.latestFix
                              ? 'Regenerate AI Patch'
                              : 'Generate AI Patch'}
                        </button>
                      )}
                    </div>

                    {selectedBug.latestFix && (
                      <div className="pt-4 border-t border-[#00F5FF]/14 space-y-5">
                        {/* Smart Fix Confidence & Change Risk Meters */}
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                          <div className="lg:col-span-4 flex items-center justify-around rounded-lg border border-[#00F5FF]/14 bg-[#0B1220] p-4">
                            <CircularGauge
                              label="Fix Confidence"
                              value={selectedBug.latestFix.confidence_score}
                              sublabel="Heuristic Est."
                              accentColor="#00F5FF"
                            />
                            <CircularGauge
                              label="Change Risk"
                              value={selectedBug.latestFix.risk_score}
                              sublabel={`${selectedBug.latestFix.risk_level} Risk`}
                              accentColor={RISK_COLOR[selectedBug.latestFix.risk_level] || '#FFB020'}
                            />
                          </div>

                          <div className="lg:col-span-8 space-y-3 text-xs">
                            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3.5 space-y-2">
                              <div className="font-semibold text-[#F1F5F9]">Score Explanations & Factors</div>
                              <p className="text-[#94A3B8]">{selectedBug.latestFix.confidence_explanation}</p>
                              <p className="text-[#94A3B8]">{selectedBug.latestFix.risk_explanation}</p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                                <div>
                                  <div className="font-mono text-[11px] text-[#00F5FF] mb-1">Confidence Factors</div>
                                  <ul className="space-y-1 text-[11px] text-[#94A3B8]">
                                    {selectedBug.latestFix.confidenceFactors.map((f, i) => (
                                      <li key={i}>
                                        <span className="font-mono text-[#F1F5F9]">{f.impact}</span> {f.name}: {f.detail}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                <div>
                                  <div className="font-mono text-[11px] text-[#FFB020] mb-1">Change Risk Factors</div>
                                  <ul className="space-y-1 text-[11px] text-[#94A3B8]">
                                    {selectedBug.latestFix.riskFactors.map((f, i) => (
                                      <li key={i}>
                                        <span className="font-mono text-[#F1F5F9]">{f.impact}</span> {f.name}: {f.detail}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3.5 space-y-1">
                              <div className="font-semibold text-[#F1F5F9]">Patch Explanation</div>
                              <p className="text-[#94A3B8] leading-relaxed">{selectedBug.latestFix.explanation}</p>
                              <div className="pt-1 font-mono text-[11px] text-[#39FF88]">
                                Pre-Apply Validation ({selectedBug.latestFix.validation_status}):{' '}
                                {selectedBug.latestFix.validation_details}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Explicit Approval Controls */}
                        {selectedBug.latestFix.status === 'pending' && (
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#00F5FF]/25 bg-[#142238]/60 p-4">
                            <div className="text-xs text-[#94A3B8]">
                              Original code is never modified silently. Review the diff and approve to archive a rollback snapshot and apply.
                            </div>
                            <div className="flex items-center gap-2.5">
                              <button
                                type="button"
                                onClick={() => setViewMode(viewMode === 'diff' ? 'editor' : 'diff')}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/30 px-3.5 py-2 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
                              >
                                <GitCompare className="h-3.5 w-3.5 text-[#00F5FF]" />
                                {viewMode === 'diff' ? 'Back to Editor' : 'Inspect Before/After Diff'}
                              </button>
                              <button
                                type="button"
                                onClick={handleRejectFix}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[#FF3864]/40 px-3.5 py-2 text-xs font-medium text-[#FF3864] hover:bg-[#FF3864]/10"
                              >
                                <X className="h-3.5 w-3.5" />
                                Reject Patch
                              </button>
                              <button
                                type="button"
                                disabled={applyingFix}
                                onClick={handleApproveAndApply}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-[#39FF88] px-4 py-2 text-xs font-semibold text-[#070B14] hover:bg-[#39FF88]/90 disabled:opacity-50"
                              >
                                {applyingFix ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                {applyingFix ? 'Applying...' : 'Approve & Apply Patch'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
