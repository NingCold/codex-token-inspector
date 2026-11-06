export interface Usage {
  input: number; cached: number | null; cacheWrite: number | null;
  output: number; reasoning: number | null; total: number;
}
export interface Totals extends Usage { cacheRate: number | null; requests: number }
export interface ThreadInfo {
  id: string; title: string; cwd: string; updatedAt: number; parentId: string | null;
  kind: 'main' | 'subagent' | 'guardian'; nickname: string | null; archived: boolean;
}
export interface RequestUsage extends Usage {
  threadId: string; responseId: string | null; turnId: string | null; timestamp: string;
  model: string | null; effort: string | null; offset: number;
}
export interface ParseState {
  ownerId: string | null; metadata: ThreadInfo | null;
  contexts: Record<string, { model: string | null; effort: string | null; modelAmbiguous?: boolean }>;
  usageCount: number; malformed: number; invalidUsage: number; totalMismatches: number; legacySafe: boolean;
  lastSnapshot: Usage | null; snapshots: Record<string, Usage>;
}
export interface SourceRow {
  parserVersion?: number;
  path: string; owner: string | null; offset: number; size: number; mtime: number;
  identity: string; anchor: string; state: ParseState; available: boolean; error: string | null;
}
export interface IndexedRequest extends RequestUsage { path: string; owner: string | null }
export interface IndexStatus {
  running: boolean; completedFiles: number; totalFiles: number;
  lastIndexedAt: string | null; error: string | null; sourceWarnings: string[];
}
export interface IndexSnapshot { threads: ThreadInfo[]; sources: SourceRow[]; requests: IndexedRequest[]; status: IndexStatus }

export function zeroUsage(): Usage { return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }; }
export function totalUsage(rows: Usage[], requests = rows.length): Totals {
  const result = zeroUsage();
  for (const row of rows) {
    result.input += row.input; result.output += row.output; result.total += row.total;
    for (const key of ['cached', 'cacheWrite', 'reasoning'] as const) result[key] = result[key] === null || row[key] === null ? null : result[key]! + row[key]!;
  }
  return { ...result, requests, cacheRate: result.input && result.cached !== null ? result.cached / result.input : null };
}
