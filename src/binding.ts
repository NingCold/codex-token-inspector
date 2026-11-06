import type { ServerContext } from '@modelcontextprotocol/server';
import type { Binding } from './dashboard.js';

export const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveBinding(meta: unknown, explicit?: string): Binding {
  const values = meta as Record<string, any> | undefined;
  const candidates = [values?.threadId, values?.['x-codex-turn-metadata']?.thread_id].filter((v): v is string => typeof v === 'string' && threadIdPattern.test(v));
  const unique = [...new Set(candidates)];
  if (unique.length > 1) return { threadId: null, source: 'conflict' };
  if (unique.length === 1) return { threadId: unique[0], source: 'host' };
  if (explicit && threadIdPattern.test(explicit)) return { threadId: explicit, source: 'explicit' };
  return { threadId: null, source: 'unavailable' };
}

// Inspect only context key names and explicit thread/conversation UUIDs. Never retain credentials.
export function inspectBinding(context: ServerContext) {
  const fields: Record<string, string> = {};
  const keys: string[] = [];
  function visit(value: unknown, path = '', depth = 0) {
    if (depth > 5 || !value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/auth|cookie|secret|token/i.test(key)) continue;
      const name = path ? `${path}.${key}` : key;
      keys.push(name);
      if (/thread|conversation/i.test(name) && typeof item === 'string' && threadIdPattern.test(item)) fields[name] = item;
      else if (typeof item === 'object') visit(item, name, depth + 1);
    }
  }
  visit(context.mcpReq._meta);
  return { keys, fields, environmentThreadId: process.env.CODEX_THREAD_ID ?? null, environmentSessionId: process.env.CODEX_SESSION_ID ?? null };
}
