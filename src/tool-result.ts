import type { Dashboard } from './dashboard.js';

// Chat history contains a bounded answer; the app receives its full view through _meta.
export function usageSummary(data: Dashboard) {
  const selected = data.selected;
  return {
    mode: data.mode, asOf: data.asOf, binding: data.binding,
    scope: { view: data.scope.view, includeChildren: data.scope.includeChildren },
    selected: selected ? { id: selected.id, title: selected.title, totals: selected.totals,
      mainUsage: selected.mainUsage, childUsage: selected.childUsage, childCount: selected.childCount,
      missingChildren: selected.missingChildren, issues: selected.issues,
      models: selected.models.slice(0, 12), agents: selected.agents.slice(0, 12),
      omittedModels: Math.max(0, selected.models.length - 12), omittedAgents: Math.max(0, selected.agents.length - 12) } : null,
    ...(data.scope.view === 'all' ? { sessions: data.sessions.slice(0, 20), omittedSessions: Math.max(0, data.sessions.length - 20) } : {}),
    index: { running: data.index.running, error: data.index.error, sourceWarnings: data.index.sourceWarnings },
  };
}

export function panelResult(data: Dashboard) {
  return {
    content: [{ type: 'text' as const, text: 'Token 用量面板已就绪。' }],
    structuredContent: { mode: data.mode, asOf: data.asOf, binding: data.binding,
      selected: data.selected ? { id: data.selected.id, title: data.selected.title, totals: data.selected.totals, issues: data.selected.issues } : null },
    _meta: { dashboard: data },
  };
}
