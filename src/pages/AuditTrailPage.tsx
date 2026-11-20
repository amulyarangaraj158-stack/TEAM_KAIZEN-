import React, { useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Download,
  Filter,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  History,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { CodeDiffPanel } from '../components/CodeEditorPanel';

interface AuditEvent {
  id: string;
  user_id: string | null;
  user_name: string;
  project_id: string | null;
  project_name: string;
  bug_id: string | null;
  bug_category: string;
  fix_id: string | null;
  snapshot_id: string | null;
  action_type: string;
  action_status: string;
  risk_level: string;
  confidence_score: number | null;
  risk_score: number | null;
  file_path: string;
  original_code: string;
  proposed_code: string;
  approved_code: string;
  validation_result: string;
  details: string;
  created_at: string;
}

const ACTION_TYPES = [
  'all',
  'bug_detected',
  'patch_generated',
  'patch_modified',
  'patch_applied',
  'patch_rejected',
  'patch_rolled_back',
  'project_uploaded',
];

const RISK_LEVELS = ['all', 'Low', 'Medium', 'High', 'Critical'];

function inferLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.json')) return 'json';
  return 'plaintext';
}

export const AuditTrailPage: React.FC = () => {
  const { projects, addToast } = useAppStore();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('all');
  const [actionType, setActionType] = useState('all');
  const [riskLevel, setRiskLevel] = useState('all');
  const [bugCategory, setBugCategory] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const loadAudit = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectId !== 'all') params.set('projectId', projectId);
      if (actionType !== 'all') params.set('actionType', actionType);
      if (riskLevel !== 'all') params.set('riskLevel', riskLevel);
      if (bugCategory !== 'all') params.set('bugCategory', bugCategory);
      if (userFilter !== 'all') params.set('user', userFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);

      const res = await apiFetch<{ events: AuditEvent[] }>(`/api/audit?${params.toString()}`);
      setEvents(res.events);
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Failed to load audit trail',
        message: err instanceof Error ? err.message : 'Unable to fetch audit records.',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAudit();
  }, [projectId, actionType, riskLevel, bugCategory, userFilter, dateFrom, dateTo]);

  const uniqueCategories = useMemo(
    () => ['all', ...Array.from(new Set(events.map((e) => e.bug_category).filter(Boolean)))],
    [events],
  );
  const uniqueUsers = useMemo(
    () => ['all', ...Array.from(new Set(events.map((e) => e.user_name).filter(Boolean)))],
    [events],
  );

  const handleExportCsv = () => {
    const query = projectId !== 'all' ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const link = document.createElement('a');
    link.href = `/api/audit/export.csv${query}`;
    link.download = 'autopatch-audit-trail.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    addToast({ type: 'success', title: 'CSV Export Started', message: 'Downloading immutable audit trail CSV.' });
  };

  const handleExportPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFillColor(7, 11, 20);
    doc.rect(0, 0, 842, 64, 'F');
    doc.setTextColor(0, 245, 255);
    doc.setFontSize(16);
    doc.text('AutoPatch AI — Patch Audit Trail Report', 32, 34);
    doc.setTextColor(148, 163, 184);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toISOString()}   |   Total Events: ${events.length}`, 32, 50);

    let y = 90;
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(8.5);

    const colX = [32, 145, 245, 340, 445, 535, 610];
    const headers = ['Timestamp', 'Action', 'User', 'Project', 'File', 'Risk / Score', 'Details'];
    doc.setFont('helvetica', 'bold');
    headers.forEach((h, idx) => doc.text(h, colX[idx], y));
    y += 14;
    doc.line(32, y - 6, 810, y - 6);
    doc.setFont('helvetica', 'normal');

    for (const ev of events.slice(0, 80)) {
      if (y > 550) {
        doc.addPage();
        y = 48;
      }
      const ts = ev.created_at.slice(0, 19).replace('T', ' ');
      const scoreStr =
        ev.confidence_score !== null ? `${ev.risk_level} (${ev.confidence_score}%)` : ev.risk_level || '-';
      doc.text(ts, colX[0], y);
      doc.text(ev.action_type.slice(0, 18), colX[1], y);
      doc.text((ev.user_name || '-').slice(0, 16), colX[2], y);
      doc.text((ev.project_name || '-').slice(0, 18), colX[3], y);
      doc.text((ev.file_path || '-').slice(0, 16), colX[4], y);
      doc.text(scoreStr.slice(0, 14), colX[5], y);
      doc.text((ev.details || '').slice(0, 38), colX[6], y);
      y += 15;
    }

    doc.save('autopatch-audit-report.pdf');
    addToast({ type: 'success', title: 'PDF Generated', message: `Exported ${Math.min(events.length, 80)} audit record(s) to PDF.` });
  };

  const riskTextClass = (level: string) => {
    const l = level.toLowerCase();
    if (l === 'critical') return 'text-[#FF3864]';
    if (l === 'high') return 'text-[#FFB020]';
    if (l === 'medium') return 'text-[#00F5FF]';
    return 'text-[#39FF88]';
  };

  const actionColor = (action: string) => {
    if (action === 'patch_applied') return 'text-[#39FF88]';
    if (action === 'patch_rolled_back' || action === 'patch_rejected') return 'text-[#FFB020]';
    if (action === 'bug_detected') return 'text-[#FF3864]';
    return 'text-[#00F5FF]';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F1F5F9]">Patch Audit Trail</h1>
          <p className="mt-1 text-sm text-[#94A3B8]">
            Immutable compliance history of bug detections, AI patch generations, manual modifications, approvals, verifications, and rollbacks.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void loadAudit()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#00F5FF]/25 bg-[#101A2B] px-3 py-2 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]/60"
          >
            <RefreshCw className="h-3.5 w-3.5 text-[#00F5FF]" />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#00F5FF]/35 bg-[#101A2B] px-3 py-2 text-xs font-semibold text-[#00F5FF] hover:bg-[#142238]"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#A855F7] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#B975F9]"
          >
            <FileText className="h-3.5 w-3.5" />
            Export PDF
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="cyber-panel rounded-xl p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
          <Filter className="h-3.5 w-3.5 text-[#00F5FF]" />
          Audit Filters
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <select
            aria-label="Filter by project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by action type"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            {ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'all' ? 'All Actions' : t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by risk level"
            value={riskLevel}
            onChange={(e) => setRiskLevel(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>
                {r === 'all' ? 'All Risk Levels' : `${r} Risk`}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by bug category"
            value={bugCategory}
            onChange={(e) => setBugCategory(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            {uniqueCategories.map((c) => (
              <option key={c} value={c}>
                {c === 'all' ? 'All Categories' : c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by user"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          >
            {uniqueUsers.map((u) => (
              <option key={u} value={u}>
                {u === 'all' ? 'All Users' : u}
              </option>
            ))}
          </select>

          <input
            type="date"
            aria-label="Date from"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          />

          <input
            type="date"
            aria-label="Date to"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          />
        </div>
      </div>

      {/* Audit Table */}
      <div className="cyber-panel overflow-hidden rounded-xl">
        <div className="flex items-center justify-between border-b border-[#00F5FF]/15 px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#F1F5F9]">
            <ShieldCheck className="h-4 w-4 text-[#39FF88]" />
            Verified Ledger Records
          </div>
          <span className="font-mono text-xs text-[#94A3B8] tabular-nums">{events.length} event(s)</span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs text-[#94A3B8]">Loading audit ledger...</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center">
            <History className="mx-auto h-7 w-7 text-[#64748B]" />
            <p className="mt-2 text-xs text-[#94A3B8]">No audit events match the selected filters.</p>
          </div>
        ) : (
          <div className="divide-y divide-[#00F5FF]/10">
            {events.map((ev) => {
              const isOpen = expandedId === ev.id;
              const hasDiff = Boolean(ev.original_code && (ev.approved_code || ev.proposed_code));
              return (
                <div key={ev.id} className="bg-[#101A2B]/60">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : ev.id)}
                    className="grid w-full grid-cols-12 items-center gap-2 px-4 py-3 text-left text-xs transition hover:bg-[#142238]/80"
                  >
                    <div className="col-span-12 flex items-center gap-2 sm:col-span-3">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#00F5FF]" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#64748B]" />
                      )}
                      <span className={`font-mono font-semibold uppercase ${actionColor(ev.action_type)}`}>
                        {ev.action_type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="col-span-6 truncate text-[#F1F5F9] sm:col-span-2">{ev.project_name || 'Workspace'}</div>
                    <div className="col-span-6 truncate font-mono text-[#00F5FF] sm:col-span-3">
                      {ev.file_path || ev.bug_category}
                    </div>
                    <div className="col-span-6 sm:col-span-2 font-mono tabular-nums">
                      <span className={`font-semibold ${riskTextClass(ev.risk_level)}`}>{ev.risk_level || 'Low'}</span>
                      {ev.confidence_score !== null && (
                        <span className="ml-2 text-[#94A3B8]">Conf {ev.confidence_score}%</span>
                      )}
                    </div>
                    <div className="col-span-6 text-right font-mono text-[11px] text-[#94A3B8] tabular-nums sm:col-span-2">
                      {ev.created_at.slice(0, 19).replace('T', ' ')}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="space-y-3 border-t border-[#00F5FF]/10 bg-[#0B1220] px-5 py-4 text-xs">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 font-mono">
                        <div>
                          <div className="text-[10px] uppercase text-[#64748B]">Actor</div>
                          <div className="mt-0.5 text-[#F1F5F9]">{ev.user_name}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-[#64748B]">Category / Status</div>
                          <div className="mt-0.5 text-[#F1F5F9]">
                            {ev.bug_category} · {ev.action_status}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-[#64748B]">Snapshot / Fix ID</div>
                          <div className="mt-0.5 text-[#00F5FF]">{ev.snapshot_id || ev.fix_id || ev.bug_id || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-[#64748B]">Validation</div>
                          <div className="mt-0.5 text-[#39FF88]">{ev.validation_result || 'Recorded'}</div>
                        </div>
                      </div>
                      <p className="text-[#94A3B8]">{ev.details}</p>

                      {hasDiff ? (
                        <div className="pt-2">
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#94A3B8]">
                            Before / After Code Diff
                          </div>
                          <CodeDiffPanel
                            original={ev.original_code}
                            modified={ev.approved_code || ev.proposed_code}
                            language={inferLanguage(ev.file_path)}
                            height="280px"
                          />
                        </div>
                      ) : ev.original_code ? (
                        <pre className="overflow-x-auto rounded border border-[#00F5FF]/15 bg-[#070B14] p-3 font-mono text-[11px] text-[#F1F5F9]">
                          {ev.original_code}
                        </pre>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
