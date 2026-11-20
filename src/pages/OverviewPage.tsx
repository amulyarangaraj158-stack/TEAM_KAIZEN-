import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderGit2,
  Play,
  RefreshCw,
  ShieldAlert,
  UploadCloud,
} from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface DashboardData {
  kpis: {
    totalBugsDetected: number;
    bugsSuccessfullyFixed: number;
    criticalIssues: number;
    projectHealthScore: number;
  };
  activeProject: {
    id: string;
    name: string;
    description: string;
    languages: string[];
    totalFiles: number;
    healthScore: number;
    lastScanAt: string | null;
    detectedBugs: number;
    resolvedBugs: number;
  } | null;
  severityBreakdown: Array<{ severity: string; count: number }>;
  recentActivity: Array<{
    id: string;
    action_type: string;
    action_status: string;
    project_name: string;
    file_path: string;
    risk_level: string;
    details: string;
    user_name: string;
    created_at: string;
  }>;
}

const SEV_COLORS: Record<string, string> = {
  critical: '#FF3864',
  high: '#A855F7',
  medium: '#FFB020',
  low: '#3B82F6',
};

const ACTION_LABELS: Record<string, string> = {
  project_uploaded: 'Project Uploaded',
  bug_detected: 'Bug Detected',
  patch_generated: 'Patch Generated',
  patch_modified: 'Patch Modified',
  patch_applied: 'Patch Applied & Verified',
  patch_rejected: 'Patch Rejected',
  patch_rolled_back: 'Rollback Completed',
};

