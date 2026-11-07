import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { querySchema } from './dashboard.js';
import { startLocalWeb } from './local-web.js';
import { inspectBinding, resolveBinding } from './binding.js';
import { getService, closeService } from './service.js';
import { panelResult, usageSummary } from './tool-result.js';

const html = await readFile(new URL('./dashboard.html', import.meta.url), 'utf8');
const URI = 'ui://codex-token-inspector/dashboard-v14.html';
const annotation = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
let local: Awaited<ReturnType<typeof startLocalWeb>> | undefined;
let localStarting: Promise<Awaited<ReturnType<typeof startLocalWeb>>> | undefined;
async function getLocalWeb() { return local ??= await (localStarting ??= startLocalWeb(html)); }

function createServer() {
  const server = new McpServer({ name: 'codex-token-inspector', version: '0.3.0' });
  registerAppResource(server, 'Token 用量面板', URI, { description: '本机真实 Token 用量、模型与子代理统计。' }, async () => ({ contents: [{
    uri: URI, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } },
  }] }));
  for (const [name, entrypoint, title] of [
    ['open_usage_dashboard', 'global', 'Token 用量'],
    ['open_thread_usage', 'thread', 'Token 用量明细'],
  ]) {
    registerAppTool(server, name, {
      title, description: entrypoint === 'thread' ? '打开当前会话的真实 Token 用量，自动使用宿主传入的 threadId。宿主缺少上下文时可显式传 sessionId。' : '打开全部会话的真实 Token 用量看板。',
      inputSchema: z.object({ sessionId: z.string().max(100).optional() }), annotations: annotation,
      _meta: { ui: { resourceUri: URI, visibility: ['model', 'app'] }, 'openai/ui': { entrypoints: [{ type: entrypoint }] } },
    }, async (args, context) => panelResult(await getService().query({ ...args, view: entrypoint === 'thread' ? 'current' : 'all', compactSessions: true }, context.mcpReq._meta)));
  }
  server.registerTool('query_usage_dashboard', {
    title: '查询用量面板', description: '查询本机日志中的真实 Token 用量。current 自动关联当前会话；all 浏览全部主会话。包括模型、子代理、索引进度及覆盖诊断。',
    inputSchema: querySchema, annotations: annotation,
  }, async (args, context) => ({ content: [{ type: 'text' as const, text: 'Token 用量查询结果。' }], structuredContent: usageSummary(await getService().queryParsed(args, context.mcpReq._meta)) }));
  server.registerTool('get_dashboard_view', {
    title: '读取面板数据', description: '面板内部查询。', inputSchema: querySchema, annotations: annotation,
    _meta: { ui: { visibility: ['app'] } },
  }, async (args, context) => panelResult(await getService().queryParsed(args, context.mcpReq._meta)));
  server.registerTool('inspect_thread_binding', {
    title: '检查会话关联', description: '检查宿主传入的会话标识和上下文字段，不读取凭据。',
    inputSchema: z.object({}), annotations: annotation,
  }, async (_, context) => ({ content: [{ type: 'text' as const, text: '会话关联检查。' }], structuredContent: inspectBinding(context) }));
  server.registerTool('open_local_preview', {
    title: '打开本地预览', description: '按需启动或复用本机网页，自动携带当前会话标识；在宿主不支持侧边面板时使用。',
    inputSchema: z.object({ sessionId: z.string().max(100).optional() }), annotations: { ...annotation, readOnlyHint: false },
  }, async (args, context) => { const web = await getLocalWeb(); const binding = resolveBinding(context.mcpReq._meta, args.sessionId);
    const url = web.url + (binding.threadId ? `&thread_id=${encodeURIComponent(binding.threadId)}` : '');
    return { content: [{ type: 'text' as const, text: `本机用量面板：${url}` }], structuredContent: { url, mode: 'live', binding } }; });
  return server;
}

if (process.argv.includes('--web')) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  local = await startLocalWeb(html, port);
  const stateFile = resolve(process.cwd(), '.cache/preview.json');
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ pid: process.pid, url: local.url, origin: local.origin, mode: 'live' }), { mode: 0o600 });
  console.error(`Local preview ready on ${local.origin}; launch details saved to .cache/preview.json`);
} else {
  const handle = serveStdio(createServer, { onerror: e => console.error(e.message) });
  process.stdin.once('end', () => { void local?.close(); void closeService(); void handle.close(); });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await local?.close(); await closeService(); process.exit(0); });
