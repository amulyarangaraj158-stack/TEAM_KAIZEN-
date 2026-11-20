import React, { useEffect, useState } from 'react';
import {
  User,
  Bug,
  Activity,
  Cpu,
  Shield,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Save,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface LanguageCapability {
  language: string;
  extensions: string[];
  supportLevel: 'full-ast' | 'parser-static' | 'pattern-static';
  compilerOrParser: string;
  installed: boolean;
  details: string;
}

export const SettingsPage: React.FC = () => {
  const {
    user,
    healthServices,
    ladybugEnabled,
    setLadybugEnabled,
    refreshHealth,
    addToast,
  } = useAppStore();

  const [displayName, setDisplayName] = useState(user?.name ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [capabilities, setCapabilities] = useState<LanguageCapability[]>([]);
  const [loadingCaps, setLoadingCaps] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    if (user?.name) setDisplayName(user.name);
  }, [user?.name]);

  useEffect(() => {
    apiFetch<{ capabilities: LanguageCapability[] }>('/api/capabilities')
      .then((res) => setCapabilities(res.capabilities))
      .catch(() => {})
      .finally(() => setLoadingCaps(false));
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || displayName.trim().length < 2) {
      addToast({ type: 'error', title: 'Invalid name', message: 'Display name must be at least 2 characters.' });
      return;
    }
    setSavingProfile(true);
    try {
      await apiFetch('/api/auth/settings', {
        method: 'PATCH',
        body: JSON.stringify({ name: displayName.trim(), ladybugEnabled }),
      });
      addToast({ type: 'success', title: 'Settings saved', message: 'Profile and preferences persisted to database.' });
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Save failed',
        message: err instanceof Error ? err.message : 'Unable to save settings.',
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleToggleLadybug = async () => {
    const next = !ladybugEnabled;
    await setLadybugEnabled(next);
    addToast({
      type: 'info',
      title: next ? '3D Ladybug Companion Enabled' : '3D Ladybug Companion Disabled',
      message: 'Preference saved to your workspace profile.',
    });
  };

  const handleRecheckHealth = async () => {
    setRechecking(true);
    await refreshHealth();
    setRechecking(false);
    addToast({ type: 'info', title: 'System Health Updated', message: 'Verified live status of all backend services.' });
  };

  const statusIcon = (status: string) => {
    if (status === 'operational') return <CheckCircle2 className="h-4 w-4 text-[#39FF88]" />;
    if (status === 'degraded') return <AlertTriangle className="h-4 w-4 text-[#FFB020]" />;
    return <XCircle className="h-4 w-4 text-[#FF3864]" />;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-[#F1F5F9]">Settings & Diagnostics</h1>
        <p className="mt-1 text-sm text-[#94A3B8]">
          Workspace preferences, live backend health checks, honest multi-language analyzer capabilities, and security posture.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Account & Companion Preferences */}
        <div className="cyber-panel rounded-xl p-5 space-y-5">
          <div className="flex items-center gap-2 border-b border-[#00F5FF]/15 pb-3">
            <User className="h-4 w-4 text-[#00F5FF]" />
            <h2 className="text-sm font-semibold text-[#F1F5F9]">Workspace Profile & Interface</h2>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#94A3B8]">Engineer Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                <div className="text-[10px] uppercase text-[#64748B]">Account Email</div>
                <div className="mt-1 truncate text-[#F1F5F9]">{user?.email || 'Local Workspace'}</div>
              </div>
              <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3">
                <div className="text-[10px] uppercase text-[#64748B]">Role</div>
                <div className="mt-1 uppercase text-[#00F5FF]">{user?.role || 'engineer'}</div>
              </div>
            </div>

            {/* 3D Ladybug Toggle */}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] p-3.5">
              <div className="flex items-start gap-3">
                <Bug className="mt-0.5 h-4 w-4 shrink-0 text-[#FF3864]" />
                <div>
                  <div className="text-xs font-semibold text-[#F1F5F9]">3D Cyberpunk Ladybug Animation</div>
                  <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                    Interactive Three.js robotic companion that patrols non-obstructively and reacts to real bug detection and verified repair events.
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={ladybugEnabled}
                aria-label="Toggle 3D Ladybug Animation"
                onClick={() => void handleToggleLadybug()}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  ladybugEnabled ? 'bg-[#00F5FF]' : 'bg-[#1E293B]'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-[#070B14] transition-transform ${
                    ladybugEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <button
              type="submit"
              disabled={savingProfile}
              className="inline-flex items-center gap-2 rounded-lg bg-[#00F5FF] px-4 py-2 text-xs font-semibold text-[#070B14] hover:bg-[#38F8FF] disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingProfile ? 'Saving...' : 'Save Preferences'}
            </button>
          </form>
        </div>

        {/* Real System Health */}
        <div className="cyber-panel rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#00F5FF]/15 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#39FF88]" />
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Live System Health</h2>
            </div>
            <button
              type="button"
              disabled={rechecking}
              onClick={() => void handleRecheckHealth()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/25 bg-[#0B1220] px-2.5 py-1 text-xs text-[#00F5FF] hover:bg-[#142238]"
            >
              <RefreshCw className={`h-3 w-3 ${rechecking ? 'animate-spin' : ''}`} />
              Recheck
            </button>
          </div>

          <div className="space-y-2.5">
            {healthServices.map((svc) => (
              <div
                key={svc.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] px-3.5 py-3"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="mt-0.5">{statusIcon(svc.status)}</div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#F1F5F9]">{svc.name}</div>
                    <div className="mt-0.5 text-[11px] text-[#94A3B8] break-words">{svc.detail}</div>
                  </div>
                </div>
                <span
                  className={`shrink-0 font-mono text-[10px] font-semibold uppercase ${
                    svc.status === 'operational'
                      ? 'text-[#39FF88]'
                      : svc.status === 'degraded'
                        ? 'text-[#FFB020]'
                        : 'text-[#FF3864]'
                  }`}
                >
                  {svc.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Multi-Language Capability Matrix */}
      <div className="cyber-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#00F5FF]/15 pb-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-[#A855F7]" />
            <h2 className="text-sm font-semibold text-[#F1F5F9]">Multi-Language Code Analysis Capability Matrix</h2>
          </div>
          <span className="font-mono text-xs text-[#94A3B8] tabular-nums">
            {capabilities.filter((c) => c.supportLevel === 'full-ast').length} Full AST/Compiler ·{' '}
            {capabilities.filter((c) => c.supportLevel !== 'full-ast').length} Static Rule Engine
          </span>
        </div>

        {loadingCaps ? (
          <p className="text-xs text-[#94A3B8]">Probing local runtime toolchains...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#00F5FF]/15 text-[11px] uppercase text-[#64748B]">
                  <th className="py-2 pr-4">Language</th>
                  <th className="py-2 pr-4">Extensions</th>
                  <th className="py-2 pr-4">Verification Depth</th>
                  <th className="py-2 pr-4">Engine</th>
                  <th className="py-2">Honest Runtime Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#00F5FF]/10">
                {capabilities.map((cap) => (
                  <tr key={cap.language}>
                    <td className="py-2.5 pr-4 font-semibold text-[#F1F5F9] whitespace-nowrap">{cap.language}</td>
                    <td className="py-2.5 pr-4 font-mono text-[#94A3B8]">{cap.extensions.join(', ')}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap font-mono text-[11px] font-semibold">
                      <span
                        className={
                          cap.supportLevel === 'full-ast'
                            ? 'text-[#39FF88]'
                            : cap.supportLevel === 'parser-static'
                              ? 'text-[#00F5FF]'
                              : 'text-[#FFB020]'
                        }
                      >
                        {cap.supportLevel === 'full-ast'
                          ? 'FULL AST / COMPILER'
                          : cap.supportLevel === 'parser-static'
                            ? 'PARSER + STATIC'
                            : 'STATIC PATTERN'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[#F1F5F9] whitespace-nowrap">{cap.compilerOrParser}</td>
                    <td className="py-2.5 text-[#94A3B8]">{cap.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Security Controls Summary */}
      <div className="cyber-panel rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 border-b border-[#00F5FF]/15 pb-3">
          <Shield className="h-4 w-4 text-[#00F5FF]" />
          <h2 className="text-sm font-semibold text-[#F1F5F9]">Active Security & Safe-Patching Guardrails</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs">
          <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3.5">
            <div className="font-semibold text-[#F1F5F9]">SSRF & Archive Hardening</div>
            <p className="mt-1 text-[#94A3B8]">
              Website Debugger resolves DNS and blocks loopback, RFC-1918 private, link-local, and cloud metadata IPs on every redirect hop. ZIP extraction blocks path traversal, symlinks, and zip bombs.
            </p>
          </div>
          <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3.5">
            <div className="font-semibold text-[#F1F5F9]">Non-Executing Code Analysis</div>
            <p className="mt-1 text-[#94A3B8]">
              Uploaded user source files are never executed. JS/TS uses esbuild parser, Python runs isolated AST parsing, and C/C++ invokes syntax-only checking.
            </p>
          </div>
          <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3.5">
            <div className="font-semibold text-[#F1F5F9]">Approval Gate & SHA-256 Rollback</div>
            <p className="mt-1 text-[#94A3B8]">
              AI patches are never silently applied. Every approved fix stores a pre-patch SHA-256 snapshot and detects file-modification conflicts before rollback.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
