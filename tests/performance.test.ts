import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { UsageService } from '../src/service.js';
import { UsageIndex } from '../src/indexer.js';
import { fixture, ids, request } from './fixtures.js';
import { panelResult, usageSummary } from '../src/tool-result.js';
import { getDashboard } from '../src/dashboard.js';

test('warm navigation reuses the committed index and does not wait for background scanning', async () => {
  const source = await fixture(), service = new UsageService(source);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await service.query({}, { threadId: ids.main }, true);
    assert.deepEqual(first.sessions, [], 'current view must not transfer the entire session catalog');
    const refresh = service.index.refresh.bind(service.index);
    const snapshot = service.index.snapshot.bind(service.index);
    let reads = 0;
    service.index.refresh = () => pending;
    service.index.snapshot = () => { reads++; return snapshot(); };
    try {
      const navigation = service.query({ view: 'all' }, { threadId: ids.main });
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([navigation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation waited for scanning')), 1000); })]).finally(() => clearTimeout(timer!));
      assert.equal(result.selected?.totals.total, 6200000);
      assert.ok(result.sessions.length > 0);
      const searched = await service.query({ view: 'all', search: '历史数据导入' });
      assert.equal(searched.sessions.length, 1);
      assert.equal(searched.selected?.totals.total, 762000);
      assert.equal(reads, 0);
    } finally { release(); service.index.refresh = refresh; service.index.snapshot = snapshot; }
    service.index.refresh = async () => { throw new Error('Temporary index lock'); };
    try {
      await service.query({}, { threadId: ids.main });
      assert.equal((await service.query({}, { threadId: ids.main })).index.error, 'Temporary index lock');
    } finally { service.index.refresh = refresh; }
    await appendFile(source.files.main, request(ids.main, 'new-cached-request', 'turn-b', 100, 80, 10));
    const changed = await service.query({ refresh: true }, { threadId: ids.main });
    assert.equal(changed.selected?.totals.total, 6200110);
    assert.equal(changed.scope.refresh, false);
    assert.equal(changed.index.error, null, 'successful manual refresh clears background errors');
  } finally { release(); await service.close(); }
});

test('real idle scans reuse the snapshot; a new request from another writer invalidates it', async t => {
  const source = await fixture(), service = new UsageService(source), other = new UsageIndex(source);
  try {
    const first = await service.query({}, { threadId: ids.main }, true);
    const reads = t.mock.method(service.index, 'snapshot');
    await other.refresh(ids.main, true);
    const idle = await service.query({ refresh: true }, { threadId: ids.main });
    assert.notEqual(idle.asOf, first.asOf);
    assert.equal(reads.mock.callCount(), 0);
    await appendFile(source.files.main, request(ids.main, 'external-write', 'turn-b', 100, 80, 10));
    await other.refresh(ids.main, true);
    const result = await service.query({}, { threadId: ids.main });
    assert.equal(result.selected?.totals.total, 6200110);
    assert.equal(reads.mock.callCount(), 1);
  } finally { await service.close(); await other.close(); }
});

test('one model with 150,000 requests reconciles without expanding records on the call stack', () => {
  const count = 150_000;
  const row = { path: 'main', owner: ids.main, threadId: ids.main, turnId: null, timestamp: '', model: 'model', effort: null,
    input: 10, output: 2, total: 12, cached: 8, reasoning: 1, cacheWrite: 0 };
  const result = getDashboard({ threads: [], sources: [], requests: Array.from({ length: count }, (_, i) => ({ ...row, offset: i, responseId: String(i) })),
    status: { running: false, lastIndexedAt: null, totalFiles: 0, completedFiles: 0, error: null, sourceWarnings: [] } }, {}, { threadId: ids.main, source: 'host' });
  assert.equal(result.selected?.models[0].requests, count);
  assert.equal(result.selected?.models[0].total, count * 12);
});

test('chat results are bounded while app-only metadata retains full details', async () => {
  const source = await fixture(), service = new UsageService(source);
  try {
    const result = await service.query({ view: 'all' }, { threadId: ids.main }, true);
    const compact = await service.query({ view: 'all', compactSessions: true }, { threadId: ids.main });
    assert.deepEqual(compact.sessions, result.sessions.map(({ id, title, project, total, missingChildren }) => ({ id, title, project, total, missingChildren })));
    assert.ok('input' in result.sessions[0], 'normal API callers retain detailed rows');
    result.sessions = Array.from({ length: 500 }, (_, i) => ({ ...result.sessions[0], id: `session-${i}` }));
    result.selected!.agents = Array.from({ length: 100 }, (_, i) => ({ ...result.selected!.agents[0], id: `agent-${i}` }));
    const panel = panelResult(result), summary = usageSummary(result);
    assert.equal(panel._meta.dashboard.sessions.length, 500);
    assert.ok(JSON.stringify(panel.structuredContent).length < 1500);
    assert.equal(summary.sessions?.length, 20);
    assert.equal(summary.omittedSessions, 480);
    assert.equal(summary.selected?.agents.length, 12);
    assert.equal(summary.selected?.omittedAgents, 88);
    assert.equal(summary.selected?.totals.total, 6200000);
  } finally { await service.close(); }
});
