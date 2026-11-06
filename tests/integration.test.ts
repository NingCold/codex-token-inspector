import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startLocalWeb } from '../src/local-web.js';
import type { Dashboard } from '../src/dashboard.js';
import { fixture, ids } from './fixtures.js';
import { UsageService } from '../src/service.js';

test('bundled MCP server exposes global/thread apps and handles live tool calls', async () => {
  await using data = await fixture();
  const client = new Client({ name: 'token-inspector-p0-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugin/dist/server.mjs')], env: { ...process.env as Record<string, string>, CODEX_HOME: data.codexHome, CTI_DATA_DIR: data.dataDir }, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.deepEqual((tools.find(t => t.name === 'get_dashboard_view')!._meta?.ui as any).visibility, ['app']);
    const global = tools.find(t => t.name === 'open_usage_dashboard')!;
    const thread = tools.find(t => t.name === 'open_thread_usage')!;
    assert.deepEqual((global._meta?.['openai/ui'] as any).entrypoints, [{ type: 'global' }]);
    assert.deepEqual((thread._meta?.['openai/ui'] as any).entrypoints, [{ type: 'thread' }]);
    const resource = await client.readResource({ uri: (global._meta?.ui as any).resourceUri });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok('text' in resource.contents[0] && resource.contents[0].text.includes('<html lang="zh-CN">'));
    const initial = await client.callTool({ name: 'open_thread_usage', arguments: {}, _meta: { threadId: ids.main } });
    const all = initial._meta?.dashboard as Dashboard;
    const initialSummary = initial.structuredContent as ReturnType<typeof import('../src/tool-result.js').panelResult>['structuredContent'];
    assert.ok(!('sessions' in initialSummary));
    assert.ok(!('agents' in initialSummary.selected!));
    assert.ok(JSON.stringify(initial.structuredContent).length < 1500);
    assert.equal(all.mode, 'live'); assert.equal(all.selected?.totals.total, 6200000);
    assert.equal(all.binding.source, 'host');
    const appView = await client.callTool({ name: 'get_dashboard_view', arguments: { view: 'all' }, _meta: { threadId: ids.main } });
    assert.ok((appView._meta?.dashboard as Dashboard).sessions.length > 0);
    assert.ok(!('sessions' in (appView.structuredContent as object)));
    const changed = await client.callTool({ name: 'query_usage_dashboard', arguments: { includeChildren: false }, _meta: { threadId: ids.main } });
    const own = changed.structuredContent as unknown as Dashboard;
    assert.equal(own.selected?.agents.length, 1); assert.equal(own.selected?.totals.total, 2480000);
    assert.equal(own.selected?.totals.cacheRate, 0.95);
    assert.equal(all.selected?.models.reduce((s, m) => s + m.total, 0), 6200000);
    const other = await client.callTool({ name: 'query_usage_dashboard', arguments: {}, _meta: { threadId: ids.import } });
    assert.equal((other.structuredContent as unknown as Dashboard).selected?.id, ids.import);
    const unbound = await client.callTool({ name: 'open_thread_usage', arguments: {} });
    assert.equal((unbound.structuredContent as unknown as Dashboard).selected, null);
    const bad = await client.callTool({ name: 'query_usage_dashboard', arguments: { includeChildren: 'false' } });
    assert.equal(bad.isError, true);
  } finally { await client.close(); }
});

test('local fallback enforces host/origin/token, validates input, and preserves incomplete data state', async () => {
  await using fixtureData = await fixture();
  const service = new UsageService(fixtureData);
  const html = await readFile('plugin/dist/dashboard.html', 'utf8');
  const web = await startLocalWeb(html, 0, input => service.queryParsed(input, undefined, true));
  const token = new URLSearchParams(new URL(web.url).hash.slice(1)).get('access_token')!;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: web.origin };
  try {
    const page = await fetch(web.origin); assert.equal(page.status, 200);
    assert.match(page.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
    const denied = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
    const cross = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' }); assert.equal(cross.status, 403);
    const malformed = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', headers, body: '{' }); assert.equal(malformed.status, 400);
    const invalid = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', headers, body: '{"view":"invalid"}' }); assert.equal(invalid.status, 400);
    const result = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', headers, body: JSON.stringify({ sessionId: ids.import }) });
    const data = await result.json() as Dashboard;
    assert.equal(data.selected?.missingChildren, 2); assert.equal(data.selected?.totals.total, 762000);
    const empty = await fetch(`${web.origin}/api/dashboard`, { method: 'POST', headers, body: JSON.stringify({ view: 'all', search: 'no such session' }) });
    const noMatch = await empty.json() as Dashboard; assert.deepEqual(noMatch.sessions, []); assert.equal(noMatch.selected, null);
  } finally { await web.close(); await service.close(); }
});
