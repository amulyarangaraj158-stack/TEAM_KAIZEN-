import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Brain, Loader2, Search, Sparkles } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { CodeDiffPanel } from '../components/CodeEditorPanel';

interface PatternData {
  byCategory: Array<{ category: string; count: number; resolved: number }>;
  byFile: Array<{ filePath: string; language: string; count: number; criticalCount: number }>;
  repeatedErrors: Array<{ errorMessage: string; category: string; occurrences: number }>;
  commonRootCauses: Array<{ rootCause: string; category: string; occurrences: number }>;
  timeline: Array<{ date: string; detected: number; resolved: number }>;
  byLanguage: Array<{ language: string; count: number }>;
}

interface Recommendation {
  title: string;
  priority: string;
  patternEvidence: string;
  actionableGuidance: string;
}

interface LearningRecord {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  category: string;
  language: string;
  error_message: string;
  root_cause: string;
  incorrect_code: string;
  corrected_code: string;
  why_it_works: string;
  prevention_guide: string;
  concepts: string[];
  created_at: string;
}

export const BugIntelligencePage: React.FC = () => {
  const { projects, activeProjectId, addToast } = useAppStore();
  const [tab, setTab] = useState<'patterns' | 'learning'>('patterns');
  const [scopeProjectId, setScopeProjectId] = useState<string>(activeProjectId || 'all');

  const [patterns, setPatterns] = useState<PatternData | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [generatingRecs, setGeneratingRecs] = useState(false);

  const [learningRecords, setLearningRecords] = useState<LearningRecord[]>([]);
  const [learnSearch, setLearnSearch] = useState('');
  const [learnCategory, setLearnCategory] = useState('all');
  const [selectedLearningId, setSelectedLearningId] = useState<string | null>(null);

  useEffect(() => {
    if (activeProjectId && scopeProjectId === 'all') {
      setScopeProjectId(activeProjectId);
    }
  }, [activeProjectId]);

  const loadPatterns = useCallback(async () => {
    try {
      const qs = scopeProjectId && scopeProjectId !== 'all' ? `?projectId=${encodeURIComponent(scopeProjectId)}` : '';
      const res = await apiFetch<PatternData>(`/api/intelligence/patterns${qs}`);
      setPatterns(res);
    } catch {
      // ignore
    }
  }, [scopeProjectId]);

  const loadLearning = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (scopeProjectId && scopeProjectId !== 'all') params.set('projectId', scopeProjectId);
      if (learnCategory !== 'all') params.set('category', learnCategory);
      if (learnSearch.trim()) params.set('q', learnSearch.trim());
      const res = await apiFetch<{ records: LearningRecord[] }>(`/api/intelligence/learning?${params.toString()}`);
      setLearningRecords(res.records);
      setSelectedLearningId((prev) =>
        res.records.some((r) => r.id === prev) ? prev : (res.records[0]?.id ?? null),
      );
    } catch {
      // ignore
    }
  }, [scopeProjectId, learnCategory, learnSearch]);

  useEffect(() => {
    loadPatterns();
    loadLearning();
  }, [loadPatterns, loadLearning]);

  const handleGenerateRecommendations = async () => {
    setGeneratingRecs(true);
    try {
      const res = await apiFetch<{ recommendations: Recommendation[] }>('/api/intelligence/recommendations', {
        method: 'POST',
        body: JSON.stringify({ projectId: scopeProjectId === 'all' ? null : scopeProjectId }),
      });
      setRecommendations(res.recommendations);
      addToast({ type: 'success', title: 'AI recommendations generated', message: 'Grounded in historical project bug data.' });
    } catch (err) {
      addToast({ type: 'error', title: 'Recommendation request failed', message: err instanceof Error ? err.message : '' });
    } finally {
      setGeneratingRecs(false);
    }
  };

  const selectedLearning = learningRecords.find((r) => r.id === selectedLearningId) ?? null;
  const categories = [...new Set((patterns?.byCategory ?? []).map((c) => c.category))];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#F1F5F9]">Bug Intelligence & Learning Centre</h1>
          <p className="text-sm text-[#94A3B8]">
            Analyze recurring bug patterns across historical scans and study verified fixes in the Learn From Your Bugs hub.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter intelligence by project"
            value={scopeProjectId}
            onChange={(e) => setScopeProjectId(e.target.value)}
            className="rounded-lg border border-[#00F5FF]/20 bg-[#101A2B] px-3 py-2 text-xs text-[#F1F5F9]"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-lg border border-[#00F5FF]/20 bg-[#0B1220] p-1">
            <button
              type="button"
              onClick={() => setTab('patterns')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'patterns' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              Bug Pattern Intelligence
            </button>
            <button
              type="button"
              onClick={() => setTab('learning')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'learning' ? 'bg-[#142238] text-[#00F5FF]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Learn From Your Bugs ({learningRecords.length})
            </button>
          </div>
        </div>
      </div>

      {tab === 'patterns' ? (
        <div className="space-y-6">
          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="cyber-panel rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#F1F5F9] mb-1">Most Common Bug Categories</h2>
              <p className="text-xs text-[#94A3B8] mb-4">Detected vs resolved count per category.</p>
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={patterns?.byCategory ?? []} margin={{ top: 8, right: 12, left: -14, bottom: 20 }}>
                    <CartesianGrid stroke="rgba(148,163,184,0.1)" vertical={false} />
                    <XAxis dataKey="category" stroke="#94A3B8" fontSize={11} angle={-15} textAnchor="end" interval={0} />
                    <YAxis stroke="#94A3B8" fontSize={11} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0B1220', borderColor: 'rgba(0,245,255,0.25)', fontSize: 12 }}
                    />
                    <Bar dataKey="count" name="Detected" fill="#00F5FF" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="resolved" name="Resolved" fill="#39FF88" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="cyber-panel rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#F1F5F9] mb-1">Bug Frequency Over Time</h2>
              <p className="text-xs text-[#94A3B8] mb-4">Historical detection and resolution trend.</p>
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={patterns?.timeline ?? []} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(148,163,184,0.1)" vertical={false} />
                    <XAxis dataKey="date" stroke="#94A3B8" fontSize={11} />
                    <YAxis stroke="#94A3B8" fontSize={11} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0B1220', borderColor: 'rgba(0,245,255,0.25)', fontSize: 12 }}
                    />
                    <Line type="monotone" dataKey="detected" name="Detected" stroke="#FF3864" strokeWidth={2} />
                    <Line type="monotone" dataKey="resolved" name="Resolved" stroke="#39FF88" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Hotspots & Repeated Root Causes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="cyber-panel rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#F1F5F9] mb-3">Frequently Affected Files</h2>
              <div className="space-y-2">
                {(patterns?.byFile ?? []).map((f) => (
                  <div
                    key={f.filePath}
                    className="flex items-center justify-between rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[#F1F5F9] truncate">{f.filePath}</div>
                      <div className="text-[11px] text-[#94A3B8]">{f.language}</div>
                    </div>
                    <div className="font-mono text-right shrink-0 tabular-nums">
                      <span className="text-[#00F5FF] font-semibold">{f.count} bugs</span>
                      {f.criticalCount > 0 && (
                        <span className="ml-2 text-[#FF3864]">({f.criticalCount} critical)</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="cyber-panel rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#F1F5F9] mb-3">Repeated Errors & Root Causes</h2>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {(patterns?.repeatedErrors ?? []).map((e, i) => (
                  <div key={i} className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#A855F7]">{e.category}</span>
                      <span className="font-mono text-[#94A3B8] tabular-nums">{e.occurrences}x</span>
                    </div>
                    <div className="font-mono text-[#F1F5F9] text-[11px]">{e.errorMessage}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* AI Prevention Recommendations */}
          <section className="cyber-panel rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#F1F5F9]">AI Prevention Recommendations</h2>
                <p className="text-xs text-[#94A3B8]">
                  Generated via server-side Gemini API directly from your database bug history.
                </p>
              </div>
              <button
                type="button"
                disabled={generatingRecs}
                onClick={handleGenerateRecommendations}
                className="inline-flex items-center gap-2 rounded-lg bg-[#A855F7] px-4 py-2 text-xs font-semibold text-white hover:bg-[#A855F7]/90 disabled:opacity-50"
              >
                {generatingRecs ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generatingRecs ? 'Analyzing History...' : 'Generate AI Recommendations'}
              </button>
            </div>

            {recommendations.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recommendations.map((rec, idx) => (
                  <div key={idx} className="rounded-lg border border-[#A855F7]/25 bg-[#0B1220] p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#F1F5F9]">{rec.title}</span>
                      <span className="font-mono text-[#FFB020]">{rec.priority} Priority</span>
                    </div>
                    <p className="text-[#94A3B8]">
                      <strong className="text-[#F1F5F9]">Evidence:</strong> {rec.patternEvidence}
                    </p>
                    <p className="text-[#94A3B8]">
                      <strong className="text-[#39FF88]">Prevention:</strong> {rec.actionableGuidance}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-[#00F5FF]/10 bg-[#0B1220] p-6 text-center text-xs text-[#94A3B8]">
                Click "Generate AI Recommendations" to synthesize tailored prevention guidance from your historical bug records.
              </div>
            )}
          </section>
        </div>
      ) : (
        /* Learn From Your Bugs Dedicated Learning Centre */
        <div className="space-y-5">
          <div className="cyber-panel rounded-xl p-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
              <input
                type="search"
                aria-label="Search learning records"
                value={learnSearch}
                onChange={(e) => setLearnSearch(e.target.value)}
                placeholder="Search resolved bugs, root causes, or explanations..."
                className="w-full rounded-lg border border-[#00F5FF]/18 bg-[#070B14] py-2 pl-9 pr-3 text-xs text-[#F1F5F9] focus:border-[#00F5FF] focus:outline-none"
              />
            </div>
            <select
              aria-label="Filter learning records by category"
              value={learnCategory}
              onChange={(e) => setLearnCategory(e.target.value)}
              className="rounded-lg border border-[#00F5FF]/18 bg-[#070B14] px-3 py-2 text-xs text-[#F1F5F9]"
            >
              <option value="all">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {learningRecords.length === 0 ? (
            <div className="cyber-panel rounded-xl p-10 text-center text-sm text-[#94A3B8]">
              No resolved bug lessons match your filters yet. Approve and apply a patch in Code Workbench to add it here automatically.
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
              <div className="xl:col-span-4 space-y-2">
                {learningRecords.map((rec) => (
                  <button
                    key={rec.id}
                    type="button"
                    onClick={() => setSelectedLearningId(rec.id)}
                    className={`w-full rounded-xl border p-4 text-left transition-colors ${
                      selectedLearningId === rec.id
                        ? 'border-[#00F5FF]/55 bg-[#142238]'
                        : 'border-[#00F5FF]/12 bg-[#101A2B] hover:border-[#00F5FF]/35'
                    }`}
                  >
                    <div className="text-[11px] font-mono text-[#00F5FF]">
                      {rec.category} · {rec.language}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-[#F1F5F9]">{rec.title}</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">
                      {rec.project_name} · {new Date(rec.created_at).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>

              {selectedLearning && (
                <div className="xl:col-span-8 cyber-panel rounded-xl p-6 space-y-5">
                  <div>
                    <div className="text-xs font-mono text-[#00F5FF]">
                      {selectedLearning.category} · {selectedLearning.language} · {selectedLearning.project_name}
                    </div>
                    <h2 className="mt-1 text-xl font-bold text-[#F1F5F9]">{selectedLearning.title}</h2>
                    <p className="mt-2 font-mono text-xs text-[#FF3864]">{selectedLearning.error_message}</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div className="rounded-lg border border-[#00F5FF]/12 bg-[#0B1220] p-4 space-y-1.5">
                      <div className="font-semibold text-[#F1F5F9]">Root Cause</div>
                      <p className="text-[#94A3B8] leading-relaxed">{selectedLearning.root_cause}</p>
                    </div>
                    <div className="rounded-lg border border-[#39FF88]/20 bg-[#0B1220] p-4 space-y-1.5">
                      <div className="font-semibold text-[#39FF88]">Why the Fix Works</div>
                      <p className="text-[#94A3B8] leading-relaxed">{selectedLearning.why_it_works}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-[#A855F7]/20 bg-[#0B1220] p-4 text-xs space-y-2">
                    <div className="font-semibold text-[#F1F5F9]">How to Prevent This Issue</div>
                    <p className="text-[#94A3B8] leading-relaxed">{selectedLearning.prevention_guide}</p>
                    {selectedLearning.concepts.length > 0 && (
                      <div className="pt-1 text-[#94A3B8]">
                        Related concepts:{' '}
                        <span className="font-mono text-[#00F5FF]">{selectedLearning.concepts.join(' · ')}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-[#F1F5F9]">Incorrect Code vs Corrected Code</div>
                    <CodeDiffPanel
                      original={selectedLearning.incorrect_code}
                      modified={selectedLearning.corrected_code}
                      language={selectedLearning.language.toLowerCase()}
                      height="320px"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