export const OverviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { activeProjectId, healthServices, refreshHealth, refreshProjects, addToast } = useAppStore();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const qs = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : '';
      const res = await apiFetch<DashboardData>(`/api/dashboard${qs}`);
      setData(res);
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to load dashboard', message: err instanceof Error ? err.message : '' });
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, addToast]);

  useEffect(() => {
    loadDashboard();
    refreshHealth();
  }, [loadDashboard, refreshHealth]);

  const handleQuickScan = async () => {
    if (!activeProjectId) {
      navigate('/upload');
      return;
    }
    setScanning(true);
    try {
      const res = await apiFetch<{ bugsFound: number; criticalCount: number; summary: string }>(
        `/api/projects/${activeProjectId}/scan`,
        {
          method: 'POST',
          body: JSON.stringify({ enableAiAnalysis: false }),
        },
      );
      addToast({
        type: res.criticalCount > 0 ? 'warning' : 'success',
        title: 'Scan completed',
        message: res.summary,
      });
      await Promise.all([loadDashboard(), refreshProjects()]);
    } catch (err) {
      addToast({ type: 'error', title: 'Scan failed', message: err instanceof Error ? err.message : '' });
    } finally {
      setScanning(false);
    }
  };

  const todayFormatted = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());

  const chartData = ['critical', 'high', 'medium', 'low'].map((sev) => ({
    name: sev.charAt(0).toUpperCase() + sev.slice(1),
    severity: sev,
    count: data?.severityBreakdown.find((s) => s.severity === sev)?.count ?? 0,
  }));

  return (
    <div className="space-y-6">
      {/* Welcome Command Header */}
      <section className="cyber-panel rounded-xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#94A3B8]">
            <span>{todayFormatted}</span>
            <span aria-hidden="true">·</span>
            <span>
              Active Project:{' '}
              <strong className="font-medium text-[#00F5FF]">
                {data?.activeProject?.name || 'None Selected'}
              </strong>
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-[#F1F5F9]">
            Welcome to AutoPatch AI
          </h1>
          <p className="text-sm text-[#94A3B8] max-w-2xl">
            Your intelligent software debugging and autonomous repair command centre.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => navigate('/upload')}
            className="inline-flex items-center gap-2 rounded-lg border border-[#00F5FF]/35 bg-[#142238] px-4 py-2.5 text-sm font-medium text-[#F1F5F9] hover:border-[#00F5FF] transition-colors whitespace-nowrap"
          >
            <UploadCloud className="h-4 w-4 text-[#00F5FF]" />
            Upload Project
          </button>
          <button
            type="button"
            disabled={scanning}
            onClick={handleQuickScan}
            className="inline-flex items-center gap-2 rounded-lg bg-[#00F5FF] px-4 py-2.5 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Play className="h-4 w-4" />
            {scanning ? 'Scanning Project...' : 'Start New Scan'}
          </button>
        </div>
      </section>

      {/* Four Real DB-Backed KPI Cards */}
      <section aria-label="Key project metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="cyber-panel rounded-xl p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Total Bugs Detected</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#F1F5F9]">
              {loading ? '—' : data?.kpis.totalBugsDetected ?? 0}
            </span>
            <span className="text-xs text-[#3B82F6]">Database verified</span>
          </div>
        </div>

        <div className="cyber-panel rounded-xl p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Bugs Successfully Fixed</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#39FF88]">
              {loading ? '—' : data?.kpis.bugsSuccessfullyFixed ?? 0}
            </span>
            <span className="text-xs text-[#94A3B8]">Snapshot backed</span>
          </div>
        </div>

        <div className="cyber-panel rounded-xl p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Critical Issues</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#FF3864]">
              {loading ? '—' : data?.kpis.criticalIssues ?? 0}
            </span>
            <span className="text-xs text-[#FF3864]">Open criticals</span>
          </div>
        </div>

        <div className="cyber-panel rounded-xl p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Project Health Score</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-3xl font-bold tabular-nums text-[#00F5FF]">
              {loading ? '—' : `${data?.kpis.projectHealthScore ?? 100}%`}
            </span>
            <span className="text-xs text-[#94A3B8]">Calculated live</span>
          </div>
        </div>
      </section>

      {/* Real System Health Panel */}
      <section className="cyber-panel rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-[#F1F5F9]">System Health</h2>
            <p className="text-xs text-[#94A3B8]">Live backend service diagnostics reported from /api/health.</p>
          </div>
          <button
            type="button"
            onClick={() => refreshHealth()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/20 px-3 py-1.5 text-xs text-[#94A3B8] hover:border-[#00F5FF]/50 hover:text-[#F1F5F9]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Recheck
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {healthServices.map((svc) => {
            const isOk = svc.status === 'operational';
            const isDegraded = svc.status === 'degraded';
            return (
              <div
                key={svc.id}
                className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-3.5 flex flex-col justify-between gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#F1F5F9]">{svc.name}</span>
                  {isOk ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[#39FF88]" />
                  ) : isDegraded ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[#FFB020]" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 shrink-0 text-[#FF3864]" />
                  )}
                </div>
                <div
                  className={`font-mono text-[11px] font-semibold ${
                    isOk ? 'text-[#39FF88]' : isDegraded ? 'text-[#FFB020]' : 'text-[#FF3864]'
                  }`}
                >
                  {isOk ? 'Operational' : isDegraded ? 'Degraded' : 'Unavailable'}
                </div>
                <div className="text-[11px] text-[#94A3B8] leading-relaxed">{svc.detail}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Project Overview + Severity Chart + Live Activity Feed */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Project Overview & Severity Chart */}
        <div className="xl:col-span-7 space-y-6">
          <section className="cyber-panel rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-[#F1F5F9]">Active Project Overview</h2>
              {data?.activeProject && (
                <button
                  type="button"
                  onClick={() => navigate('/workbench')}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#00F5FF] hover:underline"
                >
                  Open Code Workbench
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {data?.activeProject ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4 text-[#00F5FF]" />
                    <span className="text-lg font-semibold text-[#F1F5F9]">{data.activeProject.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-[#94A3B8]">{data.activeProject.description || 'Managed AutoPatch AI project.'}</p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#00F5FF]/10 text-xs">
                  <div>
                    <div className="text-[#94A3B8]">Total Files</div>
                    <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[#F1F5F9]">
                      {data.activeProject.totalFiles}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">Detected Bugs</div>
                    <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[#FFB020]">
                      {data.activeProject.detectedBugs}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">Resolved Bugs</div>
                    <div className="mt-1 font-mono text-base font-semibold tabular-nums text-[#39FF88]">
                      {data.activeProject.resolvedBugs}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">Last Scan</div>
                    <div className="mt-1 font-mono text-xs text-[#F1F5F9]">
                      {data.activeProject.lastScanAt
                        ? new Date(data.activeProject.lastScanAt).toLocaleString()
                        : 'Not scanned yet'}
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#00F5FF]/10 flex flex-wrap items-center gap-2 text-xs text-[#94A3B8]">
                  <span>Languages:</span>
                  <span className="font-mono text-[#F1F5F9]">
                    {data.activeProject.languages.length > 0 ? data.activeProject.languages.join(' · ') : 'None detected'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-[#94A3B8]">
                No project selected. Upload a ZIP archive or create a project to begin scanning.
              </div>
            )}
          </section>

          <section className="cyber-panel rounded-xl p-5">
            <h2 className="text-base font-semibold text-[#F1F5F9] mb-1">Bug Distribution by Severity</h2>
            <p className="text-xs text-[#94A3B8] mb-4">Aggregated directly from detected_bugs records in SQLite.</p>
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <XAxis dataKey="name" stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#94A3B8" fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0B1220',
                      borderColor: 'rgba(0, 245, 255, 0.25)',
                      color: '#F1F5F9',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={52}>
                    {chartData.map((entry) => (
                      <Cell key={entry.severity} fill={SEV_COLORS[entry.severity]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        {/* Live Activity Feed */}
        <section className="xl:col-span-5 cyber-panel rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">Live Activity Feed</h2>
              <p className="text-xs text-[#94A3B8]">Verified backend audit events and repairs.</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/audit')}
              className="text-xs font-medium text-[#00F5FF] hover:underline"
            >
              Full Audit Trail
            </button>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto max-h-[500px] pr-1">
            {data?.recentActivity && data.recentActivity.length > 0 ? (
              data.recentActivity.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[#F1F5F9]">
                      {ACTION_LABELS[ev.action_type] || ev.action_type}
                    </span>
                    <span className="font-mono text-[11px] text-[#94A3B8] tabular-nums">
                      {new Date(ev.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-[#94A3B8] leading-relaxed">{ev.details}</div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#94A3B8]/80 font-mono">
                    <span>{ev.project_name}</span>
                    {ev.file_path && (
                      <>
                        <span aria-hidden="true">/</span>
                        <span className="text-[#00F5FF] truncate max-w-[200px]">{ev.file_path}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{ev.user_name}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-12 text-center text-xs text-[#94A3B8]">No recorded events yet.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
