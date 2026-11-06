import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ids = Object.fromEntries(['main', 'code', 'tests', 'docs', 'import', 'missing1', 'missing2', 'legacy', 'fork'].map((name, i) => [name, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
export const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-29T10:00:00Z', type, payload }) + '\n';
export const context = (turn: string, model: string) => line('turn_context', { turn_id: turn, model, effort: 'high' });
export const request = (thread: string, response: string | null, turn: string, input: number, cached: number | undefined, output: number, reasoning = 0) => line('token_usage_record', {
  thread_id: thread, turn_id: turn, response_id: response, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, cache_write_input_tokens: 0, total_tokens: input + output },
});
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cti-fixture-'));
  const codexHome = join(root, 'codex'), dataDir = join(root, 'index');
  const sessions = join(codexHome, 'sessions'); await mkdir(sessions, { recursive: true });
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,cwd TEXT,source TEXT,updated_at INTEGER,agent_nickname TEXT,archived INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY);');
  const files: Record<string, string> = {};
  const add = async (key: string, title: string, body: string, parent?: string) => {
    const id = ids[key]; files[key] = join(sessions, `rollout-${id}.jsonl`);
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: ids[parent] } } } : 'vscode';
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, title, title, 'D:/fixtures/test', JSON.stringify(source), key === 'main' ? 200 : 100, parent ? title : null, 0);
    if (parent) db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(ids[parent], id);
    await writeFile(files[key], line('session_meta', { id, cwd: 'D:/fixtures/test', source }) + body, 'utf8');
  };
  const first = context('turn-a', 'gpt-6-astra') + request(ids.main, 'r-main-a', 'turn-a', 1400000, 1330000, 40000, 10000);
  await add('main', 'Token 插件开发', first + context('turn-b', 'gpt-6.1-terra') + request(ids.main, 'r-main-b', 'turn-b', 1000000, 950000, 40000, 10000));
  await add('code', '代码实现', line('session_meta', { id: ids.main, source: 'vscode' }) + first + context('turn-code', 'gpt-6.1-sol') + request(ids.code, 'r-code', 'turn-code', 1800000, 1620000, 60000, 10000), 'main');
  await add('tests', '测试检查', context('turn-test', 'gpt-6.1-sol') + request(ids.tests, 'r-test', 'turn-test', 1200000, 1020000, 40000, 5000), 'code');
  await add('docs', '文档整理', context('turn-doc', 'gpt-6-luna') + request(ids.docs, 'r-doc', 'turn-doc', 600000, 480000, 20000, 2000), 'main');
  await add('import', '历史数据导入', context('turn-import', 'gpt-6.1-sol') + request(ids.import, 'r-import', 'turn-import', 740000, 600000, 22000));
  for (const key of ['missing1', 'missing2']) { db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(ids.import, ids[key]); }
  await add('legacy', '旧版累计快照', line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } }));
  await add('fork', '继承历史的分叉', first);
  db.close();
  return { root, codexHome, dataDir, files };
}
