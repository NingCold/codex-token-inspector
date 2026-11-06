import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { emptyState, metadata, parserVersion, scanLog } from './parser.js';
import type { IndexSnapshot, IndexStatus, IndexedRequest, SourceRow, ThreadInfo } from './types.js';

export interface IndexOptions { codexHome?: string; dataDir?: string }
const leaseMs = 120_000;
class LeaseLost extends Error { constructor() { super('索引写入任务已交接，请刷新重试'); } }
export class UsageIndex {
  readonly codexHome: string;
  readonly dataDir: string;
  private db: DatabaseSync;
  private owner = randomUUID();
  private job: Promise<void> | null = null;
  private lastRefresh = 0;
  private nextRenewal = 0;
  private stopped = false;
  constructor(options: IndexOptions = {}) {
    this.codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
    const sourceKey = createHash('sha256').update(this.codexHome).digest('hex').slice(0, 12);
    this.dataDir = resolve(options.dataDir || process.env.CTI_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'CodexTokenInspector', sourceKey));
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, 'usage-v1.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('dataRevision', '0');
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL);
      INSERT OR IGNORE INTO lease VALUES(1, NULL, 0);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (path TEXT PRIMARY KEY REFERENCES sources(path) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS clear_source_cursor AFTER UPDATE OF data ON sources
        BEGIN DELETE FROM cursors WHERE path=NEW.path; END;
      CREATE TABLE IF NOT EXISTS requests (path TEXT NOT NULL, offset INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(path, offset));`);
    // Every request batch commits its source evidence in the same transaction.
    // Track these writes and catalog changes across connections, not lease or status updates.
    for (const table of ['threads', 'sources']) {
      const bump = "UPDATE settings SET value=value+1 WHERE key='dataRevision';";
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_insert_revision AFTER INSERT ON ${table}
        BEGIN ${bump} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_update_revision AFTER UPDATE OF data ON ${table}
        WHEN OLD.data <> NEW.data BEGIN ${bump} END;`);
    }
  }
  private set(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  private get<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) : fallback; }
  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM lease WHERE id=1 AND owner=?').get(this.owner)) throw new LeaseLost();
      this.renewIfDue();
      work();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  generation() { return this.get('dataRevision', 0); }
  private claim() {
    const now = Date.now();
    const claimed = Number(this.db.prepare('UPDATE lease SET owner=?, until_ms=? WHERE id=1 AND (until_ms <= ? OR owner=?)').run(this.owner, now + leaseMs, now, this.owner).changes) === 1;
    if (claimed) this.nextRenewal = now + leaseMs / 4;
    return claimed;
  }
  private renewIfDue() {
    const now = Date.now();
    if (now < this.nextRenewal) return;
    if (!Number(this.db.prepare('UPDATE lease SET until_ms=? WHERE id=1 AND owner=?').run(now + leaseMs, this.owner).changes)) throw new LeaseLost();
    this.nextRenewal = now + leaseMs / 4;
  }
  private statusUpdate(patch: Partial<IndexStatus>) { this.set('status', { ...this.status(), ...patch }); }
  status(): IndexStatus {
    const status = this.get<IndexStatus>('status', { running: false, completedFiles: 0, totalFiles: 0, lastIndexedAt: null, error: null, sourceWarnings: [] });
    const lease = this.db.prepare('SELECT owner,until_ms FROM lease WHERE id=1').get()!;
    return { ...status, running: Boolean(lease.owner && Number(lease.until_ms) >= Date.now()) };
  }
  async refresh(priorityId?: string, wait = false, waitMs = Infinity): Promise<void | 'pending'> {
    const deadline = performance.now() + waitMs;
    if (!this.job && (wait || Date.now() - this.lastRefresh > 1500)) {
      if (this.claim()) {
        this.lastRefresh = Date.now();
        this.job = this.run(priorityId).catch(e => {
          if (e instanceof LeaseLost) throw e;
          this.transaction(() => this.statusUpdate({ error: e instanceof Error ? e.message : String(e) }));
        }).finally(() => {
          this.db.prepare('UPDATE lease SET owner=NULL,until_ms=0 WHERE id=1 AND owner=?').run(this.owner);
          this.job = null;
        });
      }
    }
    if (this.job) {
      let timeout: ReturnType<typeof setTimeout>;
      try {
        if (wait && !Number.isFinite(waitMs)) return await this.job;
        return await Promise.race([this.job, new Promise<void | 'pending'>(r => {
          timeout = setTimeout(() => r(wait ? 'pending' : undefined), wait ? Math.max(0, deadline - performance.now()) : 700);
        })]);
      } catch (e) {
        if (!(e instanceof LeaseLost)) throw e;
      } finally { clearTimeout(timeout!); }
    }
    // On contention or handoff, only an explicit refresh waits for the shared writer.
    while (wait && !this.stopped) {
      const lease = this.db.prepare('SELECT owner,until_ms FROM lease WHERE id=1').get()!;
      if (!lease.owner) return;
      const left = deadline - performance.now();
      if (left <= 0) return 'pending';
      if (Number(lease.until_ms) <= Date.now()) return this.refresh(priorityId, true, left);
      await new Promise(r => setTimeout(r, Math.min(100, left)));
    }
  }
  private async catalog(): Promise<{ threads: ThreadInfo[]; warnings: string[] }> {
    const warnings: string[] = [], threads: ThreadInfo[] = [];
    let candidates: string[];
    try { candidates = (await readdir(this.codexHome)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])); }
    catch { return { threads, warnings: ['未找到 Codex 数据目录'] }; }
    for (const name of candidates) {
      let source: DatabaseSync | undefined;
      try {
        source = new DatabaseSync(join(this.codexHome, name), { readOnly: true });
        source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
        const columns = new Set(source.prepare('PRAGMA table_info(threads)').all().map(r => String(r.name)));
        if (!columns.has('id')) { source.close(); continue; }
        const fields = ['id', 'name', 'title', 'cwd', 'source', 'updated_at', 'updated_at_ms', 'agent_nickname', 'agent_path', 'archived'].filter(n => columns.has(n));
        const rows = source.prepare(`SELECT ${fields.join(',')} FROM threads`).all();
        const edges = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get()
          ? source.prepare('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges').all() : [];
        const parents = new Map(edges.map(r => [String(r.child_thread_id), String(r.parent_thread_id)]));
        for (const row of rows) {
          const parsed = metadata({ ...row, updatedAt: row.updated_at_ms || Number(row.updated_at || 0) * 1000 });
          if (!parsed) continue;
          const parent = parents.get(parsed.id);
          if (parent) { if (parsed.parentId && parsed.parentId !== parent) warnings.push(`父子关联冲突：${parsed.id}`); parsed.parentId = parent; if (parsed.kind === 'main') parsed.kind = 'subagent'; }
          if (!parsed.nickname && row.agent_path) parsed.nickname = String(row.agent_path);
          threads.push(parsed);
        }
        const known = new Set(threads.map(t => t.id));
        for (const [child, parent] of parents) if (!known.has(child)) threads.push({ id: child, title: child, cwd: '', updatedAt: 0, parentId: parent, kind: 'subagent', nickname: null, archived: false });
        source.exec('COMMIT'); source.close(); return { threads, warnings };
      } catch { try { source?.close(); } catch {} warnings.push(`无法读取会话索引 ${name}，使用日志元数据补充`); }
    }
    if (!candidates.length) warnings.push('未找到兼容的会话索引，标题与代理关系仅使用日志元数据');
    return { threads, warnings };
  }
  private async logFiles() {
    const files: string[] = [];
    const visit = async (dir: string) => {
      let entries;
      try { if ((await lstat(dir)).isSymbolicLink()) return; entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
      }
    };
    await visit(join(this.codexHome, 'sessions')); await visit(join(this.codexHome, 'archived_sessions'));
    return files;
  }
  private async fingerprint(path: string, offset: number) {
    const file = await open(path, 'r');
    try {
      const hash = createHash('sha256');
      for (const [start, size] of [[0, Math.min(offset, 4096)], [Math.max(0, offset - 4096), Math.min(offset, 4096)]]) {
        const bytes = Buffer.alloc(size); const { bytesRead } = await file.read(bytes, 0, size, start); hash.update(bytes.subarray(0, bytesRead));
      }
      return hash.digest('hex');
    } finally { await file.close(); }
  }
  // Most files need no overlay. An ordinary message advances the physical cursor,
  // not the timestamp or extent of the evidence used to choose snapshots and match moves.
  private readSource(row: Record<string, unknown>): SourceRow {
    const source = JSON.parse(String(row.data)) as SourceRow;
    return row.cursor ? { ...source, evidenceMtime: source.evidenceMtime ?? source.mtime, evidenceOffset: source.evidenceOffset ?? source.offset, ...JSON.parse(String(row.cursor)) } : source;
  }
  private async run(priorityId?: string) {
    this.transaction(() => this.statusUpdate({ error: null, completedFiles: 0 }));
    const catalog = await this.catalog();
    const files = await this.logFiles();
    // Compare like paths: the configured home can contain a Windows short name or a junction.
    const logRoot = files.length ? await realpath(this.codexHome) : this.codexHome;
    const priority = new Set<string>(priorityId ? [priorityId] : []);
    const descendants = new Map<string, string[]>();
    for (const t of catalog.threads) if (t.parentId) {
      if (!descendants.has(t.parentId)) descendants.set(t.parentId, []);
      descendants.get(t.parentId)!.push(t.id);
    }
    for (const id of priority) for (const child of descendants.get(id) ?? []) priority.add(child);
    const ids = [...priority];
    const priorityFiles = new Set(files.filter(path => ids.some(id => path.includes(id))));
    files.sort((a, b) => Number(priorityFiles.has(b)) - Number(priorityFiles.has(a)) || b.localeCompare(a));
    const discovered = new Set(files);
    const sourceAt = this.db.prepare('SELECT s.data,c.data AS cursor FROM sources s LEFT JOIN cursors c USING(path) WHERE s.path=?');
    this.transaction(() => {
      const upsert = this.db.prepare('INSERT INTO threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE threads.data <> excluded.data');
      for (const t of catalog.threads) upsert.run(t.id, JSON.stringify(t));
      for (const { path } of this.db.prepare('SELECT path FROM sources').all()) {
        if (discovered.has(String(path))) continue;
        const source = this.readSource(sourceAt.get(path)!);
        if (source.available || source.error !== '日志文件未找到') { source.available = false; source.error = '日志文件未找到'; this.db.prepare('UPDATE sources SET data=? WHERE path=?').run(JSON.stringify(source), source.path); }
      }
      this.statusUpdate({ totalFiles: files.length, sourceWarnings: catalog.warnings });
    });
    let completed = 0;
    for (const path of files) {
      if (this.stopped) break;
      this.renewIfDue();
      const saved = sourceAt.get(path);
      const previous = saved ? this.readSource(saved) : null;
      try {
        const resolved = await realpath(path), allowed = relative(logRoot, resolved);
        if (allowed.startsWith('..') || isAbsolute(allowed)) throw new Error('日志路径超出数据目录');
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('跳过非普通日志文件');
        const identity = `${before.dev}:${before.ino}:${before.birthtimeMs}`;
        const compatible = previous?.parserVersion === parserVersion && previous.identity === identity && !(previous.state.invalidUsage && !previous.state.invalidThreads);
        if (compatible && previous.size === before.size && previous.mtime === before.mtimeMs && previous.available && !previous.error) { completed++; continue; }
        let append = Boolean(compatible && before.size >= previous.offset);
        if (append && previous) append = previous.anchor === await this.fingerprint(path, previous.offset);
        if (append && previous && before.size === previous.offset && before.mtimeMs === previous.mtime && previous.available && !previous.error) { completed++; continue; }
        if (append && previous && before.size === previous.size && before.mtimeMs !== previous.mtime) append = false;
        const parsed = await scanLog(path, append ? previous!.offset : 0, before.size, append ? previous!.state : emptyState(), () => this.renewIfDue());
        const after = await lstat(path);
        if (after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs || after.size < before.size || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) throw new Error('日志在读取时被替换，将于下次刷新重新读取');
        const cursor = { offset: parsed.offset, size: before.size, mtime: before.mtimeMs, anchor: await this.fingerprint(path, parsed.offset) };
        this.transaction(() => {
          if (append && previous?.available && !previous.error && !parsed.records.length && isDeepStrictEqual(parsed.state, previous.state)) {
            this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?)').run(path, JSON.stringify(cursor));
            completed++;
            return;
          }
          const source: SourceRow = { parserVersion, path, owner: parsed.state.ownerId, ...cursor, identity, state: parsed.state, available: true, error: null };
          if (!append) this.db.prepare('DELETE FROM requests WHERE path=?').run(path);
          const insert = this.db.prepare('INSERT OR REPLACE INTO requests VALUES(?,?,?)');
          for (const record of parsed.records) insert.run(path, record.offset, JSON.stringify(record));
          this.db.prepare('INSERT INTO sources VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data').run(path, JSON.stringify(source));
          if (source.state.metadata) this.db.prepare('INSERT OR IGNORE INTO threads VALUES(?,?)').run(source.state.metadata.id, JSON.stringify(source.state.metadata));
          this.statusUpdate({ completedFiles: ++completed, lastIndexedAt: new Date().toISOString() });
        });
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        if (previous) this.transaction(() => { previous.available = false; previous.error = e instanceof Error ? e.message : String(e); this.db.prepare('UPDATE sources SET data=? WHERE path=?').run(JSON.stringify(previous), path); });
        else catalog.warnings.push(`无法索引日志：${path.split(/[\\/]/).pop()}`);
        completed++;
      }
    }
    this.transaction(() => this.statusUpdate({ completedFiles: completed, lastIndexedAt: new Date().toISOString(), sourceWarnings: catalog.warnings }));
  }
  snapshot(): IndexSnapshot {
    // A read transaction keeps source availability and request rows from the same committed generation.
    this.db.exec('BEGIN');
    try {
      const sources = this.db.prepare('SELECT s.data,c.data AS cursor FROM sources s LEFT JOIN cursors c USING(path)').all().map(r => this.readSource(r));
      const byPath = new Map(sources.filter(s => s.available).map(s => [s.path, s]));
      const requests: IndexedRequest[] = [];
      for (const row of this.db.prepare('SELECT path,data FROM requests').all()) {
        const source = byPath.get(String(row.path));
        if (source) {
          const record = JSON.parse(String(row.data)) as IndexedRequest;
          const context = record.turnId ? source.state.contexts[record.turnId] : undefined;
          // Context can be logged after usage, even in a later incremental scan. Only
          // backfill from this file and exact turn when its model is unambiguous.
          if (!record.model && source.parserVersion === parserVersion && context?.model && !context.modelAmbiguous) record.model = context.model;
          requests.push({ ...record, path: source.path, owner: source.owner });
        }
      }
      const threads = new Map(this.db.prepare('SELECT data FROM threads').all().map(r => {
        const thread = JSON.parse(String(r.data)) as ThreadInfo;
        return [thread.id, thread] as const;
      }));
      // Merge on every snapshot: unchanged logs may not be scanned again after a catalog refresh.
      // Catalog relationships remain authoritative; cached log metadata fills missing fields.
      for (const source of [...sources].sort((a, b) => Number(b.available) - Number(a.available) || (b.evidenceMtime ?? b.mtime) - (a.evidenceMtime ?? a.mtime))) {
        const log = source.state.metadata;
        if (!log) continue;
        const thread = threads.get(log.id);
        if (!thread) { threads.set(log.id, { ...log }); continue; }
        thread.parentId ??= log.parentId;
        if (thread.kind !== 'guardian') {
          if (log.kind === 'guardian') thread.kind = 'guardian';
          else if (thread.parentId || log.kind === 'subagent') thread.kind = 'subagent';
        }
        thread.nickname ??= log.nickname;
        if (!thread.cwd) thread.cwd = log.cwd;
        if (!thread.title || thread.title === thread.id) thread.title = log.title;
      }
      const result = { sources, requests, threads: [...threads.values()], status: this.status() };
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async close() {
    this.stopped = true;
    try { await this.job; } catch (e) { if (!(e instanceof LeaseLost)) throw e; }
    finally { this.db.close(); }
  }
}
