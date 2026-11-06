import { z } from 'zod';
import { addUsage, emptyTotals, sumTotals } from './types.js';
import type { IndexSnapshot, IndexedRequest, ThreadInfo, Usage, Totals } from './types.js';

export const querySchema = z.object({
  sessionId: z.string().max(100).optional(),
  view: z.enum(['current', 'all']).default('current'),
  includeChildren: z.boolean().default(true), search: z.string().max(200).default(''),
  refresh: z.boolean().default(false),
  compactSessions: z.boolean().optional(),
});
export type Query = z.input<typeof querySchema>;
export type ParsedQuery = z.output<typeof querySchema>;
export interface Binding { threadId: string | null; source: 'host' | 'explicit' | 'unavailable' | 'conflict' }
const unavailable: Binding = { threadId: null, source: 'unavailable' };
const project = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '未关联项目';
function sameUsage(a: Usage, b: Usage) {
  return ['input', 'output', 'total'].every(key => a[key as keyof Usage] === b[key as keyof Usage])
    && ['cached', 'reasoning', 'cacheWrite'].every(key => a[key as keyof Usage] === null || b[key as keyof Usage] === null || a[key as keyof Usage] === b[key as keyof Usage]);
}

function addModel(groups: Map<string, Totals>, model: string, usage: Usage, requests: number) {
  let sum = groups.get(model);
  if (!sum) groups.set(model, sum = emptyTotals());
  addUsage(sum, usage, requests);
}

