import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Code2, ExternalLink, Radar } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAppStore } from '../store/useAppStore';

interface DepNode {
  id: string;
  node_key: string;
  label: string;
  file_path: string;
  language: string;
  loc: number;
  bug_count: number;
  max_severity: string;
  in_degree: number;
  out_degree: number;
  impact_score: number;
  exports: string[];
}

interface DepEdge {
  id: string;
  source_key: string;
  target_key: string;
  import_specifier: string;
  edge_type: string;
}

const SEV_BORDER: Record<string, string> = {
  critical: '#FF3864',
  high: '#A855F7',
  medium: '#FFB020',
  low: '#3B82F6',
  none: '#00F5FF',
};

export const ImpactRadarPage: React.FC = () => {
  const navigate = useNavigate();
  const { activeProjectId } = useAppStore();
  const [depNodes, setDepNodes] = useState<DepNode[]>([]);
  const [depEdges, setDepEdges] = useState<DepEdge[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadGraph = useCallback(async () => {
    if (!activeProjectId) {
      setDepNodes([]);
      setDepEdges([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ nodes: DepNode[]; edges: DepEdge[] }>(
        `/api/projects/${activeProjectId}/dependencies`,
      );
      setDepNodes(res.nodes);
      setDepEdges(res.edges);
      setSelectedKey(res.nodes[0]?.node_key ?? null);
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Compute transitive/indirect dependents of selected node
  const impactSets = useMemo(() => {
    if (!selectedKey) return { directUpstream: new Set<string>(), indirectUpstream: new Set<string>(), directDeps: new Set<string>() };
    const directUpstream = new Set<string>();
    const directDeps = new Set<string>();
    for (const e of depEdges) {
      if (e.target_key === selectedKey) directUpstream.add(e.source_key);
      if (e.source_key === selectedKey) directDeps.add(e.target_key);
    }
    const indirectUpstream = new Set<string>();
    const queue = [...directUpstream];
    const visited = new Set<string>([selectedKey, ...directUpstream]);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const e of depEdges) {
        if (e.target_key === curr && !visited.has(e.source_key)) {
          visited.add(e.source_key);
          indirectUpstream.add(e.source_key);
          queue.push(e.source_key);
        }
      }
    }
    return { directUpstream, indirectUpstream, directDeps };
  }, [depEdges, selectedKey]);

  const rfNodes: Node[] = useMemo(() => {
    const cols = Math.max(2, Math.ceil(Math.sqrt(depNodes.length)));
    return depNodes.map((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const isSelected = n.node_key === selectedKey;
      const isDirectAffected = impactSets.directUpstream.has(n.node_key);
      const isIndirectAffected = impactSets.indirectUpstream.has(n.node_key);
      const borderColor = isSelected
        ? '#00F5FF'
        : isDirectAffected
          ? '#FF3864'
          : isIndirectAffected
            ? '#FFB020'
            : SEV_BORDER[n.max_severity] || '#3B82F6';

      return {
        id: n.node_key,
        position: { x: 40 + col * 255, y: 40 + row * 145 },
        data: {
          label: (
            <div className="text-left">
              <div className="font-mono text-xs font-semibold text-[#F1F5F9] truncate">{n.label}</div>
              <div className="mt-0.5 text-[10px] text-[#94A3B8] font-mono">
                {n.language} · Impact {n.impact_score}
              </div>
              <div className="mt-1 text-[10px] font-mono" style={{ color: n.bug_count > 0 ? '#FF3864' : '#39FF88' }}>
                {n.bug_count > 0 ? `${n.bug_count} open bug${n.bug_count === 1 ? '' : 's'}` : 'Clean'}
              </div>
            </div>
          ),
        },
        style: {
          background: isSelected ? '#142238' : '#101A2B',
          border: `1.5px solid ${borderColor}`,
          borderRadius: 10,
          padding: '10px 12px',
          width: 210,
          boxShadow: isSelected ? `0 0 18px ${borderColor}44` : 'none',
          cursor: 'pointer',
        },
      };
    });
  }, [depNodes, selectedKey, impactSets]);

  const rfEdges: Edge[] = useMemo(() => {
    return depEdges.map((e) => {
      const highlighted = e.source_key === selectedKey || e.target_key === selectedKey;
      const stroke =
        e.target_key === selectedKey
          ? '#FF3864'
          : e.source_key === selectedKey
            ? '#00F5FF'
            : e.edge_type === 'sql'
              ? '#A855F7'
              : '#3B82F6';
      return {
        id: e.id,
        source: e.source_key,
        target: e.target_key,
        label: e.import_specifier,
        animated: highlighted,
        style: { stroke, strokeWidth: highlighted ? 2.2 : 1.3 },
        labelStyle: { fill: '#94A3B8', fontSize: 10, fontFamily: 'JetBrains Mono' },
        labelBgStyle: { fill: '#070B14', fillOpacity: 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
  }, [depEdges, selectedKey]);

  const selectedNode = depNodes.find((n) => n.node_key === selectedKey) ?? null;
  const highImpactNodes = [...depNodes].sort((a, b) => b.impact_score - a.impact_score).slice(0, 5);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-[#F1F5F9]">Code Impact Radar</h1>
        <p className="text-sm text-[#94A3B8]">
          Interactive dependency graph parsed from actual project imports, module exports, HTML assets, and SQL references. Click any node to trace blast radius.
        </p>
      </div>

      {loading ? (
        <div className="cyber-panel rounded-xl p-12 text-center text-sm text-[#94A3B8]">Building project dependency graph...</div>
      ) : depNodes.length === 0 ? (
        <div className="cyber-panel rounded-xl p-12 text-center text-sm text-[#94A3B8]">
          No project files found. Upload a project to map its dependency architecture.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          <div className="xl:col-span-8 cyber-panel rounded-xl overflow-hidden h-[540px]">
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              fitView
              onNodeClick={(_ev, node) => setSelectedKey(node.id)}
            >
              <Background color="rgba(0, 245, 255, 0.12)" gap={24} />
              <Controls />
              <MiniMap nodeColor="#00F5FF" maskColor="rgba(7, 11, 20, 0.78)" />
            </ReactFlow>
          </div>

          <div className="xl:col-span-4 space-y-4">
            {selectedNode && (
              <section className="cyber-panel rounded-xl p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Radar className="h-4 w-4 text-[#00F5FF] shrink-0" />
                    <h2 className="text-sm font-semibold text-[#F1F5F9] truncate">{selectedNode.label}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/workbench?file=${encodeURIComponent(selectedNode.file_path)}`)}
                    className="inline-flex items-center gap-1 text-[#00F5FF] hover:underline shrink-0"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    Inspect Source
                  </button>
                </div>

                <div className="font-mono text-[11px] text-[#94A3B8] break-all">{selectedNode.file_path}</div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#00F5FF]/12 text-center">
                  <div className="rounded bg-[#0B1220] p-2">
                    <div className="font-mono text-base font-bold text-[#00F5FF] tabular-nums">{selectedNode.impact_score}</div>
                    <div className="text-[10px] text-[#94A3B8]">Impact Score</div>
                  </div>
                  <div className="rounded bg-[#0B1220] p-2">
                    <div className="font-mono text-base font-bold text-[#F1F5F9] tabular-nums">{selectedNode.in_degree}</div>
                    <div className="text-[10px] text-[#94A3B8]">Dependents</div>
                  </div>
                  <div className="rounded bg-[#0B1220] p-2">
                    <div className="font-mono text-base font-bold text-[#F1F5F9] tabular-nums">{selectedNode.out_degree}</div>
                    <div className="text-[10px] text-[#94A3B8]">Imports</div>
                  </div>
                </div>

                {selectedNode.exports.length > 0 && (
                  <div>
                    <div className="font-semibold text-[#F1F5F9] mb-1">Exported Symbols</div>
                    <div className="font-mono text-[11px] text-[#00F5FF]">{selectedNode.exports.join(' · ')}</div>
                  </div>
                )}

                <div>
                  <div className="font-semibold text-[#F1F5F9] mb-1">
                    Directly Affected Callers ({impactSets.directUpstream.size})
                  </div>
                  <div className="font-mono text-[11px] text-[#FF3864]">
                    {impactSets.directUpstream.size > 0 ? [...impactSets.directUpstream].join(', ') : 'None'}
                  </div>
                </div>

                <div>
                  <div className="font-semibold text-[#F1F5F9] mb-1">
                    Indirect Transitive Impact ({impactSets.indirectUpstream.size})
                  </div>
                  <div className="font-mono text-[11px] text-[#FFB020]">
                    {impactSets.indirectUpstream.size > 0 ? [...impactSets.indirectUpstream].join(', ') : 'None'}
                  </div>
                </div>
              </section>
            )}

            <section className="cyber-panel rounded-xl p-5 space-y-2.5">
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Highest-Impact Files</h2>
              {highImpactNodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedKey(n.node_key)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedKey === n.node_key
                      ? 'border-[#00F5FF]/50 bg-[#142238]'
                      : 'border-[#00F5FF]/10 bg-[#0B1220] hover:border-[#00F5FF]/30'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[#F1F5F9] truncate">{n.file_path}</div>
                    <div className="text-[10px] text-[#94A3B8]">{n.language} · {n.loc} lines</div>
                  </div>
                  <div className="font-mono text-xs font-bold text-[#00F5FF] tabular-nums shrink-0 ml-2">
                    {n.impact_score}
                  </div>
                </button>
              ))}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
