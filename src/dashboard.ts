import { z } from 'zod';
import { totalUsage } from './types.js';
import type { IndexSnapshot, IndexedRequest, ThreadInfo, Usage, Totals } from './types.js';

export const querySchema = z.object({
  sessionId: z.string().max(100).optional(),
  view: z.enum(['current', 'all']).default('current'),
  includeChildren: z.boolean().default(true), search: z.string().max(200).default(''),
  refresh: z.boolean().default(false),
});
export type Query = z.input<typeof querySchema>;
export interface Binding { threadId: string | null; source: 'host' | 'explicit' | 'unavailable' | 'conflict' }
const unavailable: Binding = { threadId: null, source: 'unavailable' };
const project = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '未关联项目';
function sameUsage(a: Usage, b: Usage) {
  return ['input', 'output', 'total'].every(key => a[key as keyof Usage] === b[key as keyof Usage])
    && ['cached', 'reasoning', 'cacheWrite'].every(key => a[key as keyof Usage] === null || b[key as keyof Usage] === null || a[key as keyof Usage] === b[key as keyof Usage]);
}

export function prepareDashboard(snapshot: IndexSnapshot) {
  const index = snapshot.status;
  const threads = new Map(snapshot.threads.map(t => [t.id, t]));
  const byThread = new Map<string, IndexedRequest[]>();
  const diagnostics = new Map<string, Set<string>>();
  const warn = (id: string, message: string) => { if (!diagnostics.has(id)) diagnostics.set(id, new Set()); diagnostics.get(id)!.add(message); };
  const unique = new Map<string, IndexedRequest>();
  const conflict = new Set<string>(), modelConflicts = new Set<string>(), responseOwners = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const record of snapshot.requests) {
    if (!threads.has(record.threadId)) threads.set(record.threadId, { id: record.threadId, title: record.threadId, cwd: '', parentId: null, kind: 'main', nickname: null, archived: false, updatedAt: Date.parse(record.timestamp) || 0 });
    if (!record.responseId) {
      warn(record.threadId, '部分请求缺少响应标识，无法可靠跨文件去重');
      if (record.owner !== record.threadId) continue;
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
    if (record.responseId && (responseOwners.get(record.responseId)?.size ?? 0) > 1) { warn(record.threadId, '同一响应关联多个线程，已排除归属不明的请求'); continue; }
    if (conflict.has(key)) continue;
    if (modelConflicts.has(key)) record.model = null;
    if (!byThread.has(record.threadId)) byThread.set(record.threadId, []);
    byThread.get(record.threadId)!.push(record);
  }
  const sources = new Map<string, typeof snapshot.sources>();
  const availableByIdentity = new Map<string, typeof snapshot.sources>();
  for (const source of snapshot.sources.filter(s => s.available)) {
    if (!availableByIdentity.has(source.identity)) availableByIdentity.set(source.identity, []);
    availableByIdentity.get(source.identity)!.push(source);
  }
  for (const source of snapshot.sources) if (source.owner) {
    // A rename preserves file identity. Another file for the same thread is not proof of a move.
    const relocated = !source.available && source.error === '日志文件未找到'
      && availableByIdentity.get(source.identity)?.some(s => s.owner === source.owner && s.offset >= source.offset);
    if (relocated) continue;
    if (!sources.has(source.owner)) sources.set(source.owner, []);
    sources.get(source.owner)!.push(source);
    if (source.state.malformed || source.state.invalidUsage) warn(source.owner, '日志包含无法解析或无效的用量记录');
    if (source.state.totalMismatches) warn(source.owner, '来源总量与输入加输出不一致，按输入加输出统计');
    if (source.error) warn(source.owner, source.error);
  }
  const own = new Map<string, { totals: Totals; models: Map<string, Usage[]>; available: boolean; basis: string; requests: IndexedRequest[] }>();
  for (const t of threads.values()) {
    const records = byThread.get(t.id) ?? [];
    const files = (sources.get(t.id) ?? []).filter(s => s.available);
    const modelGroups = new Map<string, Usage[]>();
    for (const r of records) { const model = r.model || '未知模型'; if (!modelGroups.has(model)) modelGroups.set(model, []); modelGroups.get(model)!.push(r); }
    let totals = totalUsage(records), basis = records.length ? 'requests' : 'empty';
    if (records.some(r => !r.model)) warn(t.id, '部分请求缺少可核对的模型上下文');
    const legacy = files.filter(s => s.state.usageCount === 0 && s.state.lastSnapshot && s.state.legacySafe).sort((a, b) => b.mtime - a.mtime)[0];
    if (!records.length && legacy?.state.lastSnapshot) {
      totals = totalUsage([legacy.state.lastSnapshot], 0); basis = 'snapshot';
      modelGroups.set('未知模型（累计快照）', [legacy.state.lastSnapshot]);
      warn(t.id, '仅有累计快照，无法还原请求数、轮次及模型明细');
    } else if (!records.length && files.some(s => s.state.lastSnapshot && !s.state.legacySafe)) {
      basis = 'unknown';
      warn(t.id, '累计快照包含继承或分叉历史，无法确认本线程用量，未计入已知合计');
    }
    if (records.length) {
      const last = files.map(s => s.state.snapshots[t.id]).filter(Boolean);
      if (last.length && !last.some(s => s.input === totals.input && s.output === totals.output)) warn(t.id, '逐请求合计与线程累计快照不同，仅展示已核对的请求记录');
    }
    if (!files.length) {
      warn(t.id, records.length ? '自身日志缺失，仅有其他日志保留的部分请求' : index.running ? '日志尚未找到，索引仍在进行中' : '本机未找到日志，用量未知，未计入已知合计');
      if (!records.length) basis = 'unknown';
    }
    own.set(t.id, { totals, models: modelGroups, available: files.length > 0, basis, requests: records });
  }
  const children = new Map<string, string[]>();
  for (const t of threads.values()) if (t.parentId && t.kind !== 'guardian') { if (!children.has(t.parentId)) children.set(t.parentId, []); children.get(t.parentId)!.push(t.id); }
  function family(id: string) {
    const seen = new Set<string>(), result: string[] = [];
    const walk = (next: string, ancestors: Set<string>) => {
      if (ancestors.has(next)) { warn(id, '代理关联存在环，已停止重复遍历'); return; }
      if (seen.has(next)) return;
      seen.add(next); result.push(next);
      const path = new Set([...ancestors, next]);
      for (const child of children.get(next) ?? []) walk(child, path);
    };
    walk(id, new Set()); return result;
  }
  const roots = [...threads.values()].filter(t => t.kind !== 'guardian' && (!t.parentId || !threads.has(t.parentId))).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const families = new Map<string, string[]>();
  const familyOf = (id: string) => { if (!families.has(id)) families.set(id, family(id)); return families.get(id)!; };
  return (input: Query = {}, binding: Binding = unavailable) => {
    const query = querySchema.parse(input);
    const aggregate = (selected: string[]) => {
      const known = selected.map(id => own.get(id)!).filter(usage => usage.basis !== 'unknown');
      const totals = totalUsage(known.map(usage => usage.totals), known.reduce((n, usage) => n + usage.totals.requests, 0));
      const unknownAgents = selected.length - known.length;
      if (selected.length && !known.length) return { ...totals, input: null, output: null, total: null,
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
      const modelGroups = new Map<string, Usage[]>();
      for (const id of ids) for (const [model, records] of own.get(id)!.models) { if (!modelGroups.has(model)) modelGroups.set(model, []); modelGroups.get(model)!.push(...records); }
      const unknownChildren = ids.filter(id => id !== t.id && !own.get(id)!.available && own.get(id)!.basis === 'unknown').length;
      const unknownModelRequests = ids.reduce((n, id) => n + own.get(id)!.requests.filter(r => !r.model).length, 0);
      const issues = [...new Set(ids.flatMap(id => [...diagnostics.get(id) ?? []]).filter(message => (!unknownChildren || message !== '本机未找到日志，用量未知，未计入已知合计') && message !== '部分请求缺少可核对的模型上下文'))];
      if (unknownModelRequests) issues.push(`${unknownModelRequests} 次请求缺少可核对的模型上下文，Token 已计入合计并归入“未知模型”`);
      if (unknownChildren) issues.push(`有 ${unknownChildren} 个子代理在本机未找到日志，用量未知，未计入已知合计${index.running ? '；索引仍在进行中' : ''}`);
      if (unknownChildren && !own.get(t.id)!.available && own.get(t.id)!.basis === 'unknown') issues.push('主代理在本机未找到日志，用量未知，未计入已知合计');
      return { id: t.id, title: t.title, project: project(t.cwd), cwd: t.cwd, archived: t.archived,
        missingChildren: ids.filter(id => id !== t.id && !own.get(id)!.available).length, mainMissing: !own.get(t.id)!.available,
        childCount: all.length - 1, agents, mainUsage: aggregate([t.id]), childUsage: aggregate(all.slice(1)), totals: aggregate(ids),
        models: [...modelGroups].map(([model, rows]) => ({ model, ...totalUsage(rows) })).sort((a, b) => b.total - a.total),
        issues, unknownModelRequests,
      };
    }
    const term = query.search.trim().toLowerCase();
    const filtered = roots.filter(t => (t.title + ' ' + t.cwd + ' ' + t.id).toLowerCase().includes(term));
    const sessions = query.view === 'all' ? filtered.map(t => {
      const ids = query.includeChildren ? familyOf(t.id) : [t.id];
      return { id: t.id, title: t.title, project: project(t.cwd),
        missingChildren: ids.filter(id => id !== t.id && !own.get(id)!.available).length, updatedAt: t.updatedAt, ...aggregate(ids) };
    }) : [];
    const selectedId = query.view === 'current' ? binding.threadId : query.sessionId || filtered[0]?.id;
    const selectedThread = selectedId ? threads.get(selectedId) : null;
    const selected = selectedThread && (query.view === 'current' || filtered.some(t => t.id === selectedId)) ? select(selectedThread) : null;
    return { mode: 'live' as const, phase: 'P1', asOf: index.lastIndexedAt || new Date().toISOString(), scope: { ...query, ...(query.view === 'all' ? { sessionId: selectedId ?? undefined } : {}), refresh: false },
      binding, sessions, selected, index, diagnostics: { duplicateRecords: duplicates, knownThreads: threads.size } };
  };
}
export function getDashboard(snapshot: IndexSnapshot, input: Query = {}, binding: Binding = unavailable) { return prepareDashboard(snapshot)(input, binding); }
export type Dashboard = ReturnType<typeof getDashboard>;
