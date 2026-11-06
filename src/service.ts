import { UsageIndex, type IndexOptions } from './indexer.js';
import { prepareDashboard, querySchema, type Query } from './dashboard.js';
import { resolveBinding } from './binding.js';

export class UsageService {
  readonly index: UsageIndex;
  private prepared: ReturnType<typeof prepareDashboard> | undefined;
  private generation = '';
  private backgroundError: string | null = null;
  constructor(options: IndexOptions = {}) { this.index = new UsageIndex(options); }
  async query(input: Query = {}, requestMeta?: unknown, waitForIndex = false) {
    const query = querySchema.parse(input);
    const binding = resolveBinding(requestMeta, query.view === 'current' ? query.sessionId : undefined);
    const refresh = this.index.refresh(binding.threadId ?? query.sessionId, waitForIndex || query.refresh);
    // Warm view changes never wait for disk scanning. Polling picks up committed generations.
    if (!this.prepared || waitForIndex || query.refresh) { await refresh; this.backgroundError = null; }
    else void refresh.then(() => { this.backgroundError = null; }, error => { this.backgroundError = error instanceof Error ? error.message : String(error); });
    const generation = this.index.generation();
    if (!this.prepared || generation !== this.generation) {
      this.prepared = prepareDashboard(this.index.snapshot());
      this.generation = generation;
    }
    const result = this.prepared(query, binding);
    const status = this.index.status();
    return { ...result, asOf: status.lastIndexedAt || result.asOf, index: { ...status, error: status.error || this.backgroundError } };
  }
  close() { return this.index.close(); }
}
let service: UsageService | undefined;
export const getService = () => service ??= new UsageService();
export const closeService = () => service?.close();
