import { createReadStream } from 'node:fs';
import type { ParseState, RequestUsage, ThreadInfo, Usage } from './types.js';

export const parserVersion = 3;
export const emptyState = (): ParseState => ({ ownerId: null, metadata: null, contexts: {}, usageCount: 0, malformed: 0, invalidUsage: 0, totalMismatches: 0, legacySafe: true, lastSnapshot: null, snapshots: {} });
const token = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
export function parseUsage(value: any): Usage | null {
  if (!value || typeof value !== 'object') return null;
  const input = token(value.input_tokens), output = token(value.output_tokens);
  if (input === null || output === null || !Number.isSafeInteger(input + output)) return null;
  let cached = token(value.cached_input_tokens), reasoning = token(value.reasoning_output_tokens);
  if (cached !== null && cached > input) cached = null;
  if (reasoning !== null && reasoning > output) reasoning = null;
  return { input, output, total: input + output, cached, reasoning, cacheWrite: token(value.cache_write_input_tokens) };
}
export function metadata(value: any): ThreadInfo | null {
  if (!text(value?.id)) return null;
  let source = value.source;
  if (typeof source === 'string' && source.startsWith('{')) { try { source = JSON.parse(source); } catch {} }
  const spawn = source?.subagent?.thread_spawn;
  const kind = source?.subagent?.other === 'guardian' || source?.subagent === 'guardian_review' ? 'guardian' : spawn || source?.subagent ? 'subagent' : 'main';
  return { id: value.id, title: value.name || value.title || value.agent_nickname || value.id,
    cwd: value.cwd || '', updatedAt: value.updatedAt || Date.parse(value.timestamp || '') || 0,
    parentId: text(spawn?.parent_thread_id), kind, nickname: text(value.agent_nickname || spawn?.agent_nickname || spawn?.agent_path), archived: Boolean(value.archived) };
}

// Offsets are bytes, not JS character indices. Only complete newline-terminated records commit.
// Unrelated large tool/message lines are discarded after their header; no message bodies are indexed.
export async function scanLog(path: string, start: number, end: number, previous = emptyState()) {
  const state: ParseState = structuredClone(previous);
  const records: RequestUsage[] = [];
  let offset = start, committed = start, parts: Buffer[] = [], length = 0, skip = false;
  if (end <= start) return { state, records, offset: committed };
  function consume(line: Buffer, at: number) {
    if (!line.length) return;
    let row: any;
    try { row = JSON.parse(line.toString('utf8')); } catch { state.malformed++; return; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { state.malformed++; return; }
    const value = row.payload;
    if (!value || typeof value !== 'object') return;
    if (row.type === 'session_meta') {
      if (state.ownerId || value.forked_from_id) state.legacySafe = false;
      if (!state.ownerId) { state.metadata = metadata(value); state.ownerId = state.metadata?.id ?? null; }
    } else if (row.type === 'turn_context') {
      if (text(value.turn_id)) {
        const previousContext = state.contexts[value.turn_id], model = text(value.model);
        state.contexts[value.turn_id] = { model: model ?? previousContext?.model ?? null, effort: text(value.effort),
          modelAmbiguous: !!previousContext?.modelAmbiguous || !!(previousContext?.model && model && previousContext.model !== model) };
      }
    } else if (row.type === 'token_usage_record') {
      state.usageCount++;
      const usage = parseUsage(value.usage);
      if (!usage || !text(value.thread_id)) { state.invalidUsage++; return; }
      if (token(value.usage.total_tokens) !== null && value.usage.total_tokens !== usage.total) state.totalMismatches++;
      const context = state.contexts[value.turn_id];
      records.push({ ...usage, threadId: value.thread_id, responseId: text(value.response_id), turnId: text(value.turn_id),
        timestamp: text(row.timestamp) || '', model: context?.model ?? null, effort: context?.effort ?? null, offset: at });
      const snapshot = parseUsage(value.thread_token_usage);
      if (snapshot) state.snapshots[value.thread_id] = snapshot;
    } else if (row.type === 'event_msg' && value.type === 'token_count') {
      const snapshot = parseUsage(value.info?.total_token_usage);
      if (snapshot) state.lastSnapshot = snapshot;
    }
  }
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    let cursor = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(10, cursor);
      const piece = buffer.subarray(cursor, newline < 0 ? buffer.length : newline);
      if (!skip) {
        parts.push(piece); length += piece.length;
        if (length - piece.length < 220) {
          const head = parts.length === 1 ? piece.subarray(0, 220) : Buffer.concat(parts, Math.min(length, 220));
          // Only fast-skip complete types in a known header layout; otherwise parse the whole line.
          const [, type, event] = /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"([a-z_]+)"(?:\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)")?/.exec(head.toString('utf8')) ?? [];
          skip = !!type && (!['session_meta', 'turn_context', 'token_usage_record', 'event_msg'].includes(type)
            || (type === 'event_msg' && !!event && event !== 'token_count'));
        }
        if (!skip && length > 32 * 1024 * 1024) { skip = true; state.malformed++; }
        if (skip) parts = [];
      }
      if (newline < 0) { offset += buffer.length - cursor; break; }
      offset += piece.length + 1;
      if (!skip) consume(parts.length === 1 ? piece : Buffer.concat(parts, length), committed);
      committed = offset; parts = []; length = 0; skip = false; cursor = newline + 1;
    }
  }
  return { state, records, offset: committed };
}
