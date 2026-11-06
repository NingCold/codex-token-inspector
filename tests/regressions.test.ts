import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageService } from '../src/service.js';
import { fixture, ids, line, context, request } from './fixtures.js';

test('rejected requests are unknown, valid zero is known, and partial totals remain additive', async () => {
  await using data = await fixture();
  const service = new UsageService(data);
  const meta = line('session_meta', { id: ids.docs });
  const check = async (body: string, total: number | null) => {
    await writeFile(data.files.docs, meta + body);
    const child = (await service.query({}, { threadId: ids.docs }, true)).selected!;
    assert.equal(child.totals.total, total);
    assert.equal(child.agents[0].total, total);
    const all = await service.query({ view: 'all', compactSessions: true, sessionId: ids.main }, undefined, true);
    assert.equal(all.selected!.totals.unknownAgents, Number(total === null));
    assert.equal(all.sessions.find(s => s.id === ids.main)!.total, 5580000 + (total ?? 0));
    return child;
  };
  try {
    const invalid = line('token_usage_record', { thread_id: ids.docs, usage: { input_tokens: 100 } });
    await check(invalid, null);
    await check(request(ids.docs, 'a', 't', 100, 0, 10) + request(ids.docs, 'a', 't', 200, 0, 10), null);
    assert.equal((await check(request(ids.docs, 'zero', 't', 0, 0, 0), 0)).totals.requests, 1);
    assert.equal((await check(invalid + request(ids.docs, 'good', 't', 100, 0, 10), 110)).totals.requests, 1);
    // A fork can contain another thread's rejected request. Rebuild its old
    // un-attributed diagnostic, without charging the otherwise empty fork.
    await writeFile(data.files.docs, meta);
    await writeFile(data.files.fork, line('session_meta', { id: ids.fork, forked_from_id: ids.main }) + invalid);
    await service.index.refresh(undefined, true);
    const db = new DatabaseSync(join(data.dataDir, 'usage-v1.sqlite'));
    try { db.prepare("UPDATE sources SET data=json_remove(data,'$.state.invalidThreads') WHERE path=?").run(data.files.fork); }
    finally { db.close(); }
    const owner = (await service.query({}, { threadId: ids.docs }, true)).selected!;
    assert.equal(owner.totals.total, null);
    const list = await service.query({ view: 'all', compactSessions: true });
    assert.equal(list.sessions.find(s => s.id === ids.fork)?.total, 0);
  } finally { await service.close(); }
});

test('a token_count split across read blocks is recovered even from an older index', async () => {
  await using data = await fixture();
  const meta = line('session_meta', { id: ids.legacy });
  const snapshot = line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } });
  const pad = 256 * 1024 - Buffer.byteLength(meta + line('message', '')) - snapshot.indexOf('token_count') - 3;
  await writeFile(data.files.legacy, meta + line('message', 'x'.repeat(pad)) + snapshot);
  const service = new UsageService(data);
  try {
    await service.index.refresh(ids.legacy, true);
    const db = new DatabaseSync(join(data.dataDir, 'usage-v1.sqlite'));
    try {
      db.prepare("UPDATE sources SET data=json_set(data,'$.parserVersion',2,'$.state.lastSnapshot',NULL) WHERE path=?").run(data.files.legacy);
    } finally { db.close(); }
    const result = await service.query({}, { threadId: ids.legacy }, true);
    assert.equal(result.selected?.totals.total, 550);
  } finally { await service.close(); }
});

