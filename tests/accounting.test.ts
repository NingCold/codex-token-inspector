import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageService } from '../src/service.js';
import { UsageIndex } from '../src/indexer.js';
import { resolveBinding } from '../src/binding.js';
import { getDashboard } from '../src/dashboard.js';
import { fixture, ids, line, request, context } from './fixtures.js';

test('request ownership, inherited duplicate history, mixed models and nested agents reconcile', async () => {
  const data = await fixture(), service = new UsageService(data);
  try {
    const all = await service.query({}, { threadId: ids.main }, true);
    assert.equal(all.selected?.totals.total, 6200000);
    assert.equal(all.selected?.totals.cacheRate, 0.9);
    assert.equal(all.selected?.totals.requests, 5);
    assert.equal(all.selected?.agents.length, 4);
    assert.equal(all.selected?.models.length, 4);
    assert.equal(all.selected?.models.reduce((n, m) => n + m.total, 0), 6200000);
    assert.equal(all.selected?.mainUsage.total, 2480000);
    const own = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(own.selected?.totals.total, 2480000); assert.equal(own.selected?.totals.cacheRate, .95);
    assert.equal(own.selected?.models.length, 2);
    const fork = await service.query({}, { threadId: ids.fork }, true);
    assert.equal(fork.selected?.totals.total, 0, 'inherited parent requests do not become fork spend');
    const missing = await service.query({}, { threadId: ids.import }, true);
    assert.equal(missing.selected?.missingChildren, 2); assert.equal(missing.selected?.totals.total, 762000);
    const legacy = await service.query({}, { threadId: ids.legacy }, true);
    assert.equal(legacy.selected?.totals.total, 550); assert.equal(legacy.selected?.totals.cached, null);
    assert.equal(legacy.selected?.totals.cacheRate, null); assert.equal(legacy.selected?.totals.requests, 0);
  } finally { await service.close(); }
});

test('an aliased Codex home indexes its logs but does not follow nested links outside it', async () => {
  const data = await fixture();
  const alias = join(data.root, 'home-alias'), external = join(data.root, 'external');
  await symlink(data.codexHome, alias, 'junction');
  await mkdir(external);
  await writeFile(join(external, 'outside.jsonl'), line('session_meta', { id: ids.main }) + request(ids.main, 'outside', 'turn-a', 100, 0, 10));
  await symlink(external, join(data.codexHome, 'sessions', 'linked'), 'junction');
  const service = new UsageService({ ...data, codexHome: alias });
  try {
    const result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 2480000);
    assert.deepEqual(result.index.sourceWarnings, []);
  } finally { await service.close(); }
});

test('incremental byte offsets handle partial UTF-8 records, append, truncation and file moves', async () => {
  const data = await fixture(), service = new UsageService(data);
  try {
    await service.query({}, { threadId: ids.main }, true);
    const extra = Buffer.from(context('新轮次', 'new-model') + request(ids.main, 'new-request', '新轮次', 100, 80, 20));
    const original = await readFile(data.files.main);
    await appendFile(data.files.main, extra.subarray(0, extra.length - 1));
    let result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 2480000, 'unterminated final record is not counted');
    await appendFile(data.files.main, extra.subarray(extra.length - 1));
    result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 2480120);
    await service.query({}, { threadId: ids.main }, true);
    assert.equal((await service.query({ includeChildren: false }, { threadId: ids.main }, true)).selected?.totals.total, 2480120);
    // Replacement drops old observations atomically. The inherited first request still has independent evidence.
    await writeFile(data.files.main, line('session_meta', { id: ids.main }) + context('replacement', 'new-model') + request(ids.main, 'replacement', 'replacement', 200, 100, 30));
    result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 1440230);
    await writeFile(data.files.main, original);
    const moved = data.files.main.replace('.jsonl', '-moved.jsonl'); await rename(data.files.main, moved);
    result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 2480000);
  } finally { await service.close(); }
});

test('two index clients share committed data without double import; model context persists across reopen', async () => {
  const data = await fixture(), first = new UsageIndex(data), second = new UsageIndex(data);
  try {
    await Promise.all([first.refresh(ids.main, true), second.refresh(ids.main, true)]);
    assert.equal(getDashboard(second.snapshot(), {}, { threadId: ids.main, source: 'host' }).selected?.totals.total, 6200000);
    await appendFile(data.files.main, request(ids.main, 'later', 'turn-b', 100, 60, 10));
    await second.refresh(ids.main, true);
    const result = getDashboard(first.snapshot(), { includeChildren: false }, { threadId: ids.main, source: 'host' });
    assert.equal(result.selected?.models.find(m => m.model === 'gpt-6.1-terra')?.total, 1040110);
  } finally { await first.close(); await second.close(); }
});

test('conflicting responses are excluded and unknown cache data is never presented as zero', async () => {
  const data = await fixture(), service = new UsageService(data);
  try {
    await appendFile(data.files.main, request(ids.main, 'r-main-b', 'turn-b', 900000, 500000, 40));
    await appendFile(data.files.main, request(ids.main, 'unknown-cache', 'turn-b', 100, undefined, 10));
    const result = await service.query({ includeChildren: false }, { threadId: ids.main }, true);
    assert.equal(result.selected?.totals.total, 1440110);
    assert.equal(result.selected?.totals.cached, null); assert.equal(result.selected?.totals.cacheRate, null);
    assert.ok(result.selected?.issues.some(s => s.includes('冲突')));
  } finally { await service.close(); }
});

test('current-chat binding uses each request, rejects conflicting IDs, and never guesses newest chat', async () => {
  assert.deepEqual(resolveBinding({ threadId: ids.main, 'x-codex-turn-metadata': { thread_id: ids.main } }), { threadId: ids.main, source: 'host' });
  assert.equal(resolveBinding({ threadId: ids.main, 'x-codex-turn-metadata': { thread_id: ids.import } }).source, 'conflict');
  assert.equal(resolveBinding({ sessionId: ids.main }).threadId, null);
  const data = await fixture(), service = new UsageService(data);
  try {
    assert.equal((await service.query({}, { threadId: ids.main }, true)).selected?.id, ids.main);
    assert.equal((await service.query({}, { threadId: ids.import })).selected?.id, ids.import);
    assert.equal((await service.query({}, undefined)).selected, null);
    assert.equal((await service.query({}, { threadId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).selected, null);
    assert.equal((await service.query({ view: 'all', sessionId: ids.import }, { threadId: ids.main })).selected?.id, ids.import);
  } finally { await service.close(); }
});
