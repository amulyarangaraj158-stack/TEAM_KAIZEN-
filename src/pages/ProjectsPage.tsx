import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Code2, FolderPlus, Radar, Trash2, UploadCloud } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

export const ProjectsPage: React.FC = () => {
  const navigate = useNavigate();
  const { projects, activeProjectId, setActiveProjectId, refreshProjects, addToast } = useAppStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setCreating(true);
    try {
      const res = await apiFetch<{ project: { id: string; name: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      await refreshProjects();
      setActiveProjectId(res.project.id);
      setName('');
      setDescription('');
      addToast({ type: 'success', title: 'Project created', message: `${res.project.name} is now active.` });
    } catch (err) {
      addToast({ type: 'error', title: 'Could not create project', message: err instanceof Error ? err.message : '' });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      await refreshProjects();
      addToast({ type: 'info', title: 'Project deleted' });
    } catch (err) {
      addToast({ type: 'error', title: 'Delete failed', message: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F1F5F9]">My Projects</h1>
          <p className="text-sm text-[#94A3B8]">
            Manage tracked repositories, inspect project health scores, and switch the active command workspace.
          </p>
        </div>
      </div>

      {/* Create Project Form */}
      <form onSubmit={handleCreate} className="cyber-panel rounded-xl p-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
        <div className="md:col-span-4">
          <label htmlFor="project-name" className="block text-xs font-medium text-[#94A3B8] mb-1.5">
            New Project Name
          </label>
          <input
            id="project-name"
            type="text"
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Auth Gateway Service"
            className="w-full rounded-lg border border-[#00F5FF]/20 bg-[#070B14] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          />
        </div>
        <div className="md:col-span-5">
          <label htmlFor="project-desc" className="block text-xs font-medium text-[#94A3B8] mb-1.5">
            Description
          </label>
          <input
            id="project-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional summary of services or stack"
            className="w-full rounded-lg border border-[#00F5FF]/20 bg-[#070B14] px-3 py-2 text-sm text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
          />
        </div>
        <div className="md:col-span-3">
          <button
            type="submit"
            disabled={creating}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#00F5FF] px-4 py-2 text-sm font-semibold text-[#070B14] hover:bg-[#00F5FF]/90 disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            {creating ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>

      {/* Projects Grid */}
      {projects.length === 0 ? (
        <div className="cyber-panel rounded-xl p-12 text-center">
          <p className="text-sm text-[#94A3B8]">No projects exist yet. Create your first project above.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            return (
              <div
                key={p.id}
                className={`cyber-panel rounded-xl p-5 flex flex-col justify-between gap-4 transition-colors ${
                  isActive ? 'border-[#00F5FF]/55 bg-[#142238]/70' : ''
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-[#F1F5F9]">{p.name}</h2>
                      <p className="text-xs text-[#94A3B8] mt-0.5">{p.description || 'No description provided.'}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-xl font-bold tabular-nums text-[#00F5FF]">{p.health_score}%</div>
                      <div className="text-[11px] text-[#94A3B8]">Health Score</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#94A3B8] font-mono pt-1">
                    <span>{p.total_files} files</span>
                    <span aria-hidden="true">·</span>
                    <span>{p.total_bugs} bugs</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#39FF88]">{p.resolved_bugs} fixed</span>
                    <span aria-hidden="true">·</span>
                    <span className={p.critical_bugs > 0 ? 'text-[#FF3864]' : 'text-[#94A3B8]'}>
                      {p.critical_bugs} critical open
                    </span>
                  </div>

                  <div className="text-xs text-[#94A3B8]">
                    Languages:{' '}
                    <span className="font-mono text-[#F1F5F9]">
                      {p.languages.length > 0 ? p.languages.join(', ') : 'Awaiting upload'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#00F5FF]/12">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProjectId(p.id);
                        navigate('/upload');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/25 bg-[#0B1220] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
                    >
                      <UploadCloud className="h-3.5 w-3.5 text-[#00F5FF]" />
                      Upload & Scan
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProjectId(p.id);
                        navigate('/workbench');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/25 bg-[#0B1220] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
                    >
                      <Code2 className="h-3.5 w-3.5 text-[#A855F7]" />
                      Workbench
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProjectId(p.id);
                        navigate('/radar');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5FF]/25 bg-[#0B1220] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] hover:border-[#00F5FF]"
                    >
                      <Radar className="h-3.5 w-3.5 text-[#3B82F6]" />
                      Impact Radar
                    </button>
                  </div>

                  {confirmDeleteId === p.id ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id)}
                        className="rounded-md bg-[#FF3864] px-2.5 py-1 text-xs font-semibold text-white"
                      >
                        Confirm Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs text-[#94A3B8] hover:text-[#F1F5F9]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete project ${p.name}`}
                      onClick={() => setConfirmDeleteId(p.id)}
                      className="rounded-md p-1.5 text-[#94A3B8] hover:bg-[#FF3864]/15 hover:text-[#FF3864]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
