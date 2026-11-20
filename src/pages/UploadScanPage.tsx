import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FileCode2,
  Loader2,
  Play,
  ShieldAlert,
  UploadCloud,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface ScanStage {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  detail?: string;
}

interface ScanRecord {
  id: string;
  status: string;
  current_stage: string;
  files_scanned: number;
  bugs_found: number;
  critical_count: number;
  summary: string;
  error_message?: string | null;
  started_at: string;
  completed_at: string | null;
  stages: ScanStage[];
}

interface UploadSummary {
  uploadedCount: number;
  languages: string[];
  dependenciesFound: number;
  files: Array<{ relativePath: string; language: string; sizeBytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
  rejectedSecurityEntries: Array<{ path: string; reason: string }>;
}

const DEFAULT_STAGES: ScanStage[] = [
  'Project validation',
  'File discovery',
  'Language detection',
  'Dependency analysis',
  'Static analysis',
  'AI analysis',
  'Bug classification',
  'Fix generation',
  'Result storage',
  'Report generation',
].map((name) => ({ name, status: 'pending', detail: '' }));

export const UploadScanPage: React.FC = () => {
  const navigate = useNavigate();
  const { projects, activeProjectId, setActiveProjectId, socket, refreshProjects, addToast } = useAppStore();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [uploadError, setUploadError] = useState('');

  const [enableAi, setEnableAi] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [liveStages, setLiveStages] = useState<ScanStage[]>(DEFAULT_STAGES);
  const [scanHistory, setScanHistory] = useState<ScanRecord[]>([]);

  const loadHistory = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const res = await apiFetch<{ scans: ScanRecord[] }>(`/api/projects/${activeProjectId}/scans`);
      setScanHistory(res.scans);
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { projectId: string; stages: ScanStage[] }) => {
      if (payload.projectId === activeProjectId && Array.isArray(payload.stages)) {
        setLiveStages(payload.stages);
      }
    };
    socket.on('scan:progress', handler);
    return () => {
      socket.off('scan:progress', handler);
    };
  }, [socket, activeProjectId]);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProjectId) {
      setUploadError('Select or create a project before uploading files.');
      return;
    }
    if (selectedFiles.length === 0) {
      setUploadError('Choose a project ZIP archive or one or more supported source files.');
      return;
    }

    setUploadError('');
    setUploadSummary(null);
    setUploading(true);
    try {
      const form = new FormData();
      selectedFiles.forEach((f) => form.append('files', f));
      const res = await apiFetch<UploadSummary>(`/api/projects/${activeProjectId}/upload`, {
        method: 'POST',
        body: form,
      });
      setUploadSummary(res);
      setSelectedFiles([]);
      await refreshProjects();
      addToast({
        type: 'success',
        title: `Uploaded ${res.uploadedCount} source file(s)`,
        message: `Detected ${res.languages.join(', ')} with ${res.dependenciesFound} dependency link(s).`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setUploadError(msg);
      addToast({ type: 'error', title: 'Upload rejected', message: msg });
    } finally {
      setUploading(false);
    }
  };

  const handleStartScan = async () => {
    if (!activeProjectId) return;
    setScanning(true);
    setLiveStages(DEFAULT_STAGES);
    try {
      const res = await apiFetch<{
        scanId: string;
        bugsFound: number;
        criticalCount: number;
        summary: string;
        stages: ScanStage[];
      }>(`/api/projects/${activeProjectId}/scan`, {
        method: 'POST',
        body: JSON.stringify({ enableAiAnalysis: enableAi }),
      });
      setLiveStages(res.stages);
      await Promise.all([loadHistory(), refreshProjects()]);
      addToast({
        type: res.criticalCount > 0 ? 'warning' : 'success',
        title: 'Scan completed',
        message: res.summary,
      });
    } catch (err) {
      addToast({ type: 'error', title: 'Scan failed', message: err instanceof Error ? err.message : '' });
      await loadHistory();
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F1F5F9]">Upload & Scan Engine</h1>
          <p className="text-sm text-[#94A3B8]">
            Upload ZIP archives or source files safely (path-traversal & zip-bomb protected) and run real 10-stage static + AI analysis.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="upload-project-select" className="text-xs text-[#94A3B8]">
            Target Project:
          </label>
          <select
            id="upload-project-select"
            value={activeProjectId ?? ''}
            onChange={(e) => setActiveProjectId(e.target.value || null)}
            className="rounded-lg border border-[#00F5FF]/25 bg-[#101A2B] px-3 py-2 text-xs font-medium text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Upload Zone */}
        <section className="xl:col-span-6 cyber-panel rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-[#F1F5F9]">1. Upload Project ZIP or Source Files</h2>
          <form onSubmit={handleUpload} className="space-y-4">
            <label
              htmlFor="source-file-input"
              className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#00F5FF]/35 bg-[#0B1220] p-8 text-center cursor-pointer hover:border-[#00F5FF] transition-colors"
            >
              <UploadCloud className="h-8 w-8 text-[#00F5FF] mb-3" />
              <span className="text-sm font-medium text-[#F1F5F9]">
                Select ZIP archive or supported source files
              </span>
              <span className="mt-1 text-xs text-[#94A3B8]">
                Supports .zip, .py, .ts, .tsx, .js, .jsx, .java, .c, .cpp, .go, .rs, .sql, .html, .css, .json, .php, .cs (max 20 MB)
              </span>
              <input
                id="source-file-input"
                type="file"
                multiple
                accept=".zip,.py,.js,.jsx,.ts,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sql,.html,.css,.json,.php,.cs"
                onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
                className="sr-only"
              />
            </label>

            {selectedFiles.length > 0 && (
              <div className="rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] p-3 space-y-1.5">
                <div className="text-xs font-medium text-[#F1F5F9]">
                  Selected ({selectedFiles.length}):
                </div>
                {selectedFiles.map((f) => (
                  <div key={f.name} className="flex items-center justify-between text-xs font-mono text-[#94A3B8]">
                    <span className="truncate">{f.name}</span>
                    <span className="tabular-nums">{(f.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))}
              </div>
            )}

            {uploadError && (
              <div className="rounded-lg border border-[#FF3864]/40 bg-[#FF3864]/10 p-3 text-xs text-[#FF3864] flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={uploading || selectedFiles.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#00F5FF] px-4 py-2.5 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50"
            >
              <UploadCloud className="h-4 w-4" />
              {uploading ? 'Extracting & Validating...' : 'Extract & Save to Project'}
            </button>
          </form>

          {uploadSummary && (
            <div className="rounded-lg border border-[#39FF88]/30 bg-[#0B1220] p-4 space-y-2 text-xs">
              <div className="font-semibold text-[#39FF88]">
                Safely extracted {uploadSummary.uploadedCount} source file(s)
              </div>
              <div className="text-[#94A3B8]">
                Languages: <span className="font-mono text-[#F1F5F9]">{uploadSummary.languages.join(', ')}</span> · Dependencies mapped:{' '}
                <span className="font-mono text-[#00F5FF]">{uploadSummary.dependenciesFound}</span>
              </div>
              {uploadSummary.rejectedSecurityEntries.length > 0 && (
                <div className="rounded border border-[#FF3864]/40 bg-[#FF3864]/10 p-2 text-[#FF3864]">
                  <div className="font-semibold flex items-center gap-1.5">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Blocked {uploadSummary.rejectedSecurityEntries.length} unsafe archive entry(s)
                  </div>
                  {uploadSummary.rejectedSecurityEntries.map((r, i) => (
                    <div key={i} className="font-mono text-[11px] mt-0.5">
                      {r.path} — {r.reason}
                    </div>
                  ))}
                </div>
              )}
              {uploadSummary.skipped.length > 0 && (
                <div className="text-[11px] text-[#94A3B8]">
                  Skipped {uploadSummary.skipped.length} unsupported or dependency directory file(s).
                </div>
              )}
            </div>
          )}
        </section>

        {/* Live 10-Stage Scanner */}
        <section className="xl:col-span-6 cyber-panel rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">2. Multi-Stage Code Analysis Pipeline</h2>
              <p className="text-xs text-[#94A3B8]">Live backend stage progression over Socket.IO (no artificial percentages).</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[#F1F5F9] cursor-pointer">
              <input
                type="checkbox"
                checked={enableAi}
                onChange={(e) => setEnableAi(e.target.checked)}
                className="rounded border-[#00F5FF]/40 bg-[#070B14] accent-[#00F5FF]"
              />
              Enable Gemini Deep Scan
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={scanning || !activeProjectId}
              onClick={handleStartScan}
              className="inline-flex items-center gap-2 rounded-lg bg-[#00F5FF] px-4 py-2.5 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50"
            >
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {scanning ? 'Running Real Analysis...' : 'Run Full 10-Stage Scan'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/workbench')}
              className="inline-flex items-center gap-2 rounded-lg border border-[#00F5FF]/25 px-4 py-2.5 text-sm font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
            >
              <FileCode2 className="h-4 w-4 text-[#00F5FF]" />
              Inspect Bugs in Workbench
            </button>
          </div>

          <div className="space-y-1.5 pt-1">
            {liveStages.map((stage, idx) => (
              <div
                key={stage.name}
                className="flex items-start justify-between gap-3 rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {stage.status === 'completed' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[#39FF88]" />
                  ) : stage.status === 'running' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#00F5FF]" />
                  ) : stage.status === 'failed' ? (
                    <AlertCircle className="h-4 w-4 shrink-0 text-[#FF3864]" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-[#475569]" />
                  )}
                  <span className="font-mono text-[#94A3B8] tabular-nums">{String(idx + 1).padStart(2, '0')}.</span>
                  <span className="font-medium text-[#F1F5F9]">{stage.name}</span>
                </div>
                <span className="text-right font-mono text-[11px] text-[#94A3B8] truncate max-w-[55%]" title={stage.detail}>
                  {stage.detail || stage.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Scan History Table */}
      <section className="cyber-panel rounded-xl p-5">
        <h2 className="text-base font-semibold text-[#F1F5F9] mb-4">Scan History</h2>
        {scanHistory.length === 0 ? (
          <div className="py-8 text-center text-xs text-[#94A3B8]">No scan runs recorded for this project yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#00F5FF]/14 text-[#94A3B8]">
                  <th className="py-2.5 pr-4 font-medium">Started</th>
                  <th className="py-2.5 pr-4 font-medium">Status</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Files</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Bugs Found</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Critical</th>
                  <th className="py-2.5 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#00F5FF]/10">
                {scanHistory.map((s) => (
                  <tr key={s.id} className="hover:bg-[#142238]/50">
                    <td className="py-3 pr-4 font-mono text-[#94A3B8] whitespace-nowrap">
                      {new Date(s.started_at).toLocaleString()}
                    </td>
                    <td className="py-3 pr-4 font-mono whitespace-nowrap">
                      <span
                        className={
                          s.status === 'completed'
                            ? 'text-[#39FF88]'
                            : s.status === 'failed'
                              ? 'text-[#FF3864]'
                              : 'text-[#00F5FF]'
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-[#F1F5F9]">{s.files_scanned}</td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-[#FFB020]">{s.bugs_found}</td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-[#FF3864]">{s.critical_count}</td>
                    <td className="py-3 text-[#94A3B8]">{s.error_message || s.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
