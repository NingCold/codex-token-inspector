import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Dashboard, Query } from '../src/dashboard.js';
import { connect, type Connection } from './transport.js';
import { formatTokens as number } from './format.js';
import { retainSessionOrder } from './session-order.js';
import './style.css';

const percent = (cached: number | null, input: number | null) => input && cached !== null ? `${(cached / input * 100).toFixed(1)}%` : '—';
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    chart: <><path d="M4 20V11h3v9M10 20V4h3v16M16 20V8h3v12" /></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function DashboardApp() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'current' | 'all'>('current');
  const [compact, setCompact] = useState(false);
  const [listLimit, setListLimit] = useState(40);
  const active = useRef(true);
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState<'agents' | 'models'>('agents');
  const [auto, setAuto] = useState(true);
  const [search, setSearch] = useState('');
  const [scopeChildren, setScopeChildren] = useState(true);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const connection = useRef<Connection | null>(null);
  const query = useRef<Query>({ includeChildren: true, search: '' });
  const explicitThreadId = useRef<string | undefined>(undefined);
  const allSessionId = useRef<string | undefined>(undefined);
  const sessionOrder = useRef<string[]>([]);
  const sequence = useRef(0);
  const visible = useRef(true);
  function acceptData(result: Dashboard, reorder = false) {
    if (result.scope.view === 'current' && result.binding.source === 'explicit' && result.binding.threadId) explicitThreadId.current = result.binding.threadId;
    if (reorder) sessionOrder.current = [];
    if (result.scope.view === 'all') {
      const ordered = retainSessionOrder(result.sessions, sessionOrder.current);
      sessionOrder.current = ordered.order;
      allSessionId.current = result.scope.sessionId;
      result = { ...result, sessions: ordered.rows };
    }
    query.current = result.scope; setView(result.scope.view); setData(result); setScopeChildren(result.scope.includeChildren);
  }
  async function load(next = query.current) {
    if (!connection.current) return;
    query.current = { ...next, refresh: false };
    const id = ++sequence.current; setBusy(true); setError('');
    try { const result = await connection.current.query(next); if (id === sequence.current) acceptData(result, next.refresh === true && !result.index.refreshPending && !result.index.error); }
    catch (e) { if (id === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setScopeChildren(data?.scope.includeChildren ?? true); } }
    finally { if (id === sequence.current) setBusy(false); }
  }
  useEffect(() => {
    let disposed = false, initial = false;
    void connect(result => { if (!disposed) { initial = true; sequence.current++; acceptData(result); setBusy(false); } }, isCompact => { if (!disposed) { active.current = !isCompact; setCompact(isCompact); if (!isCompact && connection.current) void load(); } })
      .then(c => { if (disposed) { c.close(); return; } connection.current = c; if (!initial && active.current) void load(); })
      .catch(e => { if (!disposed) { setError(e.message); setBusy(false); } });
    return () => { disposed = true; sequence.current++; connection.current?.close(); connection.current = null; };
  }, []);
  useEffect(() => { const observer = new IntersectionObserver(entries => { visible.current = entries.some(e => e.isIntersecting); }); observer.observe(document.documentElement); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!auto || compact) return; const id = setInterval(() => { if (document.visibilityState === 'visible' && visible.current && !busy) void load(); }, 5000); return () => clearInterval(id); }, [auto, busy, compact]);
  const current = data?.scope.view === view ? data.selected : null;
  const included = scopeChildren;
  const noUsage = current?.totals.total === null;
  const coverage = [...new Set([...(current?.issues ?? []), ...(data?.index.sourceWarnings ?? [])])];
  const childrenExpanded = !!current && expandedSessions.has(current.id);
  function toggleChildren() {
    if (!current) return;
    setExpandedSessions(previous => { const next = new Set(previous); if (next.has(current.id)) next.delete(current.id); else next.add(current.id); return next; });
  }
  function changeView(next: 'current' | 'all') { setSearch(''); setView(next); setListLimit(40); void load({ includeChildren: included, search: '', view: next, sessionId: next === 'current' ? explicitThreadId.current : allSessionId.current }); }
  if (compact) return <div className="compact-entry"><button className="button" onClick={() => void connection.current?.openPanel?.()}>打开 Token 用量</button></div>;
  return <main className="app">
    <header className="topbar">
      <div className="brand"><Icon name="chart" size={23}/><h1>Token 用量</h1></div>
      <div className="toolbar">
        <label className="auto-label"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>自动刷新</label>
        <div className="refresh-control">
          <button className="button" onClick={() => void load({ ...query.current, refresh: true })} disabled={busy}><Icon name="refresh"/> {busy ? '更新中' : '刷新'}</button>
          <time className="updated-at" dateTime={data?.asOf}>{data ? `${new Date(data.asOf).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} GMT+8` : '—'}</time>
        </div>
      </div>
    </header>
    <nav className="view-nav" aria-label="会话范围"><button aria-pressed={view === 'current'} onClick={() => changeView('current')}>本会话</button><button aria-pressed={view === 'all'} onClick={() => changeView('all')}>全部会话</button></nav>
    <div className={`workspace ${view === 'current' ? 'current-view' : ''}`}>
      {view === 'all' && <aside className="sidebar" aria-label="会话列表">
        <div className="section-label">会话 <span>{data?.scope.view === 'all' ? data.sessions.length : '—'}</span></div>
        <form className="search" onSubmit={e => { e.preventDefault(); setListLimit(40); void load({ ...query.current, search, sessionId: undefined }); }}><Icon name="search"/><input aria-label="搜索会话" placeholder="搜索会话或项目" value={search} onChange={e => setSearch(e.target.value)}/><button type="submit" aria-label="搜索">↵</button></form>
        <div className="list">{data?.sessions.slice(0, listLimit).map(s => <button key={s.id} className={`session ${s.id === current?.id ? 'selected' : ''}`} onClick={() => void load({ ...query.current, sessionId: s.id })}>
          <div className="session-row"><span className="session-title"><span className="session-name" title={s.title}>{s.title}</span><span className="session-project" title={s.project}>{s.project}</span></span><strong className="session-tokens" title={s.total === null ? '未知' : s.total.toLocaleString('en-US') + ' Token'}>{number(s.total)}</strong><Icon name="arrow" size={13}/></div>{s.missingChildren > 0 && included && <span className="warning-badge">缺少 {s.missingChildren} 个子代理日志</span>}
        </button>)}{data?.scope.view === 'all' && !busy && data.sessions.length === 0 && <div className="empty">没有匹配的会话</div>}</div>
        {data && data.sessions.length > listLimit && <button className="button more-sessions" onClick={() => setListLimit(n => n + 40)}>显示更多</button>}
      </aside>}
      <section className="detail" aria-label="用量详情">
        {error && <div role="alert" className="error">{error}</div>}
        {data?.index.error && <div role="alert" className="error">{data.index.error}</div>}
        {data?.index.refreshPending && <div className="index-notice" role="status">仍在索引，完成后可再次刷新。</div>}
        {busy && !current && !error && <div className="empty" role="status">加载中…</div>}
        {current && <>
          <div className="detail-header"><div><div className="eyebrow">会话详情 / {current.project}</div><h2>{current.title}</h2></div>
            <label className="toggle-label">包含子代理<input type="checkbox" role="switch" aria-label="包含子代理" checked={included} onChange={e => { setScopeChildren(e.target.checked); void load({ ...query.current, includeChildren: e.target.checked }); }}/><span className="toggle"/></label>
          </div>
          <div className="scope-line">{included ? <>主代理 <b>{current.mainMissing && !current.mainUsage.requests ? '—' : number(current.mainUsage.total)}</b><span>·</span>子代理 <b>{current.childCount > 0 && current.missingChildren === current.childCount && !current.childUsage.requests ? '—' : number(current.childUsage.total)}</b><span>·</span>{current.issues.length ? '已知合计' : '合计'}</> : <>仅主代理<span>·</span>合计</>} <b>{noUsage ? '—' : number(current.totals.total)}</b></div>
          {coverage.length > 0 && <details className="coverage"><summary>数据提示（{coverage.length}）</summary><ul>{coverage.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
          <div className="metrics">
            <Metric label="输入 Token" value={noUsage ? '—' : number(current.totals.input)} exact={current.totals.input}/>
            <Metric label="输出 Token" value={noUsage ? '—' : number(current.totals.output)} exact={current.totals.output} hint={`推理 ${number(current.totals.reasoning)}`}/>
            <Metric label="缓存命中率" value={percent(current.totals.cached, current.totals.input)}/>
            <Metric label="统计代理" value={String(current.agents.length)} hint={included ? `主代理 1 · 子代理 ${current.childCount}` : '仅主代理自身'}/>
          </div>
          <section className="cache-section" aria-label="缓存读取占比"><div className="cache-track"><span style={{ width: `${(current.totals.cacheRate ?? 0) * 100}%` }}/></div><div className="cache-legend"><span><i/>缓存读取 <b>{number(current.totals.cached)}</b></span><span><i className="muted-dot"/>其他输入 <b>{number(current.totals.cached === null || current.totals.input === null ? null : current.totals.input - current.totals.cached)}</b></span><span>缓存写入 <b>{number(current.totals.cacheWrite)}</b></span></div></section>
          <div className="tabs" role="tablist" aria-label="统计方式"><button role="tab" aria-selected={tab === 'agents'} onClick={() => setTab('agents')}>代理明细</button><button role="tab" aria-selected={tab === 'models'} onClick={() => setTab('models')}>按模型</button></div>
          <div className="table-wrap" role="tabpanel"><table id="usage-table"><thead><tr>{tab === 'agents' && <th>代理</th>}<th>模型</th><th className="numeric">输入</th><th className="numeric">输出</th><th className="numeric">命中率</th></tr></thead>
            {tab === 'agents' ? <>
              <tbody>{current.agents.filter(a => !a.parentId).map(a => <AgentRow key={a.id} agent={a}/>)}
                {included && current.childCount > 0 && <tr className="children-control"><td colSpan={5}><button className="children-toggle" aria-expanded={childrenExpanded} aria-controls="child-agent-rows" onClick={toggleChildren}><Icon name="arrow" size={12}/>{childrenExpanded ? '收起' : '展开'}子代理（{current.childCount}）</button></td></tr>}
              </tbody>
              <tbody id="child-agent-rows" hidden={!childrenExpanded}>{childrenExpanded && current.agents.filter(a => a.parentId).map(a => <AgentRow key={a.id} agent={a}/>)}</tbody>
            </> : <tbody>{current.models.map(m => <tr key={m.model}><td className="model">{m.model}</td><td className="numeric" title={String(m.input)}>{number(m.input)}</td><td className="numeric" title={String(m.output)}>{number(m.output)}</td><td className="numeric rate">{percent(m.cached, m.input)}</td></tr>)}</tbody>}
          </table></div>
        </>}
        {data && !current && !busy && !error && <div className="empty">{view === 'current' ? data.binding.source === 'conflict' ? '会话标识冲突，请重新打开面板。' : data.binding.threadId ? data.index.running ? '正在索引本会话日志…' : '没有找到本会话日志，未替换成其他会话。' : '宿主未提供明确的会话标识。可在聊天中说“打开本会话用量”，或查看全部会话。' : '请选择会话，或调整搜索条件。'}</div>}
      </section>
    </div>
  </main>;
}
function AgentRow({ agent: a }: { agent: NonNullable<Dashboard['selected']>['agents'][number] }) {
  return <tr><td className={a.parentId ? 'child-agent' : 'root-agent'}>{a.parentId && <span className="tree-branch">└</span>}{a.name}{!a.available && <span className="warning-badge">日志缺失</span>}{a.available && a.basis === 'unknown' && <span className="warning-badge">用量未知</span>}</td><td className="model">{a.model}</td><td className="numeric" title={a.input === null ? '未知' : String(a.input)}>{number(a.input)}</td><td className="numeric" title={a.output === null ? '未知' : String(a.output)}>{number(a.output)}</td><td className="numeric rate">{percent(a.cached, a.input)}</td></tr>;
}
function Metric({ label, value, hint, accent, exact }: { label: string; value: string; hint?: string; accent?: boolean; exact?: number | null }) { return <article className={`metric ${accent ? 'accent' : ''}`}><div className="metric-label">{label}</div><strong title={exact == null ? undefined : exact.toLocaleString('en-US') + ' Token'}>{value}</strong>{hint && <small>{hint}</small>}</article>; }
createRoot(document.getElementById('root')!).render(<DashboardApp/>);
