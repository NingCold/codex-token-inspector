import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { UsageService } from '../src/service.js';
import { UsageIndex } from '../src/indexer.js';
import { fixture, ids, request } from './fixtures.js';
import { panelResult, usageSummary } from '../src/tool-result.js';

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
      const status = service.index.status.bind(service.index);
      service.index.status = () => ({ ...status(), lastIndexedAt: '2026-10-29T12:00:00.000Z' });
      try {
        assert.equal((await service.query({}, { threadId: ids.main })).asOf, '2026-10-29T12:00:00.000Z', 'completion time updates without rebuilding unchanged aggregates');
      } finally { service.index.status = status; }
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

test('cached aggregates invalidate after another index client commits new usage', async () => {
  const source = await fixture(), service = new UsageService(source), other = new UsageIndex(source);
  try {
    await service.query({}, { threadId: ids.main }, true);
    await appendFile(source.files.main, request(ids.main, 'external-write', 'turn-b', 100, 80, 10));
    await other.refresh(ids.main, true);
    const result = await service.query({}, { threadId: ids.main });
    assert.equal(result.selected?.totals.total, 6200110);
    assert.equal(result.selected?.models.reduce((sum, m) => sum + m.total, 0), 6200110);
  } finally { await service.close(); await other.close(); }
});

test('chat results are bounded while app-only metadata retains full details', async () => {
  const source = await fixture(), service = new UsageService(source);
  try {
    const result = await service.query({ view: 'all' }, { threadId: ids.main }, true);
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
