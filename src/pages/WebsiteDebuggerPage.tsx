import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Code2,
  Globe,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface WebsiteIssue {
  id: string;
  checkCategory: string;
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedUrl: string;
  evidence: string;
  suggestedSolution: string;
  matchedProjectFile?: string | null;
}

interface WebsiteScanRecord {
  id: string;
  url: string;
  final_url?: string;
  finalUrl?: string;
  status: string;
  http_status?: number;
  httpStatus?: number;
  load_time_ms?: number;
  loadTimeMs?: number;
  issues: WebsiteIssue[];
  metrics: Record<string, number>;
  summary: {
    totalIssues?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
    score?: number;
    isExternalOnly?: boolean;
    sourceAccessNote?: string;
  };
  error_message?: string | null;
  created_at?: string;
}

const SEV_COLOR: Record<string, string> = {
  critical: '#FF3864',
  high: '#A855F7',
  medium: '#FFB020',
  low: '#3B82F6',
};

export const WebsiteDebuggerPage: React.FC = () => {
  const navigate = useNavigate();
  const { activeProjectId, socket, addToast } = useAppStore();
  const [url, setUrl] = useState('https://example.com');
  const [scanning, setScanning] = useState(false);
  const [liveStage, setLiveStage] = useState('');
  const [error, setError] = useState('');
  const [activeReport, setActiveReport] = useState<WebsiteScanRecord | null>(null);
  const [history, setHistory] = useState<WebsiteScanRecord[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch<{ scans: WebsiteScanRecord[] }>('/api/website-debugger/history');
      setHistory(res.scans);
      if (!activeReport && res.scans[0]?.status === 'completed') {
        setActiveReport(res.scans[0]);
      }
    } catch {
      // ignore
    }
  }, [activeReport]);

  useEffect(() => {
    loadHistory();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (p: { stage: string; detail: string }) => {
      setLiveStage(`${p.stage}: ${p.detail}`);
    };
    socket.on('website:progress', handler);
    return () => {
      socket.off('website:progress', handler);
    };
  }, [socket]);

  const runScan = async (target: string) => {
    setError('');
    setScanning(true);
    setLiveStage('Validating URL against SSRF & DNS rules...');
    try {
      const res = await apiFetch<WebsiteScanRecord>('/api/website-debugger/scan', {
        method: 'POST',
        body: JSON.stringify({ url: target.trim(), projectId: activeProjectId }),
      });
      setActiveReport(res);
      addToast({
        type: (res.summary?.critical ?? 0) > 0 ? 'warning' : 'success',
        title: 'Website scan complete',
        message: `${res.summary?.totalIssues ?? 0} issue(s) found (Score ${res.summary?.score ?? 100}/100).`,
      });
      await loadHistory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Website scan failed.';
      setError(msg);
      addToast({ type: 'error', title: 'Website scan blocked or failed', message: msg });
      await loadHistory();
    } finally {
      setScanning(false);
      setLiveStage('');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runScan(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#F1F5F9]">Website Debugger</h1>
        <p className="text-sm text-[#94A3B8]">
          SSRF-hardened diagnostic scanner checking broken links, missing assets, inline JS syntax errors, HTTP headers, responsive layout, accessibility, performance, and SEO.
        </p>
      </div>

      {/* Scan Form */}
      <section className="cyber-panel rounded-xl p-5 space-y-3">
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#00F5FF]" />
            <input
              type="url"
              required
              aria-label="Website URL to scan"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded-lg border border-[#00F5FF]/25 bg-[#070B14] py-2.5 pl-10 pr-3 font-mono text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={scanning}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#00F5FF] px-5 py-2.5 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50 whitespace-nowrap"
          >
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            {scanning ? 'Scanning Website...' : 'Start Website Scan'}
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#94A3B8]">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#39FF88]" />
            <span>SSRF protection active: localhost, private RFC1918/IPv6 ranges, metadata IPs, and unsafe redirects are blocked.</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Quick test:</span>
            <button
              type="button"
              onClick={() => setUrl('https://example.com')}
              className="font-mono text-[#00F5FF] hover:underline"
            >
              example.com
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => setUrl('http://127.0.0.1:3000')}
              className="font-mono text-[#FFB020] hover:underline"
            >
              Test SSRF Block
            </button>
          </div>
        </div>

        {liveStage && (
          <div className="rounded-lg border border-[#00F5FF]/25 bg-[#0B1220] px-3.5 py-2.5 font-mono text-xs text-[#00F5FF]">
            {liveStage}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-[#FF3864]/45 bg-[#FF3864]/10 p-3.5 text-xs text-[#FF3864] flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {/* Active Diagnostic Report */}
      {activeReport && activeReport.status === 'completed' && (
        <section className="cyber-panel rounded-xl p-5 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-mono text-[#94A3B8]">
                Final URL: <span className="text-[#00F5FF]">{activeReport.finalUrl || activeReport.final_url}</span>
              </div>
              <h2 className="mt-1 text-lg font-semibold text-[#F1F5F9]">Website Diagnostic Report</h2>
              <p className="text-xs text-[#94A3B8] mt-0.5">{activeReport.summary?.sourceAccessNote}</p>
            </div>
            <button
              type="button"
              disabled={scanning}
              onClick={() => runScan(activeReport.url)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/30 px-3.5 py-2 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF] self-start"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Re-run Scan
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">Diagnostic Score</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#00F5FF] tabular-nums">
                {activeReport.summary?.score ?? 100}/100
              </div>
            </div>
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">HTTP Status</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#39FF88] tabular-nums">
                {activeReport.httpStatus ?? activeReport.http_status}
              </div>
            </div>
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">Load Time</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#F1F5F9] tabular-nums">
                {activeReport.loadTimeMs ?? activeReport.load_time_ms}ms
              </div>
            </div>
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">Broken Links</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#FFB020] tabular-nums">
                {activeReport.metrics?.brokenLinksCount ?? 0} / {activeReport.metrics?.linksChecked ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">Missing Images</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#FF3864] tabular-nums">
                {activeReport.metrics?.brokenImagesCount ?? 0} / {activeReport.metrics?.imagesChecked ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3">
              <div className="text-[11px] text-[#94A3B8]">Total Issues</div>
              <div className="mt-1 font-mono text-xl font-bold text-[#A855F7] tabular-nums">
                {activeReport.issues.length}
              </div>
            </div>
          </div>

          <div className="space-y-2.5">
            {activeReport.issues.length === 0 ? (
              <div className="rounded-lg border border-[#39FF88]/30 bg-[#0B1220] p-6 text-center text-xs text-[#39FF88]">
                No issues detected across all 12 website diagnostic checks.
              </div>
            ) : (
              activeReport.issues.map((issue) => (
                <div key={issue.id} className="rounded-lg border border-[#00F5FF]/14 bg-[#0B1220] p-4 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold uppercase" style={{ color: SEV_COLOR[issue.severity] }}>
                        {issue.severity}
                      </span>
                      <span className="text-[#94A3B8]">·</span>
                      <span className="text-[#00F5FF]">{issue.checkCategory}</span>
                      <span className="text-[#94A3B8]">·</span>
                      <span className="font-semibold text-[#F1F5F9]">{issue.name}</span>
                    </div>
                    {issue.matchedProjectFile && (
                      <button
                        type="button"
                        onClick={() => navigate(`/workbench?file=${encodeURIComponent(issue.matchedProjectFile!)}`)}
                        className="inline-flex items-center gap-1 text-[#00F5FF] hover:underline"
                      >
                        <Code2 className="h-3.5 w-3.5" />
                        Open {issue.matchedProjectFile}
                      </button>
                    )}
                  </div>
                  <p className="text-[#94A3B8]">{issue.description}</p>
                  <div className="font-mono text-[11px] text-[#94A3B8] break-all">
                    <strong className="text-[#F1F5F9]">Evidence:</strong> {issue.evidence} ({issue.affectedUrl})
                  </div>
                  <div className="text-[#39FF88]">
                    <strong>Suggested Fix:</strong> {issue.suggestedSolution}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Website Scan History */}
      <section className="cyber-panel rounded-xl p-5">
        <h2 className="text-base font-semibold text-[#F1F5F9] mb-3">Recent Website Scans</h2>
        {history.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#94A3B8]">No website scans recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <div
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] px-4 py-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[#F1F5F9] truncate">{h.url}</div>
                  <div className="text-[11px] text-[#94A3B8]">
                    {h.status === 'failed'
                      ? `Blocked / Failed: ${h.error_message}`
                      : `HTTP ${h.http_status} · ${h.load_time_ms}ms · ${h.issues.length} issue(s) · Score ${h.summary?.score ?? '—'}/100`}
                  </div>
                </div>
                {h.status === 'completed' && (
                  <button
                    type="button"
                    onClick={() => setActiveReport(h)}
                    className="rounded-md border border-[#00F5FF]/25 px-3 py-1 text-xs text-[#00F5FF] hover:bg-[#00F5FF]/10"
                  >
                    View Report
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
