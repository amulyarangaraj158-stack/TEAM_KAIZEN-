import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  Check,
  AlertTriangle,
  CheckCircle2,
  Info,
  ShieldAlert,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { useAppStore, type NotificationItem } from '../store/useAppStore';

export const NotificationsPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    projects,
    refreshNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    addToast,
  } = useAppStore();

  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unread'>('all');

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  const filtered = useMemo(() => {
    return notifications.filter((n) => {
      if (projectFilter !== 'all' && n.project_id !== projectFilter) return false;
      if (statusFilter === 'unread' && n.is_read === 1) return false;
      return true;
    });
  }, [notifications, projectFilter, statusFilter]);

  const handleOpen = async (item: NotificationItem) => {
    if (item.is_read === 0) {
      await markNotificationRead(item.id).catch(() => {});
    }
    if (item.target_route) {
      navigate(item.target_route);
    }
  };

  const handleMarkAll = async () => {
    await markAllNotificationsRead();
    addToast({ type: 'success', title: 'All caught up', message: 'Marked all notifications as read.' });
  };

  const severityIcon = (sev: NotificationItem['severity']) => {
    if (sev === 'critical') return <ShieldAlert className="h-4 w-4 shrink-0 text-[#FF3864]" />;
    if (sev === 'warning') return <AlertTriangle className="h-4 w-4 shrink-0 text-[#FFB020]" />;
    if (sev === 'success') return <CheckCircle2 className="h-4 w-4 shrink-0 text-[#39FF88]" />;
    return <Info className="h-4 w-4 shrink-0 text-[#00F5FF]" />;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F1F5F9]">Notifications</h1>
          <p className="mt-1 text-sm text-[#94A3B8]">
            Real-time operational alerts for scans, critical findings, AI patches, verifications, and rollbacks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshNotifications()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#00F5FF]/25 bg-[#101A2B] px-3 py-2 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]/60"
          >
            <RefreshCw className="h-3.5 w-3.5 text-[#00F5FF]" />
            Sync
          </button>
          <button
            type="button"
            disabled={unreadCount === 0}
            onClick={() => void handleMarkAll()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#00F5FF] px-3.5 py-2 text-xs font-semibold text-[#070B14] transition hover:bg-[#38F8FF] disabled:opacity-40"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark All Read ({unreadCount})
          </button>
        </div>
      </div>

      {/* Filter Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00F5FF]/15 bg-[#101A2B] px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              statusFilter === 'all' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('unread')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              statusFilter === 'unread' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
            }`}
          >
            Unread ({unreadCount})
          </button>
        </div>

        <select
          aria-label="Filter notifications by project"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-3 py-1.5 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
        >
          <option value="all">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Notifications List */}
      <div className="space-y-2.5">
        {filtered.length === 0 ? (
          <div className="cyber-panel rounded-xl p-10 text-center">
            <Bell className="mx-auto h-7 w-7 text-[#64748B]" />
            <p className="mt-2 text-xs text-[#94A3B8]">No notifications match the current filter.</p>
          </div>
        ) : (
          filtered.map((n) => {
            const isUnread = n.is_read === 0;
            return (
              <div
                key={n.id}
                className={`cyber-panel flex flex-col gap-3 rounded-xl p-4 transition sm:flex-row sm:items-center sm:justify-between ${
                  isUnread ? 'border-[#00F5FF]/40 bg-[#142238]/75' : 'opacity-80'
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5">{severityIcon(n.severity)}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#F1F5F9]">{n.title}</h3>
                      {isUnread && <span className="font-mono text-[10px] font-semibold uppercase text-[#00F5FF]">UNREAD</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-[#94A3B8]">{n.message}</p>
                    <div className="mt-1.5 font-mono text-[11px] text-[#64748B] tabular-nums">
                      {n.created_at.slice(0, 19).replace('T', ' ')} · {n.type.replace(/_/g, ' ')}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {isUnread && (
                    <button
                      type="button"
                      onClick={() => void markNotificationRead(n.id)}
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] px-2.5 py-1.5 text-xs text-[#94A3B8] hover:text-[#F1F5F9]"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Mark Read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleOpen(n)}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-[#00F5FF]/35 bg-[#0B1220] px-3 py-1.5 text-xs font-medium text-[#00F5FF] hover:bg-[#142238]"
                  >
                    Inspect
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
