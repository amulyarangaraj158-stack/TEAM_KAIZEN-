import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import { apiFetch, setStoredToken } from '../lib/api';

export interface UserProfile {
  userId: string;
  email: string;
  name: string;
  role: string;
  settings: {
    ladybugEnabled: boolean;
    soundEnabled?: boolean;
    autoSelectProject?: boolean;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  languages: string[];
  total_files: number;
  health_score: number;
  last_scan_at: string | null;
  total_bugs: number;
  resolved_bugs: number;
  critical_bugs: number;
  created_at: string;
  updated_at: string;
}

export interface HealthService {
  id: string;
  name: string;
  status: 'operational' | 'degraded' | 'unavailable';
  detail: string;
}

export interface NotificationItem {
  id: string;
  project_id: string | null;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  message: string;
  target_route: string;
  is_read: number;
  created_at: string;
}

export interface LadybugReaction {
  mode: 'patrol' | 'alert' | 'repaired';
  severity: 'low' | 'medium' | 'high' | 'critical' | 'success';
  label: string;
  timestamp: number;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
}

interface AppState {
  user: UserProfile | null;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  healthServices: HealthService[];
  notifications: NotificationItem[];
  unreadCount: number;
  ladybugEnabled: boolean;
  ladybugReaction: LadybugReaction;
  toasts: ToastItem[];
  socketConnected: boolean;
  initialized: boolean;
  socket: Socket | null;

  initApp: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  setActiveProjectId: (id: string | null) => void;
  setLadybugEnabled: (enabled: boolean) => Promise<void>;
  triggerLadybugReaction: (reaction: Omit<LadybugReaction, 'timestamp'>) => void;
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
  removeToast: (id: string) => void;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  loginUser: (email: string, password: string) => Promise<void>;
  registerUser: (name: string, email: string, password: string) => Promise<void>;
  logoutUser: () => void;
}

let reactionTimer: number | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  projects: [],
  activeProjectId: null,
  healthServices: [],
  notifications: [],
  unreadCount: 0,
  ladybugEnabled: true,
  ladybugReaction: { mode: 'patrol', severity: 'low', label: '', timestamp: 0 },
  toasts: [],
  socketConnected: false,
  initialized: false,
  socket: null,

  addToast: (toast) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  triggerLadybugReaction: (reaction) => {
    if (reactionTimer) window.clearTimeout(reactionTimer);
    set({ ladybugReaction: { ...reaction, timestamp: Date.now() } });
    reactionTimer = window.setTimeout(() => {
      set({ ladybugReaction: { mode: 'patrol', severity: 'low', label: '', timestamp: Date.now() } });
    }, 7500);
  },

  initApp: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    await Promise.all([
      apiFetch<{ user: UserProfile }>('/api/auth/me')
        .then((res) => {
          set({
            user: res.user,
            ladybugEnabled: res.user.settings?.ladybugEnabled !== false,
          });
        })
        .catch(() => {}),
      get().refreshProjects(),
      get().refreshHealth(),
      get().refreshNotifications(),
    ]);

    // Connect real-time Socket.IO
    if (!get().socket) {
      const socket = io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => set({ socketConnected: true }));
      socket.on('disconnect', () => set({ socketConnected: false }));

      socket.on('notification:new', (notif: NotificationItem) => {
        set((s) => {
          if (s.notifications.some((n) => n.id === notif.id)) return s;
          return {
            notifications: [notif, ...s.notifications].slice(0, 60),
            unreadCount: s.unreadCount + 1,
          };
        });
      });

      socket.on(
        'bug:detected',
        (payload: { count: number; criticalCount: number; severity: 'low' | 'medium' | 'high' | 'critical'; projectName: string }) => {
          get().triggerLadybugReaction({
            mode: 'alert',
            severity: payload.severity || 'high',
            label: `${payload.count} bug${payload.count === 1 ? '' : 's'} detected (${payload.severity})`,
          });
        },
      );

      socket.on('bug:repaired', (payload: { filePath: string; title: string }) => {
        get().triggerLadybugReaction({
          mode: 'repaired',
          severity: 'success',
          label: `Verified fix: ${payload.filePath}`,
        });
      });

      set({ socket });
    }
  },

  refreshProjects: async () => {
    try {
      const data = await apiFetch<{ projects: ProjectSummary[] }>('/api/projects');
      set((s) => {
        const stillExists = data.projects.some((p) => p.id === s.activeProjectId);
        return {
          projects: data.projects,
          activeProjectId: stillExists ? s.activeProjectId : (data.projects[0]?.id ?? null),
        };
      });
    } catch {
      // handled in UI
    }
  },

  refreshHealth: async () => {
    try {
      const data = await apiFetch<{ services: HealthService[] }>('/api/health');
      set({ healthServices: data.services });
    } catch {
      set({
        healthServices: [
          { id: 'api', name: 'Backend API', status: 'unavailable', detail: 'Unable to reach /api/health' },
        ],
      });
    }
  },

  refreshNotifications: async () => {
    try {
      const data = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications');
      set({ notifications: data.notifications, unreadCount: data.unreadCount });
    } catch {
      // ignore
    }
  },

  setActiveProjectId: (id) => set({ activeProjectId: id }),

  setLadybugEnabled: async (enabled) => {
    set({ ladybugEnabled: enabled });
    try {
      await apiFetch('/api/auth/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ladybugEnabled: enabled }),
      });
    } catch {
      // keep local preference
    }
  },

  markNotificationRead: async (id) => {
    const res = await apiFetch<{ unreadCount: number }>(`/api/notifications/${id}/read`, { method: 'PATCH' });
    set((s) => ({
      unreadCount: res.unreadCount,
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)),
    }));
  },

  markAllNotificationsRead: async () => {
    await apiFetch('/api/notifications/read-all', { method: 'POST' });
    set((s) => ({
      unreadCount: 0,
      notifications: s.notifications.map((n) => ({ ...n, is_read: 1 })),
    }));
  },

  loginUser: async (email, password) => {
    const res = await apiFetch<{ token: string; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setStoredToken(res.token);
    set({ user: res.user, ladybugEnabled: res.user.settings?.ladybugEnabled !== false });
    await get().refreshNotifications();
  },

  registerUser: async (name, email, password) => {
    const res = await apiFetch<{ token: string; user: UserProfile }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
    setStoredToken(res.token);
    set({ user: { ...res.user, settings: { ladybugEnabled: true } } });
    await get().refreshNotifications();
  },

  logoutUser: () => {
    setStoredToken(null);
    get().addToast({ type: 'info', title: 'Signed out', message: 'Reverted to default local workspace session.' });
    apiFetch<{ user: UserProfile }>('/api/auth/me')
      .then((res) => set({ user: res.user }))
      .catch(() => {});
  },
}));
