import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { Dashboard, Query } from '../src/dashboard.js';

export interface Connection { query: (input: Query) => Promise<Dashboard>; close: () => void; openPanel?: () => Promise<void> }
function dashboard(value: unknown): Dashboard {
  if (!value || typeof value !== 'object' || !('mode' in value) || value.mode !== 'live' || !('sessions' in value) || !Array.isArray(value.sessions)) throw new Error('无法识别面板数据，请重新打开最新版面板');
  return value as Dashboard;
}
export async function connect(onInitial: (d: Dashboard) => void, onCompact: (compact: boolean) => void): Promise<Connection> {
  if (window.parent === window) {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const secret = fragment.get('access_token') ?? sessionStorage.getItem('cti:local-access');
    if (!secret) throw new Error('缺少本地访问凭据，请通过插件或预览启动器重新打开。');
    sessionStorage.setItem('cti:local-access', secret);
    if (fragment.has('access_token')) {
      if (fragment.get('thread_id')) sessionStorage.setItem('cti:thread', fragment.get('thread_id')!);
      else sessionStorage.removeItem('cti:thread');
    }
    const threadId = sessionStorage.getItem('cti:thread') ?? undefined;
    history.replaceState(null, '', location.pathname);
    return { query: async input => {
      const scoped = { ...input, compactSessions: true, view: input.view ?? (threadId ? 'current' : 'all'), ...(input.view !== 'all' && threadId ? { sessionId: threadId } : {}) };
      const res = await fetch('/api/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(scoped) });
      if (!res.ok) throw new Error(`查询失败（${res.status}），请通过启动器重新打开。`);
      return dashboard(await res.json());
    }, close() {} };
  }
  // Fullscreen height belongs to the host; resize notifications can feed back into history rows.
  const app = new App({ name: 'Codex Token Inspector', version: '0.3.0' }, { availableDisplayModes: ['fullscreen'] }, { autoResize: false });
  let initialSeen = false;
  let initialReady: () => void;
  const firstResult = new Promise<void>(resolve => { initialReady = resolve; });
  app.ontoolresult = result => { if (!initialSeen && (result._meta?.dashboard || result.structuredContent)) {
    try { const value = dashboard(result._meta?.dashboard ?? result.structuredContent); initialSeen = true; onInitial(value); initialReady(); } catch { /* Ignore results saved by an older plugin version. */ }
  } };
  function theme(context: ReturnType<App['getHostContext']>) {
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    const insets = context?.safeAreaInsets;
    if (insets) for (const edge of ['top', 'right', 'bottom', 'left'] as const) document.documentElement.style.setProperty(`--safe-${edge}`, `${insets[edge]}px`);
    if (context?.displayMode) onCompact(context.displayMode === 'inline');
  }
  app.onhostcontextchanged = context => theme(context);
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([app.connect(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('宿主连接超时。可使用插件的本地预览入口。')), 10000); })]); }
  catch (e) { void app.close(); throw e; }
  finally { clearTimeout(timer!); }
  theme(app.getHostContext());
  let resultTimer: ReturnType<typeof setTimeout>;
  await Promise.race([firstResult, new Promise<void>(resolve => { resultTimer = setTimeout(resolve, 500); })]);
  clearTimeout(resultTimer!);
  return { query: async input => {
    const result = await app.callServerTool({ name: 'get_dashboard_view', arguments: { ...input, compactSessions: true } });
    if (result.isError) throw new Error('插件查询失败');
    return dashboard(result._meta?.dashboard ?? result.structuredContent);
  }, close: () => { void app.close(); }, openPanel: async () => { await app.requestDisplayMode({ mode: 'fullscreen' }); } };
}