export function prepareDashboardView({ threads: catalog, sources: filesByPath, requests, status }: IndexSnapshot) {
  const threads = new Map(catalog.map(t => [t.id, t]));
  const byThread = new Map<string, { models: Map<string, Totals>; unknownModelRequests: number }>();
  const diagnostics = new Map<string, Set<string>>();
  const rejectedUsage = new Set<string>();
  const warn = (id: string, message: string) => { if (!diagnostics.has(id)) diagnostics.set(id, new Set()); diagnostics.get(id)!.add(message); };
  const unique = new Map<string, IndexedRequest>();
  const conflict = new Set<string>(), modelConflicts = new Set<string>(), responseOwners = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const record of requests) {
    if (!threads.has(record.threadId)) threads.set(record.threadId, { id: record.threadId, title: record.threadId, cwd: '', parentId: null, kind: 'main', nickname: null, archived: false, updatedAt: Date.parse(record.timestamp) || 0 });
    if (!record.responseId) {
      warn(record.threadId, '部分请求缺少响应标识，无法可靠跨文件去重');
      if (record.owner !== record.threadId) { rejectedUsage.add(record.threadId); continue; }
    } else {
      if (!responseOwners.has(record.responseId)) responseOwners.set(record.responseId, new Set());
      responseOwners.get(record.responseId)!.add(record.threadId);
    }
    const key = record.responseId ? record.threadId + ':' + record.responseId : record.path + ':' + record.offset;
    const existing = unique.get(key);
    if (!existing) unique.set(key, { ...record });
    else {
      duplicates++;
      if (!sameUsage(existing, record)) { conflict.add(key); warn(record.threadId, '同一响应的用量记录冲突，已排除冲突请求'); }
      else {
        for (const field of ['cached', 'reasoning', 'cacheWrite'] as const) existing[field] ??= record[field];
        if (existing.model && record.model && existing.model !== record.model) { modelConflicts.add(key); warn(record.threadId, '同一响应的模型归属存在冲突'); }
        else if (!existing.model) existing.model = record.model;
      }
    }
  }
  for (const [key, record] of unique) {
    if (record.responseId && (responseOwners.get(record.responseId)?.size ?? 0) > 1) { rejectedUsage.add(record.threadId); warn(record.threadId, '同一响应关联多个线程，已排除归属不明的请求'); continue; }
    if (conflict.has(key)) { rejectedUsage.add(record.threadId); continue; }
    if (modelConflicts.has(key)) record.model = null;
    let group = byThread.get(record.threadId);
    if (!group) byThread.set(record.threadId, group = { models: new Map(), unknownModelRequests: 0 });
    if (!record.model) group.unknownModelRequests++;
    addModel(group.models, record.model || '未知模型', record, 1);
  }
  const sources = new Map<string, typeof filesByPath>();
  const availableByIdentity = new Map<string, typeof filesByPath>();
  for (const source of filesByPath.filter(s => s.available)) {
    if (source.state.invalidUsage) for (const thread of source.state.invalidThreads ?? [null]) {
      const id = thread ?? source.owner;
      if (id) { rejectedUsage.add(id); warn(id, '日志包含无法解析或无效的用量记录'); }
    }
    if (!availableByIdentity.has(source.identity)) availableByIdentity.set(source.identity, []);
    availableByIdentity.get(source.identity)!.push(source);
  }
  for (const source of filesByPath) if (source.owner) {
    // A rename preserves file identity. Another file for the same thread is not proof of a move.
    const relocated = !source.available && source.error === '日志文件未找到'
      && availableByIdentity.get(source.identity)?.some(s => s.owner === source.owner && (s.evidenceOffset ?? s.offset) >= (source.evidenceOffset ?? source.offset));
    if (relocated) continue;
    if (!sources.has(source.owner)) sources.set(source.owner, []);
    sources.get(source.owner)!.push(source);
    if (source.state.malformed) warn(source.owner, '日志包含无法解析或无效的用量记录');
    if (source.state.totalMismatches) warn(source.owner, '来源总量与输入加输出不一致，按输入加输出统计');
    if (source.error) warn(source.owner, source.error);
  }
  const own = new Map<string, { totals: Totals; models: Map<string, Totals>; available: boolean; basis: string; unknownModelRequests: number }>();
  for (const t of threads.values()) {
    const { models, unknownModelRequests } = byThread.get(t.id) ?? { models: new Map<string, Totals>(), unknownModelRequests: 0 };
    const files = (sources.get(t.id) ?? []).filter(s => s.available);
    const totals = sumTotals(models.values());
    let basis = totals.requests ? 'requests' : rejectedUsage.has(t.id) ? 'unknown' : 'empty';
    const legacy = files.filter(s => s.state.usageCount === 0 && s.state.lastSnapshot && s.state.legacySafe).sort((a, b) => (b.evidenceMtime ?? b.mtime) - (a.evidenceMtime ?? a.mtime))[0];
    if (!totals.requests && legacy?.state.lastSnapshot) {
      addUsage(totals, legacy.state.lastSnapshot, 0); basis = 'snapshot';
      models.set('未知模型（累计快照）', totals);
      warn(t.id, '仅有累计快照，无法还原请求数、轮次及模型明细');
    } else if (!totals.requests && files.some(s => s.state.lastSnapshot && !s.state.legacySafe)) {
      basis = 'unknown';
      warn(t.id, '累计快照包含继承或分叉历史，无法确认本线程用量，未计入已知合计');
    }
    if (totals.requests) {
      const last = files.map(s => s.state.snapshots[t.id]).filter(Boolean);
      if (last.length && !last.some(s => s.input === totals.input && s.output === totals.output)) warn(t.id, '逐请求合计与线程累计快照不同，仅展示已核对的请求记录');
    }
    if (!files.length) {
      if (totals.requests) warn(t.id, '自身日志缺失，仅有其他日志保留的部分请求');
      else basis = 'unknown';
    }
    own.set(t.id, { totals, models, available: files.length > 0, basis, unknownModelRequests });
  }
  const children = new Map<string, string[]>();
  for (const t of threads.values()) if (t.parentId && t.kind !== 'guardian') { if (!children.has(t.parentId)) children.set(t.parentId, []); children.get(t.parentId)!.push(t.id); }
  function family(id: string) {
    const seen = new Set<string>(), stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) { warn(id, '代理关联存在环，已停止重复遍历'); continue; }
      seen.add(next);
      const group = children.get(next) ?? [];
      for (let i = group.length - 1; i >= 0; --i) stack.push(group[i]);
    }
    return [...seen];
  }
  const roots = [...threads.values()].filter(t => t.kind !== 'guardian' && (!t.parentId || !threads.has(t.parentId))).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const families = new Map<string, string[]>();
  const familyOf = (id: string) => { if (!families.has(id)) families.set(id, family(id)); return families.get(id)!; };
  return (query: ParsedQuery, binding: Binding = unavailable, index = status) => {
    const aggregate = (selected: string[]) => {
      const totals = emptyTotals();
      let unknownAgents = 0;
      for (const id of selected) {
        const usage = own.get(id)!;
        if (usage.basis === 'unknown') unknownAgents++;
        else addUsage(totals, usage.totals, usage.totals.requests);
      }
      if (selected.length && unknownAgents === selected.length) return { ...totals, input: null, output: null, total: null,
        cached: null, reasoning: null, cacheWrite: null, cacheRate: null, unknownAgents };
      return { ...totals, unknownAgents };
    };
    function select(t: ThreadInfo) {
      const all = familyOf(t.id), ids = query.includeChildren ? all : [t.id];
      const agents = ids.map(id => {
        const thread = threads.get(id)!, usage = own.get(id)!;
        return { ...aggregate([id]), id, name: id === t.id ? '主代理' : thread.nickname || thread.title,
          model: [...usage.models.keys()].join(' / ') || '—', parentId: id === t.id ? null : thread.parentId,
          available: usage.available, basis: usage.basis };
      });
      const modelGroups = new Map<string, Totals>();
      for (const id of ids) for (const [model, subtotal] of own.get(id)!.models) addModel(modelGroups, model, subtotal, subtotal.requests);
      const unknownChildren = ids.filter(id => id !== t.id && !own.get(id)!.available && own.get(id)!.basis === 'unknown').length;
      const unknownModelRequests = ids.reduce((n, id) => n + own.get(id)!.unknownModelRequests, 0);
      const issues = [...new Set(ids.flatMap(id => [...diagnostics.get(id) ?? []]))];
      if (unknownModelRequests) issues.push(`${unknownModelRequests} 次请求缺少可核对的模型上下文，Token 已计入合计并归入“未知模型”`);
      if (unknownChildren) issues.push(`有 ${unknownChildren} 个子代理在本机未找到日志，用量未知，未计入已知合计${index.running ? '；索引仍在进行中' : ''}`);
      if (!own.get(t.id)!.available && own.get(t.id)!.basis === 'unknown') issues.push(unknownChildren ? '主代理在本机未找到日志，用量未知，未计入已知合计'
        : index.running ? '日志尚未找到，索引仍在进行中' : '本机未找到日志，用量未知，未计入已知合计');
      return { id: t.id, title: t.title, project: project(t.cwd), cwd: t.cwd, archived: t.archived,
        missingChildren: ids.filter(id => id !== t.id && !own.get(id)!.available).length, mainMissing: !own.get(t.id)!.available,
        childCount: all.length - 1, agents, mainUsage: aggregate([t.id]), childUsage: aggregate(all.slice(1)), totals: aggregate(ids),
        models: [...modelGroups].map(([model, subtotal]) => ({ model, ...subtotal })).sort((a, b) => b.total - a.total),
        issues, unknownModelRequests,
      };
    }
    const term = query.search.trim().toLowerCase();
    const filtered = query.view === 'all' && term ? roots.filter(t => (t.title + ' ' + t.cwd + ' ' + t.id).toLowerCase().includes(term)) : roots;
    const sessions = query.view === 'all' ? filtered.map(t => {
      const ids = query.includeChildren ? familyOf(t.id) : [t.id];
      const row = { id: t.id, title: t.title, project: project(t.cwd), missingChildren: ids.filter(id => id !== t.id && !own.get(id)!.available).length };
      const totals = aggregate(ids);
      return query.compactSessions ? { ...row, total: totals.total } : { ...row, updatedAt: t.updatedAt, ...totals };
    }) : [];
    const selectedId = query.view === 'current' ? binding.threadId : query.sessionId || filtered[0]?.id;
    const selectedThread = selectedId ? threads.get(selectedId) : null;
    const selected = selectedThread && (query.view === 'current' || filtered.some(t => t.id === selectedId)) ? select(selectedThread) : null;
    return { mode: 'live' as const, phase: 'P1', asOf: index.lastIndexedAt || new Date().toISOString(), scope: { ...query, ...(query.view === 'all' ? { sessionId: selectedId ?? undefined } : {}), refresh: false },
      binding, sessions, selected, index, diagnostics: { duplicateRecords: duplicates, knownThreads: threads.size } };
  };
}
export function prepareDashboard(snapshot: IndexSnapshot) {
  const view = prepareDashboardView(snapshot);
  return (input: Query = {}, binding: Binding = unavailable) => view(querySchema.parse(input), binding);
}
export function getDashboard(snapshot: IndexSnapshot, input: Query = {}, binding: Binding = unavailable) { return prepareDashboard(snapshot)(input, binding); }
export type Dashboard = ReturnType<typeof getDashboard>;
