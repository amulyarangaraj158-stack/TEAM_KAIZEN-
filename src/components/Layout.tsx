import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  Brain,
  ChevronLeft,
  ChevronRight,
  Code2,
  Film,
  FolderGit2,
  Globe,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Radar,
  Search,
  Settings,
  ShieldCheck,
  UploadCloud,
  User,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { Ladybug3D } from './Ladybug3D';

const NAV_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/projects', label: 'My Projects', icon: FolderGit2 },
      { to: '/upload', label: 'Upload & Scan', icon: UploadCloud },
      { to: '/workbench', label: 'Code Workbench', icon: Code2 },
    ],
  },
  {
    label: 'AI Intelligence',
    items: [
      { to: '/intelligence', label: 'Bug Intelligence', icon: Brain },
      { to: '/radar', label: 'Code Impact Radar', icon: Radar },
      { to: '/website-debugger', label: 'Website Debugger', icon: Globe },
      { to: '/multimedia-debugger', label: 'Multimedia Debugger', icon: Film },
    ],
  },
  {
    label: 'Management',
    items: [
      { to: '/audit', label: 'Patch Audit Trail', icon: History },
      { to: '/notifications', label: 'Notifications', icon: Bell },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

interface SearchResults {
  projects: Array<{ id: string; name: string; health_score: number }>;
  files: Array<{ id: string; project_id: string; relative_path: string; language: string }>;
  bugs: Array<{ id: string; project_id: string; file_path: string; title: string; severity: string }>;
  learning: Array<{ id: string; project_id: string; title: string; category: string }>;
}

export const Layout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    user,
    projects,
    activeProjectId,
    setActiveProjectId,
    healthServices,
    unreadCount,
    toasts,
    removeToast,
    initApp,
    loginUser,
    registerUser,
    logoutUser,
    addToast,
  } = useAppStore();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    initApp();
  }, [initApp]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<SearchResults>(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`);
        setSearchResults(res);
      } catch {
        setSearchResults(null);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const unavailableCount = healthServices.filter((s) => s.status !== 'operational').length;
  const healthLabel =
    healthServices.length === 0
      ? 'Checking'
      : unavailableCount === 0
        ? 'All Systems Operational'
        : `${unavailableCount} Service${unavailableCount === 1 ? '' : 's'} Limited`;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      if (authMode === 'login') {
        await loginUser(authEmail, authPassword);
        addToast({ type: 'success', title: 'Signed in', message: `Welcome back, ${authEmail}.` });
      } else {
        await registerUser(authName, authEmail, authPassword);
        addToast({ type: 'success', title: 'Account created', message: 'JWT session initialized.' });
      }
      setAuthModalOpen(false);
      setAuthPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const renderSidebarNav = (isMobile = false) => (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between border-b border-[#00F5FF]/15 px-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00F5FF] rounded"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#00F5FF]/40 bg-[#00F5FF]/10 text-[#00F5FF]">
            <ShieldCheck className="h-4 w-4" />
          </div>
          {(!collapsed || isMobile) && (
            <span className="text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap">
              AutoPatch <span className="text-[#00F5FF]">AI</span>
            </span>
          )}
        </button>
        {isMobile ? (
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
            className="rounded-md p-1.5 text-[#94A3B8] hover:bg-[#142238] hover:text-[#F1F5F9]"
          >
            <X className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-md p-1.5 text-[#94A3B8] hover:bg-[#142238] hover:text-[#F1F5F9]"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {(!collapsed || isMobile) && (
              <div className="mb-2 px-2.5 text-[11px] font-semibold tracking-wider text-[#94A3B8]/80">
                {group.label}
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed && !isMobile ? item.label : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#00F5FF]/12 text-[#00F5FF] border border-[#00F5FF]/25'
                          : 'text-[#94A3B8] border border-transparent hover:bg-[#142238]/80 hover:text-[#F1F5F9]'
                      }`
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {(!collapsed || isMobile) && <span className="truncate">{item.label}</span>}
                    {(!collapsed || isMobile) && item.to === '/notifications' && unreadCount > 0 && (
                      <span className="ml-auto font-mono text-xs font-semibold tabular-nums text-[#00F5FF]">
                        {unreadCount}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="cyber-grid-bg min-h-screen flex text-[#F1F5F9]">
      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 border-r border-[#00F5FF]/14 bg-[#0B1220]/95 transition-[width] duration-200 ${
          collapsed ? 'w-[72px]' : 'w-[252px]'
        }`}
      >
        {renderSidebarNav(false)}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-10 w-68 bg-[#0B1220] border-r border-[#00F5FF]/20">
            {renderSidebarNav(true)}
          </aside>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Navigation Bar */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-[#00F5FF]/14 bg-[#0B1220]/95 px-4 lg:px-6">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden rounded-lg border border-[#00F5FF]/20 p-2 text-[#F1F5F9] hover:bg-[#142238]"
            >
              <Menu className="h-4 w-4" />
            </button>

            {/* Global Search */}
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
              <input
                type="search"
                aria-label="Global search"
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => window.setTimeout(() => setSearchOpen(false), 180)}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects, files, bugs, or learning records..."
                className="w-full rounded-lg border border-[#00F5FF]/16 bg-[#070B14] py-2 pl-9 pr-3 text-sm text-[#F1F5F9] placeholder:text-[#94A3B8]/70 focus:border-[#00F5FF]/60 focus:outline-none"
              />
              {searchOpen && searchResults && searchQuery.trim().length >= 2 && (
                <div className="absolute left-0 right-0 top-full mt-2 max-h-96 overflow-y-auto rounded-lg border border-[#00F5FF]/25 bg-[#101A2B] p-2 shadow-2xl z-40">
                  {searchResults.projects.length === 0 &&
                  searchResults.files.length === 0 &&
                  searchResults.bugs.length === 0 &&
                  searchResults.learning.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-[#94A3B8]">No matching records found.</div>
                  ) : (
                    <div className="space-y-3 text-xs">
                      {searchResults.projects.length > 0 && (
                        <div>
                          <div className="px-2 pb-1 font-semibold text-[#94A3B8]">Projects</div>
                          {searchResults.projects.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onMouseDown={() => {
                                setActiveProjectId(p.id);
                                navigate('/projects');
                              }}
                              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-[#142238]"
                            >
                              <span className="font-medium text-[#F1F5F9]">{p.name}</span>
                              <span className="font-mono text-[#00F5FF] tabular-nums">Health {p.health_score}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {searchResults.bugs.length > 0 && (
                        <div>
                          <div className="px-2 pb-1 font-semibold text-[#94A3B8]">Detected Bugs</div>
                          {searchResults.bugs.map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              onMouseDown={() => {
                                setActiveProjectId(b.project_id);
                                navigate(`/workbench?bugId=${b.id}`);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-[#142238]"
                            >
                              <span className="truncate text-[#F1F5F9]">{b.title}</span>
                              <span className="font-mono text-[#FFB020] shrink-0">{b.severity}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {searchResults.files.length > 0 && (
                        <div>
                          <div className="px-2 pb-1 font-semibold text-[#94A3B8]">Source Files</div>
                          {searchResults.files.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              onMouseDown={() => {
                                setActiveProjectId(f.project_id);
                                navigate(`/workbench?file=${encodeURIComponent(f.relative_path)}`);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-[#142238]"
                            >
                              <span className="font-mono truncate text-[#F1F5F9]">{f.relative_path}</span>
                              <span className="text-[#94A3B8] shrink-0">{f.language}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {/* Active Project Selector */}
            <label className="hidden md:flex items-center gap-2 text-xs text-[#94A3B8]">
              <span className="sr-only">Active project</span>
              <select
                aria-label="Select active project"
                value={activeProjectId ?? ''}
                onChange={(e) => setActiveProjectId(e.target.value || null)}
                className="max-w-[200px] truncate rounded-lg border border-[#00F5FF]/20 bg-[#101A2B] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
              >
                {projects.length === 0 ? (
                  <option value="">No projects</option>
                ) : (
                  projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </label>

            {/* Real System Health Status */}
            <button
              type="button"
              onClick={() => navigate('/settings')}
              title={healthLabel}
              className="hidden xl:flex items-center gap-2 rounded-lg border border-[#00F5FF]/16 bg-[#101A2B] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]/40 whitespace-nowrap"
            >
              <Activity
                className={`h-3.5 w-3.5 ${unavailableCount === 0 ? 'text-[#39FF88]' : 'text-[#FFB020]'}`}
              />
              <span>{unavailableCount === 0 ? 'Healthy' : `${unavailableCount} Degraded`}</span>
            </button>

            {/* Notifications Button */}
            <button
              type="button"
              aria-label={`Notifications (${unreadCount} unread)`}
              onClick={() => navigate('/notifications')}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-[#00F5FF]/16 bg-[#101A2B] text-[#F1F5F9] hover:border-[#00F5FF]/45"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF3864] px-1 font-mono text-[10px] font-bold text-white tabular-nums">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Settings Button */}
            <button
              type="button"
              aria-label="Open settings"
              onClick={() => navigate('/settings')}
              className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg border border-[#00F5FF]/16 bg-[#101A2B] text-[#94A3B8] hover:border-[#00F5FF]/45 hover:text-[#F1F5F9]"
            >
              <Settings className="h-4 w-4" />
            </button>

            {/* User Profile */}
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-[#00F5FF]/20 bg-[#101A2B] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]/50 whitespace-nowrap"
            >
              <User className="h-3.5 w-3.5 text-[#00F5FF]" />
              <span className="hidden sm:inline max-w-[110px] truncate">{user?.name || 'Engineer'}</span>
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-4 md:p-6 lg:p-8 max-w-[1600px] w-full mx-auto">
          <Outlet />
        </main>
      </div>

      {/* Interactive 3D Cyberpunk Ladybug (Non-obstructive, connected to real backend events) */}
      <Ladybug3D />

      {/* Toast Stack */}
      <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-xs shadow-xl bg-[#101A2B] ${
              toast.type === 'error'
                ? 'border-[#FF3864]/50 text-[#F1F5F9]'
                : toast.type === 'success'
                  ? 'border-[#39FF88]/50 text-[#F1F5F9]'
                  : toast.type === 'warning'
                    ? 'border-[#FFB020]/50 text-[#F1F5F9]'
                    : 'border-[#00F5FF]/40 text-[#F1F5F9]'
            }`}
          >
            <div>
              <div className="font-semibold">{toast.title}</div>
              {toast.message && <div className="mt-0.5 text-[#94A3B8]">{toast.message}</div>}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => removeToast(toast.id)}
              className="text-[#94A3B8] hover:text-[#F1F5F9]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Authentication / Account Modal */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-dialog-title"
            className="w-full max-w-md rounded-xl border border-[#00F5FF]/25 bg-[#101A2B] p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 id="auth-dialog-title" className="text-lg font-semibold text-[#F1F5F9]">
                Account & JWT Session
              </h2>
              <button
                type="button"
                aria-label="Close account modal"
                onClick={() => setAuthModalOpen(false)}
                className="rounded p-1 text-[#94A3B8] hover:text-[#F1F5F9]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {user && (
              <div className="mb-5 rounded-lg border border-[#00F5FF]/15 bg-[#0B1220] p-3 text-xs">
                <div className="text-[#94A3B8]">Signed in as</div>
                <div className="mt-1 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-[#F1F5F9]">{user.name}</div>
                    <div className="font-mono text-[#94A3B8]">{user.email} · {user.role}</div>
                  </div>
                  <button
                    type="button"
                    onClick={logoutUser}
                    className="inline-flex items-center gap-1 rounded-md border border-[#FF3864]/35 px-2.5 py-1.5 text-xs text-[#FF3864] hover:bg-[#FF3864]/10"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign Out
                  </button>
                </div>
              </div>
            )}

            <div className="mb-4 flex gap-1 rounded-lg bg-[#070B14] p-1">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError('');
                }}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  authMode === 'login' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setAuthError('');
                }}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  authMode === 'register' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Create Account
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {authMode === 'register' && (
                <div>
                  <label htmlFor="auth-name" className="block text-xs text-[#94A3B8] mb-1">
                    Full Name
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    required
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    placeholder="Alex Chen"
                    className="w-full rounded-lg border border-[#00F5FF]/20 bg-[#070B14] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
                  />
                </div>
              )}
              <div>
                <label htmlFor="auth-email" className="block text-xs text-[#94A3B8] mb-1">
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="alex.chen@autopatch.dev"
                  className="w-full rounded-lg border border-[#00F5FF]/20 bg-[#070B14] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="auth-password" className="block text-xs text-[#94A3B8] mb-1">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={8}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full rounded-lg border border-[#00F5FF]/20 bg-[#070B14] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
                />
              </div>
              {authError && <div className="text-xs text-[#FF3864]">{authError}</div>}
              <button
                type="submit"
                disabled={authBusy}
                className="w-full rounded-lg bg-[#00F5FF] py-2.5 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50"
              >
                {authBusy ? 'Authenticating...' : authMode === 'login' ? 'Sign In with JWT' : 'Register Account'}
              </button>
              <p className="text-[11px] text-[#94A3B8]">
                Demo credentials: <span className="font-mono text-[#F1F5F9]">alex.chen@autopatch.dev</span> /{' '}
                <span className="font-mono text-[#F1F5F9]">AutoPatch2026!</span>
              </p>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
