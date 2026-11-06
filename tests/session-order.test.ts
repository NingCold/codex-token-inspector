import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainSessionOrder } from '../web/session-order.js';
import { getDashboard } from '../src/dashboard.js';
import type { IndexSnapshot, ThreadInfo } from '../src/types.js';

test('browsing order survives live updates and filters; manual refresh resets the order', () => {
  const initial = retainSessionOrder([{ id: 'A', total: 1 }, { id: 'B', total: 2 }], []);
  const polled = retainSessionOrder([{ id: 'C', total: 3 }, { id: 'B', total: 20 }, { id: 'A', total: 10 }], initial.order);
  assert.deepEqual(polled.rows.map(row => [row.id, row.total]), [['A', 10], ['B', 20], ['C', 3]]);
  const filtered = retainSessionOrder([{ id: 'B', total: 21 }], polled.order);
  assert.deepEqual(filtered.rows.map(row => row.id), ['B']);
  const restored = retainSessionOrder([{ id: 'C' }, { id: 'B' }, { id: 'A' }], filtered.order);
  assert.deepEqual(restored.rows.map(row => row.id), ['A', 'B', 'C']);
  assert.deepEqual(retainSessionOrder([{ id: 'C' }, { id: 'B' }, { id: 'A' }], restored.order, true).order, ['C', 'B', 'A']);
});

test('the default all-session selection remains pinned after the newest session changes', () => {
  const thread = (id: string, updatedAt: number): ThreadInfo => ({ id, title: id, updatedAt, cwd: '', parentId: null, kind: 'main', nickname: null, archived: false });
  const snapshot: IndexSnapshot = { threads: [thread('A', 200), thread('B', 100)], requests: [], sources: [], status: { running: false, completedFiles: 0, totalFiles: 0, lastIndexedAt: null, error: null, sourceWarnings: [] } };
  const first = getDashboard(snapshot, { view: 'all' });
  assert.equal(first.scope.sessionId, 'A');
  snapshot.threads[1].updatedAt = 300;
  const next = getDashboard(snapshot, first.scope);
  assert.equal(next.sessions[0].id, 'B');
  assert.equal(next.selected?.id, 'A');
  assert.equal(getDashboard(snapshot, { ...next.scope, refresh: true }).selected?.id, 'A');
  snapshot.threads[0].updatedAt = 300;
  snapshot.threads.reverse();
  assert.deepEqual(getDashboard(snapshot, { view: 'all' }).sessions.map(row => row.id), ['A', 'B']);
  assert.equal(getDashboard(snapshot, { ...next.scope, search: 'no match' }).selected, null);
});