test('late model context backfills exact turns across scans without guessing ambiguous models', async () => {
  await using data = await fixture();
  let service = new UsageService(data);
  const query = async () => (await service.query({ includeChildren: false }, { threadId: ids.import }, true)).selected!;
  try {
    await appendFile(data.files.import, request(ids.import, 'late-model', 'late-turn', 100, 80, 10));
    const before = await query();
    assert.equal(before.unknownModelRequests, 1);
    await appendFile(data.files.import, context('late-turn', 'gpt-6-astra'));
    const after = await query();
    assert.equal(after.unknownModelRequests, 0);
    assert.equal(after.models.find(m => m.model === 'gpt-6-astra')?.total, 110);
    assert.equal(after.totals.total, before.totals.total);
    await service.close(); service = new UsageService(data);
    assert.equal((await query()).unknownModelRequests, 0);
    // A later conflicting context invalidates only the inferred association.
    await appendFile(data.files.import, context('late-turn', 'gpt-6.1-sol'));
    assert.equal((await query()).unknownModelRequests, 1);
    await appendFile(data.files.import, request(ids.import, 'same-scan', 'same-scan-turn', 50, 40, 5)
      + context('same-scan-turn', 'gpt-6-astra')
      + request(ids.import, 'no-context', 'unrelated-turn', 20, 10, 2));
    const final = await query();
    assert.equal(final.models.find(m => m.model === 'gpt-6-astra')?.total, 55);
    assert.equal(final.unknownModelRequests, 2);
    assert.equal(final.models.reduce((n, m) => n + m.total, 0), final.totals.total);
  } finally { await service.close(); }
});

test('log relationships supplement incomplete catalogs across refreshes and index reopen', async () => {
  await using data = await fixture();
  let service = new UsageService(data);
  try {
    await service.query({}, { threadId: ids.main }, true);
    const db = new DatabaseSync(join(data.codexHome, 'state_5.sqlite'));
    try { db.exec('DROP TABLE thread_spawn_edges; UPDATE threads SET source=NULL;'); } finally { db.close(); }
    // All logs are unchanged and take the incremental fast path.
    for (let i = 0; i < 2; i++) {
      const result = await service.query({}, { threadId: ids.main }, true);
      assert.equal(result.selected?.totals.total, 6200000);
      assert.equal(result.selected?.childCount, 3);
      assert.equal(result.selected?.title, 'Token 插件开发');
      assert.equal(result.selected?.agents.find(a => a.id === ids.tests)?.parentId, ids.code);
      assert.equal(result.selected?.models.reduce((sum, m) => sum + m.total, 0), 6200000);
    }
    await service.close(); service = new UsageService(data);
    const reopened = await service.query({}, { threadId: ids.main }, true);
    assert.equal(reopened.selected?.totals.total, 6200000);
    assert.equal((await service.query({ includeChildren: false }, { threadId: ids.main }, true)).selected?.totals.total, 2480000);
  } finally { await service.close(); }
});

test('catalog parent relationships and guardian exclusions survive log supplementation', async () => {
  await using data = await fixture();
  const db = new DatabaseSync(join(data.codexHome, 'state_5.sqlite'));
  try {
    db.prepare('UPDATE thread_spawn_edges SET parent_thread_id=? WHERE child_thread_id=?').run(ids.import, ids.code);
    db.prepare('UPDATE threads SET source=? WHERE id=?').run(JSON.stringify({ subagent: 'guardian_review' }), ids.docs);
    db.prepare('INSERT INTO threads(id, source) VALUES(?, ?)').run('guardian-root', JSON.stringify({ subagent: 'guardian_review' }));
  } finally { db.close(); }
  const service = new UsageService(data);
  try {
    const main = await service.query({}, { threadId: ids.main }, true);
    assert.equal(main.selected?.totals.total, 2480000);
    assert.equal(main.selected?.childCount, 0);
    const other = await service.query({ view: 'all', sessionId: ids.import }, undefined, true);
    assert.equal(other.selected?.totals.total, 3862000);
    assert.equal(other.selected?.agents.find(a => a.id === ids.code)?.parentId, ids.import);
    assert.ok(other.sessions.some(s => s.id === ids.main));
    assert.ok(!other.sessions.some(s => s.id === 'guardian-root'));
  } finally { await service.close(); }
});

