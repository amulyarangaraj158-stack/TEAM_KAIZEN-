import React, { useEffect, useRef, useState } from 'react';
import {
  Film,
  Image as ImageIcon,
  Music,
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileWarning,
  RefreshCw,
  Info,
  FolderSearch,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface MediaProblem {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
  suggestedSolution: string;
}

interface MediaAnalysis {
  id: string;
  fileName: string;
  mediaType: 'image' | 'audio' | 'video' | 'unknown';
  mimeType: string;
  fileSize: number;
  format: string;
  codec: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  validationStatus: 'valid' | 'warnings' | 'corrupted' | 'unsupported';
  problems: MediaProblem[];
  metadata: Record<string, unknown>;
  browserPreviewSupported: boolean;
  previewUrl: string | null;
  createdAt: string;
}

interface ProjectMediaRef {
  sourceFile: string;
  lineNumber: number;
  referencedAsset: string;
  assetType: string;
  status: 'missing' | 'present';
}

function normalizeMediaRecord(raw: Record<string, unknown>): MediaAnalysis {
  return {
    id: String(raw.id ?? ''),
    fileName: String(raw.fileName ?? raw.file_name ?? 'unknown'),
    mediaType: (raw.mediaType ?? raw.media_type ?? 'unknown') as MediaAnalysis['mediaType'],
    mimeType: String(raw.mimeType ?? raw.mime_type ?? 'application/octet-stream'),
    fileSize: Number(raw.fileSize ?? raw.file_size ?? 0),
    format: String(raw.format ?? 'unknown'),
    codec: String(raw.codec ?? 'unknown'),
    durationSec:
      raw.durationSec !== undefined && raw.durationSec !== null
        ? Number(raw.durationSec)
        : raw.duration_sec !== undefined && raw.duration_sec !== null
          ? Number(raw.duration_sec)
          : null,
    width:
      raw.width !== undefined && raw.width !== null ? Number(raw.width) : null,
    height:
      raw.height !== undefined && raw.height !== null ? Number(raw.height) : null,
    bitrate:
      raw.bitrate !== undefined && raw.bitrate !== null ? Number(raw.bitrate) : null,
    validationStatus: (raw.validationStatus ?? raw.validation_status ?? 'warnings') as MediaAnalysis['validationStatus'],
    problems: Array.isArray(raw.problems) ? (raw.problems as MediaProblem[]) : [],
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    browserPreviewSupported: Boolean(raw.browserPreviewSupported ?? raw.browser_preview_supported),
    previewUrl: raw.previewUrl ? String(raw.previewUrl) : null,
    createdAt: String(raw.created_at ?? raw.createdAt ?? new Date().toISOString()),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(sec: number | null): string {
  if (sec === null || Number.isNaN(sec)) return 'N/A';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export const MultimediaDebuggerPage: React.FC = () => {
  const { activeProjectId, projects, addToast } = useAppStore();
  const [history, setHistory] = useState<MediaAnalysis[]>([]);
  const [selected, setSelected] = useState<MediaAnalysis | null>(null);
  const [projectRefs, setProjectRefs] = useState<ProjectMediaRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [loadingRefs, setLoadingRefs] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  const loadHistory = async () => {
    try {
      const res = await apiFetch<{ analyses: Array<Record<string, unknown>> }>('/api/multimedia/history');
      const normalized = res.analyses.map(normalizeMediaRecord);
      setHistory(normalized);
      if (!selected && normalized.length > 0) {
        setSelected(normalized[0]);
      }
    } catch {
      // handled silently on initial mount
    }
  };

  const loadProjectRefs = async () => {
    if (!activeProjectId) {
      setProjectRefs([]);
      return;
    }
    setLoadingRefs(true);
    try {
      const res = await apiFetch<{ references: ProjectMediaRef[] }>(
        `/api/multimedia/project-refs?projectId=${encodeURIComponent(activeProjectId)}`,
      );
      setProjectRefs(res.references);
    } catch {
      setProjectRefs([]);
    } finally {
      setLoadingRefs(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    void loadProjectRefs();
  }, [activeProjectId]);

  const handleAnalyzeFile = async (file: File) => {
    if (file.size > 35 * 1024 * 1024) {
      addToast({ type: 'error', title: 'File too large', message: 'Maximum supported media size is 35 MB.' });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('media', file);
      if (activeProjectId) formData.append('projectId', activeProjectId);

      const res = await apiFetch<{ analysis: Record<string, unknown> }>('/api/multimedia/analyze', {
        method: 'POST',
        body: formData,
      });
      const record = normalizeMediaRecord(res.analysis);
      setSelected(record);
      setHistory((prev) => [record, ...prev.filter((item) => item.id !== record.id)].slice(0, 25));
      addToast({
        type: record.validationStatus === 'valid' ? 'success' : record.validationStatus === 'corrupted' ? 'error' : 'warning',
        title: `Analyzed ${record.fileName}`,
        message: `Status: ${record.validationStatus.toUpperCase()} · ${record.problems.length} technical finding(s).`,
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Media analysis failed',
        message: err instanceof Error ? err.message : 'Unable to inspect uploaded file.',
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleAnalyzeFile(file);
  };

  const statusColor = (status: MediaAnalysis['validationStatus']) => {
    if (status === 'valid') return 'text-[#39FF88]';
    if (status === 'warnings') return 'text-[#FFB020]';
    return 'text-[#FF3864]';
  };

  const severityColor = (sev: MediaProblem['severity']) => {
    if (sev === 'critical') return 'text-[#FF3864]';
    if (sev === 'high') return 'text-[#FFB020]';
    if (sev === 'medium') return 'text-[#00F5FF]';
    return 'text-[#94A3B8]';
  };

  const MediaIcon = ({ type }: { type: MediaAnalysis['mediaType'] }) => {
    if (type === 'video') return <Film className="h-4 w-4 text-[#A855F7]" />;
    if (type === 'audio') return <Music className="h-4 w-4 text-[#00F5FF]" />;
    if (type === 'image') return <ImageIcon className="h-4 w-4 text-[#39FF88]" />;
    return <FileWarning className="h-4 w-4 text-[#FF3864]" />;
  };

  const missingRefs = projectRefs.filter((r) => r.status === 'missing');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F1F5F9]">Multimedia Debugger</h1>
          <p className="mt-1 text-sm text-[#94A3B8]">
            Inspect uploaded images, audio, and video using magic-byte verification, FFprobe container/codec probing, and FFmpeg frame integrity checks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadHistory();
            void loadProjectRefs();
          }}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-[#00F5FF]/25 bg-[#101A2B] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]/60"
        >
          <RefreshCw className="h-3.5 w-3.5 text-[#00F5FF]" />
          Refresh Reports
        </button>
      </div>

      {/* Honest technical scope notice */}
      <div className="flex items-start gap-3 rounded-lg border border-[#3B82F6]/30 bg-[#101A2B] px-4 py-3 text-xs text-[#94A3B8]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#3B82F6]" />
        <p>
          <span className="font-semibold text-[#F1F5F9]">Technical Media Verification Scope:</span> This engine performs real binary magic-byte header validation, SVG script/XSS detection, FFprobe stream/codec/resolution extraction, FFmpeg decode error checking, and HTML5 web-compatibility checks. It reports actual container and decoding defects rather than AI visual scene narration.
        </p>
      </div>

      {/* Upload Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        className={`cyber-panel rounded-xl border-2 border-dashed p-6 transition-colors ${
          dragActive ? 'border-[#00F5FF] bg-[#142238]/80' : 'border-[#00F5FF]/25 hover:border-[#00F5FF]/45'
        }`}
      >
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#00F5FF]/25 bg-[#0B1220]">
              <Upload className="h-5 w-5 text-[#00F5FF]" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Upload Image, Audio, or Video for Inspection</h2>
              <p className="mt-0.5 text-xs text-[#94A3B8]">
                Supports PNG, JPG, GIF, WebP, SVG, BMP, MP3, WAV, OGG, FLAC, M4A, MP4, WebM, MOV, MKV, AVI · Max 35 MB
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,audio/*,video/*,.mkv,.avi,.mov,.flv,.svg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleAnalyzeFile(file);
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="whitespace-nowrap rounded-lg bg-[#00F5FF] px-4 py-2 text-xs font-semibold text-[#070B14] transition hover:bg-[#38F8FF] disabled:opacity-50"
            >
              {uploading ? 'Probing Media...' : 'Select Media File'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Inspector + History */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-8">
          {selected ? (
            <div className="cyber-panel rounded-xl p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#00F5FF]/15 pb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <MediaIcon type={selected.mediaType} />
                    <h2 className="truncate font-mono text-base font-semibold text-[#F1F5F9]">{selected.fileName}</h2>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#94A3B8] font-mono tabular-nums">
                    <span>Type: {selected.mediaType.toUpperCase()}</span>
                    <span>MIME: {selected.mimeType}</span>
                    <span>Size: {formatBytes(selected.fileSize)}</span>
                  </div>
                </div>
                <div className={`flex items-center gap-1.5 font-mono text-xs font-semibold uppercase ${statusColor(selected.validationStatus)}`}>
                  {selected.validationStatus === 'valid' ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : selected.validationStatus === 'warnings' ? (
                    <AlertTriangle className="h-4 w-4" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  {selected.validationStatus}
                </div>
              </div>

              {/* Technical Metadata Grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                  <div className="text-[11px] text-[#94A3B8]">Container / Format</div>
                  <div className="mt-1 truncate font-mono text-sm font-semibold text-[#F1F5F9]">{selected.format || 'unknown'}</div>
                </div>
                <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                  <div className="text-[11px] text-[#94A3B8]">Codec</div>
                  <div className="mt-1 truncate font-mono text-sm font-semibold text-[#00F5FF]">{selected.codec || 'unknown'}</div>
                </div>
                <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                  <div className="text-[11px] text-[#94A3B8]">Resolution</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-[#F1F5F9] tabular-nums">
                    {selected.width && selected.height ? `${selected.width}×${selected.height}` : 'N/A'}
                  </div>
                </div>
                <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                  <div className="text-[11px] text-[#94A3B8]">Duration / Bitrate</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-[#F1F5F9] tabular-nums">
                    {formatDuration(selected.durationSec)}
                    {selected.bitrate ? ` · ${Math.round(selected.bitrate / 1000)} kbps` : ''}
                  </div>
                </div>
              </div>

              {/* Browser Preview */}
              <div className="rounded-lg border border-[#00F5FF]/15 bg-[#070B14] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">Playback & Asset Preview</span>
                  <span className="font-mono text-[11px] text-[#64748B]">
                    {selected.browserPreviewSupported ? 'HTML5 Browser Preview Active' : 'Preview Disabled (Unsupported or Corrupted)'}
                  </span>
                </div>
                {selected.browserPreviewSupported && selected.previewUrl ? (
                  <div className="flex justify-center">
                    {selected.mediaType === 'image' && (
                      <img
                        src={selected.previewUrl}
                        alt={selected.fileName}
                        className="max-h-72 rounded border border-[#00F5FF]/20 object-contain"
                      />
                    )}
                    {selected.mediaType === 'audio' && (
                      <audio controls src={selected.previewUrl} className="w-full max-w-lg" />
                    )}
                    {selected.mediaType === 'video' && (
                      <video
                        controls
                        src={selected.previewUrl}
                        className="max-h-80 w-full rounded border border-[#00F5FF]/20 bg-black"
                      />
                    )}
                  </div>
                ) : (
                  <div className="rounded border border-[#FF3864]/25 bg-[#FF3864]/5 px-4 py-6 text-center text-xs text-[#94A3B8]">
                    Browser preview is unavailable because the media file failed integrity validation or uses a non-web-native format/codec.
                  </div>
                )}
              </div>

              {/* Detected Problems */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
                  Detected Problems ({selected.problems.length})
                </h3>
                {selected.problems.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-[#39FF88]/25 bg-[#39FF88]/5 px-4 py-3 text-xs text-[#39FF88]">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    No container corruption, header mismatch, or browser playback compatibility issues detected.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {selected.problems.map((p, idx) => (
                      <div key={idx} className="rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] p-3.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[#F1F5F9]">{p.title}</span>
                          <span className={`font-mono text-[11px] font-semibold uppercase ${severityColor(p.severity)}`}>
                            {p.severity}
                          </span>
                        </div>
                        <p className="text-xs text-[#94A3B8]">{p.description}</p>
                        {p.evidence && (
                          <div className="rounded bg-[#070B14] px-2.5 py-1.5 font-mono text-[11px] text-[#00F5FF] break-all">
                            Evidence: {p.evidence}
                          </div>
                        )}
                        <div className="text-xs text-[#39FF88]">
                          <span className="font-semibold">Suggested Fix:</span> {p.suggestedSolution}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="cyber-panel rounded-xl p-10 text-center">
              <Film className="mx-auto h-8 w-8 text-[#64748B]" />
              <h3 className="mt-3 text-sm font-semibold text-[#F1F5F9]">No media file inspected yet</h3>
              <p className="mt-1 text-xs text-[#94A3B8]">
                Upload an image, audio clip, or video file above to run real FFprobe, FFmpeg, and magic-byte diagnostics.
              </p>
            </div>
          )}

          {/* Active Project Broken Media References */}
          <div className="cyber-panel rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderSearch className="h-4 w-4 text-[#A855F7]" />
                <h3 className="text-sm font-semibold text-[#F1F5F9]">
                  Project Media Asset References {activeProject ? `— ${activeProject.name}` : ''}
                </h3>
              </div>
              <span className="font-mono text-xs text-[#94A3B8] tabular-nums">
                {loadingRefs ? 'Scanning...' : `${missingRefs.length} missing / ${projectRefs.length} total`}
              </span>
            </div>
            {projectRefs.length === 0 ? (
              <p className="text-xs text-[#94A3B8]">
                No local relative image, video, or audio asset references found in the active project&apos;s HTML/CSS/JS files.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#00F5FF]/15 text-[11px] uppercase text-[#64748B]">
                      <th className="py-2 pr-3">Source File</th>
                      <th className="py-2 pr-3">Line</th>
                      <th className="py-2 pr-3">Referenced Asset</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#00F5FF]/10 font-mono">
                    {projectRefs.map((r, i) => (
                      <tr key={`${r.sourceFile}-${r.lineNumber}-${i}`}>
                        <td className="py-2 pr-3 text-[#F1F5F9]">{r.sourceFile}</td>
                        <td className="py-2 pr-3 text-[#94A3B8] tabular-nums">{r.lineNumber}</td>
                        <td className="py-2 pr-3 text-[#00F5FF] break-all">{r.referencedAsset}</td>
                        <td className="py-2 pr-3 uppercase text-[#94A3B8]">{r.assetType}</td>
                        <td className={`py-2 font-semibold uppercase ${r.status === 'missing' ? 'text-[#FF3864]' : 'text-[#39FF88]'}`}>
                          {r.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* History Sidebar */}
        <div className="xl:col-span-4">
          <div className="cyber-panel rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">Inspection History</h3>
              <span className="font-mono text-xs text-[#64748B] tabular-nums">{history.length} saved</span>
            </div>
            {history.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#64748B]">Uploaded media inspection reports will appear here.</p>
            ) : (
              <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                {history.map((item) => {
                  const isActive = selected?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelected(item)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        isActive
                          ? 'border-[#00F5FF]/60 bg-[#142238]'
                          : 'border-[#00F5FF]/10 bg-[#0B1220] hover:border-[#00F5FF]/30'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <MediaIcon type={item.mediaType} />
                          <span className="truncate font-mono text-xs font-semibold text-[#F1F5F9]">{item.fileName}</span>
                        </div>
                        <span className={`shrink-0 font-mono text-[10px] font-semibold uppercase ${statusColor(item.validationStatus)}`}>
                          {item.validationStatus}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-mono text-[#94A3B8] tabular-nums">
                        <span className="min-w-0 truncate">
                          {item.format.split(',')[0]}/{item.codec} · {formatBytes(item.fileSize)}
                        </span>
                        <span className="shrink-0 whitespace-nowrap">{item.problems.length} issue(s)</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
