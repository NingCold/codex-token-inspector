import { UsageIndex, type IndexOptions } from './indexer.js';
import { prepareDashboardView, querySchema, type ParsedQuery, type Query } from './dashboard.js';
import { resolveBinding } from './binding.js';

export class UsageService {
  readonly index: UsageIndex;
  private prepared: ReturnType<typeof prepareDashboardView> | undefined;
  private generation?: number;
  private backgroundError: string | null = null;
  constructor(options: IndexOptions = {}) { this.index = new UsageIndex(options); }
  async query(input: Query = {}, requestMeta?: unknown, waitForIndex = false) {
    return this.queryParsed(querySchema.parse(input), requestMeta, waitForIndex);
  }
  async queryParsed(query: ParsedQuery, requestMeta?: unknown, waitForIndex = false) {
    const binding = resolveBinding(requestMeta, query.view === 'current' ? query.sessionId : undefined);
    const refresh = this.index.refresh(binding.threadId ?? query.sessionId, waitForIndex || query.refresh);
    // Warm view changes never wait for disk scanning. Polling picks up committed generations.
    if (!this.prepared || waitForIndex || query.refresh) { await refresh; this.backgroundError = null; }
    else void refresh.then(() => { this.backgroundError = null; }, error => { this.backgroundError = error instanceof Error ? error.message : String(error); });
    const generation = this.index.generation();
    if (!this.prepared || generation !== this.generation) {
      this.prepared = prepareDashboardView(this.index.snapshot());
      this.generation = generation;
    }
    const status = this.index.status();
    return this.prepared(query, binding, { ...status, error: status.error || this.backgroundError });
  }
  close() { return this.index.close(); }
}
let service: UsageService | undefined;
export const getService = () => service ??= new UsageService();
export const closeService = () => service?.close();