test('unsafe legacy snapshots report unknown usage while known scopes remain additive', async () => {
  await using data = await fixture();
  await writeFile(data.files.fork, line('session_meta', { id: ids.fork, forked_from_id: ids.main,
    source: { subagent: { thread_spawn: { parent_thread_id: ids.main } } } })
    + line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } }));
  const service = new UsageService(data);
  try {
    const fork = (await service.query({}, { threadId: ids.fork }, true)).selected!;
    assert.equal(fork.totals.total, null);
    assert.equal(fork.totals.input, null);
    assert.equal(fork.totals.output, null);
    assert.equal(fork.totals.cached, null);
    assert.equal(fork.totals.requests, 0);
    assert.equal(fork.totals.unknownAgents, 1);
    assert.equal(fork.agents[0].available, true);
    assert.equal(fork.agents[0].basis, 'unknown');
    assert.equal(fork.agents[0].total, null);
    assert.deepEqual(fork.models, []);
    assert.ok(fork.issues.some(s => s.includes('无法确认本线程用量')));
    const main = (await service.query({}, { threadId: ids.main }, true)).selected!;
    assert.equal(main.totals.total, 6200000);
    assert.equal(main.totals.unknownAgents, 1);
    assert.equal(main.childUsage.unknownAgents, 1);
    assert.equal(main.mainUsage.unknownAgents, 0);
    assert.equal(main.models.reduce((sum, m) => sum + m.total, 0), main.totals.total);
    const own = (await service.query({ includeChildren: false }, { threadId: ids.main }, true)).selected!;
    assert.equal(own.totals.total, 2480000);
    assert.equal(own.totals.unknownAgents, 0);
    assert.deepEqual(own.issues, []);
    const legacy = (await service.query({}, { threadId: ids.legacy }, true)).selected!;
    assert.equal(legacy.totals.total, 550);
    assert.equal(legacy.models[0].requests, 0, 'a cumulative snapshot is not a request');
    assert.equal(legacy.agents[0].basis, 'snapshot');
    assert.equal(legacy.totals.unknownAgents, 0);
  } finally { await service.close(); }
});

test('non-object JSON lines are skipped without losing earlier or later requests', async () => {
  await using data = await fixture();
  const service = new UsageService(data);
  try {
    await service.query({}, { threadId: ids.main }, true);
    await appendFile(data.files.tests, 'null\n42\ntrue\n"text"\n[]\n'
      + request(ids.tests, 'after-invalid', 'turn-test', 100, 80, 10));
    for (let i = 0; i < 2; i++) {
      const result = (await service.query({}, { threadId: ids.main }, true)).selected!;
      assert.equal(result.totals.total, 6200110);
      assert.equal(result.missingChildren, 0);
      assert.ok(result.issues.some(s => s.includes('无法解析或无效')));
      assert.ok(!result.issues.some(s => s.includes('日志未找到')));
      const source = service.index.snapshot().sources.find(s => s.path === data.files.tests)!;
      assert.equal(source.available, true);
      assert.equal(source.state.malformed, 5);
      assert.equal(source.error, null);
    }
  } finally { await service.close(); }
});

test('archiving clears stale path warnings without hiding a different missing file', async () => {
  await using data = await fixture();
  const service = new UsageService(data);
  try {
    await service.query({}, { threadId: ids.main }, true);
    const archive = join(data.codexHome, 'archived_sessions');
    await mkdir(archive);
    await rename(data.files.docs, join(archive, `rollout-${ids.docs}.jsonl`));
    for (let i = 0; i < 2; i++) {
      const moved = (await service.query({}, { threadId: ids.main }, true)).selected!;
      assert.equal(moved.totals.total, 6200000);
      assert.equal(moved.missingChildren, 0);
      assert.deepEqual(moved.issues, []);
    }
    const extra = join(data.codexHome, 'sessions', 'separate-docs.jsonl');
    await writeFile(extra, line('session_meta', { id: ids.docs }) + context('extra-turn', 'gpt-6-luna')
      + request(ids.docs, 'separate-request', 'extra-turn', 100, 80, 10));
    assert.equal((await service.query({}, { threadId: ids.main }, true)).selected?.totals.total, 6200110);
    await rename(extra, join(data.root, 'unavailable-docs.jsonl'));
    const missing = (await service.query({}, { threadId: ids.main }, true)).selected!;
    assert.equal(missing.totals.total, 6200000);
    assert.ok(missing.issues.includes('日志文件未找到'), 'another file for the same thread must not mask a genuine loss');
  } finally { await service.close(); }
});
