import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { ModuleHostApi, ModuleHostIntentResult, NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import { BusinessError, errorText, requireFact } from './errors.ts';
import { RECENT_LIMITS, RecentStore } from './recent-store.ts';
import type { RecentMessage, RecentMetadata, RecentRow } from './recent-store.ts';

export const recentSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(RECENT_LIMITS.queryCharacters),
  limit: z.number().int().min(1).max(RECENT_LIMITS.snippets).default(RECENT_LIMITS.snippets),
});
export interface RecentError { operation: 'inventory' | 'refresh' | 'search' | 'worker'; sessionId?: string; error: string; code?: string }
export interface RecentOptions { onError?: (error: RecentError) => void }
type ChatPage = ModuleHostIntentResult<'session/chat'>;
const validId = (id: string) => id.length > 0 && id.length <= 1024;
const metadata = (meta: RecentMetadata): RecentMetadata => {
  requireFact(validId(meta.sessionId), 'RECENT_IDENTITY', 'Native session ID exceeds the discovery pointer budget');
  return { sessionId: meta.sessionId, title: meta.title.slice(0, 512), cwd: meta.cwd.slice(0, 2048),
    lastActivity: meta.lastActivity, ...(meta.lastActivitySource ? { lastActivitySource: meta.lastActivitySource } : {}) };
};
const sameSource = (a: RecentMetadata, b: RecentMetadata) =>
  a.lastActivity === b.lastActivity && a.lastActivitySource === b.lastActivitySource;

/** Cut only at Unicode scalar boundaries, and never materialize a giant encoded copy. */
export function boundedRecentText(text: string, bytes: number): { text: string; truncated: boolean } {
  let size = 0, end = 0;
  for (const character of text) {
    const next = Buffer.byteLength(character);
    if (size + next > bytes) break;
    size += next; end += character.length;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}
function primaryText(event: NativeChatEvent): string | null {
  if (event.ephemeral || event.agentId || event.parentToolCallId || event.data.agentId || event.data.parentToolCallId
    || (event.type !== 'user.message' && event.type !== 'assistant.message')) return null;
  return typeof event.data.content === 'string' && event.data.content.length ? event.data.content : null;
}
function eventAnchor(head: NativeChatEvent | undefined): string {
  const hash = createHash('sha256');
  if (!head) return hash.update('empty').digest('hex');
  hash.update(JSON.stringify([head.id, head.type, head.timestamp ?? null, head.agentId ?? null, !!head.ephemeral]));
  const text = primaryText(head);
  if (text !== null) hash.update(text);
  return hash.digest('hex');
}

/** Serial, disk-backed pending work. No session load, prompt, live stream, or timer polling. */
export class RecentSessions {
  private started = false;
  private stopped = false;
  private worker: Promise<void> | null = null;
  private inventoryComplete = false;
  private inventoryError: string | null = null;
  private workerError: string | null = null;
  private run: string | null = null;
  private directoryCursor: string | undefined;
  private directoryDone = false;
  private cursorCheckpoint: string | undefined;
  private cursorDistance = 0;
  private cursorPower = 1;
  private searches = new Set<Promise<unknown>>();
  private finalHealth: ReturnType<RecentSessions['health']> | null = null;
  private skipped = 0;
  private refreshed = 0;
  private drifted = 0;
  readonly options: RecentOptions;
  constructor(readonly host: ModuleHostApi, readonly store: RecentStore,
    options: RecentOptions | NonNullable<RecentOptions['onError']> = {}) {
    this.options = typeof options === 'function' ? { onError: options } : options;
  }

  start(): void {
    requireFact(!this.stopped, 'RECENT_STOPPED', 'Recent discovery is stopped', 503);
    if (this.started) return;
    this.started = true;
    this.run = randomUUID();
    this.store.beginInventory();
    this.kick();
  }
  invalidate(sessionId: string, kind: 'dirty' | 'reset' | 'delete' = 'dirty'): void {
    if (this.stopped) return;
    requireFact(validId(sessionId), 'RECENT_SESSION', 'A bounded, exact native session ID is required');
    this.store.invalidate(sessionId, kind, this.run ?? undefined);
    if (this.started) this.kick();
  }
  private report(error: RecentError): void {
    const bounded = { ...error, error: error.error.slice(0, 512) };
    try { this.options.onError?.(bounded); }
    catch (callbackError) { this.workerError = `Error callback failed: ${errorText(callbackError).slice(0, 400)}`; }
  }
  private kick(): void {
    if (this.worker || this.stopped) return;
    this.worker = this.work().catch(error => {
      this.workerError = errorText(error).slice(0, 512);
      this.report({ operation: 'worker', error: this.workerError });
    }).finally(() => {
      this.worker = null;
      if (!this.stopped && !this.workerError) {
        try { if (this.store.next() || !this.directoryDone) this.kick(); }
        catch (error) {
          this.workerError = errorText(error).slice(0, 512);
          this.report({ operation: 'worker', error: this.workerError });
        }
      }
    });
  }
  private async work(): Promise<void> {
    let jobsSinceDirectory = 0;
    while (!this.stopped) {
      const job = this.store.next();
      if (job && (this.directoryDone || jobsSinceDirectory < 32)) {
        this.store.claim(job);
        await this.refresh(job);
        jobsSinceDirectory++;
      } else if (!this.directoryDone) {
        await this.inventoryPage();
        jobsSinceDirectory = 0;
      } else return;
      await yieldTurn();
    }
  }
  private async inventoryPage(): Promise<void> {
    try {
      const page = await this.host.call('session/directory', {
        limit: RECENT_LIMITS.directoryPage, ...(this.directoryCursor ? { cursor: this.directoryCursor } : {}),
      });
      if (this.stopped) return;
      requireFact(page.sessions.length <= RECENT_LIMITS.directoryPage, 'RECENT_DIRECTORY', 'Directory exceeded the requested page limit');
      requireFact(!page.cursor || page.cursor !== this.directoryCursor, 'RECENT_DIRECTORY', 'Directory cursor did not advance');
      if (page.cursor) {
        requireFact(page.cursor !== this.cursorCheckpoint, 'RECENT_DIRECTORY', 'Directory cursor cycle detected');
        if (++this.cursorDistance === this.cursorPower) {
          this.cursorCheckpoint = page.cursor; this.cursorDistance = 0; this.cursorPower *= 2;
        }
      }
      for (const meta of page.sessions) this.store.observe(metadata(meta), this.run!);
      this.directoryCursor = page.cursor;
      if (!page.cursor) {
        this.directoryDone = true;
        this.inventoryComplete = true;
        this.store.prune(this.run!);
      }
    } catch (error) {
      if (this.stopped) return;
      this.directoryDone = true;
      this.inventoryError = errorText(error).slice(0, 512);
      this.report({ operation: 'inventory', error: this.inventoryError });
    }
  }
  private valid(row: RecentRow): boolean {
    return !this.stopped && this.store.get(row.sessionId)?.generation === row.generation;
  }
  private async session(sessionId: string): Promise<RecentMetadata | null> {
    const result = await this.host.call('session/get', { sessionId });
    requireFact(!result.meta || result.meta.sessionId === sessionId, 'RECENT_IDENTITY', 'Native session identity differs');
    return result.meta ? metadata(result.meta) : null;
  }
  private async page(sessionId: string, max: number, cursor?: string): Promise<ChatPage> {
    const result = await this.host.call('session/chat', { sessionId, source: 'persisted', direction: 'backward',
      max, bootstrap: false, waitMs: 0, ...(cursor ? { cursor } : {}) });
    requireFact(result.cursorStatus === 'ok', 'RECENT_CURSOR_EXPIRED', 'Recent native history cursor expired');
    requireFact(result.sessionId === sessionId && result.source === 'persisted' && result.direction === 'backward',
      'RECENT_IDENTITY', 'Native history identity or query differs');
    requireFact(result.events.length <= max, 'RECENT_PAGE', 'Native history exceeded the requested event limit');
    return result;
  }
  private async refresh(row: RecentRow, retry = false): Promise<void> {
    try {
      const before = await this.session(row.sessionId);
      if (!this.valid(row)) return;
      if (!before) { this.store.remove(row.sessionId); return; }
      const head = await this.page(row.sessionId, 1);
      if (!this.valid(row)) return;
      const anchor = eventAnchor(head.events[0]);
      const unchanged = !retry && !row.force && row.syncedActivity === before.lastActivity
        && row.syncedActivitySource === (before.lastActivitySource ?? null) && row.anchor === anchor;
      let messages: RecentMessage[] | null = null;
      let scanLimited = row.scanLimited, truncated = row.truncated;
      if (!unchanged) {
        messages = [];
        scanLimited = false; truncated = false;
        let bytes = 0, cursor: string | undefined, newestFirst: boolean | null = null;
        const seenIds = new Set<string>();
        for (let pages = 0; pages < RECENT_LIMITS.scanPages; pages++) {
          const page = await this.page(row.sessionId, RECENT_LIMITS.pageEvents, cursor);
          if (!this.valid(row)) return;
          if (pages === 0) {
            if (eventAnchor(page.events[0]) === anchor) newestFirst = page.events.length > 1 ? true : null;
            else if (eventAnchor(page.events.at(-1)) === anchor) newestFirst = false;
            else requireFact(false, 'RECENT_CHANGED', 'Native history changed during refresh');
          } else {
            requireFact(newestFirst !== null || page.events.length <= 1,
              'RECENT_ORDER', 'Native recent page order could not be established from the current head');
          }
          const events = newestFirst === false ? [...page.events].reverse() : page.events;
          let budgetReached = false;
          for (let i = 0; i < events.length; i++) {
            const event = events[i]!;
            const text = primaryText(event);
            if (text === null || seenIds.has(event.id)) continue;
            requireFact(validId(event.id)
              && (typeof event.data.messageId !== 'string' || validId(event.data.messageId))
              && (typeof event.timestamp !== 'string' || event.timestamp.length <= 128),
            'RECENT_IDENTITY', 'Native message pointers exceed the discovery metadata budget');
            seenIds.add(event.id);
            const bounded = boundedRecentText(text, Math.min(RECENT_LIMITS.messageBytes, RECENT_LIMITS.sessionBytes - bytes));
            if (!bounded.text) { budgetReached = true; break; }
            bytes += Buffer.byteLength(bounded.text);
            truncated ||= bounded.truncated;
            messages.push({ eventId: event.id, messageId: typeof event.data.messageId === 'string' ? event.data.messageId : null,
              role: event.type === 'user.message' ? 'user' : 'assistant', timestamp: event.timestamp ?? null, ...bounded });
            if (messages.length === RECENT_LIMITS.messages || bytes >= RECENT_LIMITS.sessionBytes) {
              budgetReached = i + 1 < events.length || page.hasMore;
              break;
            }
          }
          scanLimited = budgetReached || page.hasMore;
          if (budgetReached || !page.hasMore) break;
          requireFact(page.cursor && page.cursor !== cursor, 'RECENT_CURSOR', 'Native history cursor did not advance');
          cursor = page.cursor;
        }
        const afterHead = await this.page(row.sessionId, 1);
        if (!this.valid(row)) return;
        requireFact(eventAnchor(afterHead.events[0]) === anchor, 'RECENT_CHANGED', 'Native history changed during refresh');
      }
      const after = await this.session(row.sessionId);
      if (!this.valid(row)) return;
      if (!after) { this.store.remove(row.sessionId); return; }
      requireFact(sameSource(before, after), 'RECENT_CHANGED', 'Native source metadata changed during refresh');
      if (this.store.publish(row, after, anchor, messages, { scanLimited, truncated })) {
        if (unchanged) this.skipped++; else this.refreshed++;
      }
    } catch (error) {
      if (!this.valid(row)) return;
      if (error instanceof BusinessError && error.code === 'RECENT_CHANGED') {
        this.drifted++;
        this.store.defer(row, errorText(error));
        if (!retry) {
          await yieldTurn();
          if (this.valid(row)) await this.refresh(row, true);
        }
        return;
      }
      this.store.fail(row, errorText(error));
      this.report({ operation: 'refresh', sessionId: row.sessionId, error: errorText(error),
        ...(typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? { code: error.code } : {}) });
    }
  }
  search(input: z.input<typeof recentSearchInput> | string, limit: number = RECENT_LIMITS.snippets) {
    requireFact(!this.stopped, 'RECENT_STOPPED', 'Recent discovery is stopped', 503);
    requireFact(this.searches.size < RECENT_LIMITS.concurrentSearches, 'RECENT_BUSY', 'Recent search concurrency limit reached', 503);
    const parsed = recentSearchInput.parse(typeof input === 'string' ? { query: input, limit } : input);
    const promise = this.searchCurrent(parsed).catch(error => {
      if (!this.stopped) {
        this.workerError = errorText(error).slice(0, 512);
        this.report({ operation: 'search', error: this.workerError });
      }
      throw error;
    });
    this.searches.add(promise);
    void promise.then(() => this.searches.delete(promise), () => this.searches.delete(promise));
    return promise;
  }
  private async searchCurrent(input: z.output<typeof recentSearchInput>) {
    const candidates = this.store.candidates(input.query);
    const results: Array<{
      sessionId: string; eventId: string; messageId: string | null; role: 'user' | 'assistant';
      timestamp: string | number | null; snippet: string; truncated: boolean;
      metadata: RecentMetadata; syncedAt: number | null; scanLimited: boolean;
    }> = [];
    const errors: Array<{ sessionId: string; error: string }> = [];
    const checked = new Map<string, RecentMetadata | null>();
    for (const candidate of candidates.slice(0, RECENT_LIMITS.searchCandidates)) {
      if (this.stopped || results.length >= input.limit) break;
      try {
        if (!checked.has(candidate.sessionId)) checked.set(candidate.sessionId, await this.session(candidate.sessionId));
        if (this.stopped) break;
        const meta = checked.get(candidate.sessionId)!;
        const row = this.store.get(candidate.sessionId);
        if (!row || row.generation !== candidate.generation || row.state !== 'current') continue;
        if (!meta) { this.invalidate(candidate.sessionId, 'delete'); continue; }
        if (!sameSource(meta, row.metadata)) { this.invalidate(candidate.sessionId); continue; }
        const text = candidate.message.text;
        const match = text.indexOf(input.query);
        const prefix = [...text.slice(0, match)].slice(-96).join('');
        const snippet = [...prefix + text.slice(match)].slice(0, RECENT_LIMITS.snippetCharacters).join('');
        results.push({ sessionId: candidate.sessionId, eventId: candidate.message.eventId,
          messageId: candidate.message.messageId, role: candidate.message.role, timestamp: candidate.message.timestamp,
          snippet, truncated: candidate.message.truncated || snippet !== text,
          metadata: meta, syncedAt: row.syncedAt, scanLimited: row.scanLimited });
      } catch (error) {
        if (this.stopped) break;
        const failure = { sessionId: candidate.sessionId, error: errorText(error).slice(0, 512) };
        if (errors.length < RECENT_LIMITS.snippets) errors.push(failure);
        checked.set(candidate.sessionId, null);
        const row = this.store.get(candidate.sessionId);
        if (row?.generation === candidate.generation) this.store.fail(row, failure.error);
        this.report({ operation: 'search', ...failure });
      }
    }
    // Another event may have invalidated an earlier candidate while a later native lookup awaited.
    const current = this.stopped ? [] : results.filter(result => {
      const candidate = candidates.find(c => c.sessionId === result.sessionId);
      const row = this.store.get(result.sessionId);
      return row?.state === 'current' && row.generation === candidate?.generation;
    });
    return { results: current, coverage: this.health(), errors,
      resultLimited: candidates.length > RECENT_LIMITS.searchCandidates || results.length >= input.limit,
      discoveryOnly: true as const, nativeChatReadRequired: true as const };
  }
  health(): {
    state: 'warming' | 'ready' | 'partial' | 'stopped'; inventoryComplete: boolean;
    inventoryError: string | null; workerError: string | null; skipped: number; refreshed: number; drifted: number;
    sessions: number; current: number; stale: number; failed: number; pending: number;
    truncated: number; scanLimited: number;
  } {
    if (this.finalHealth) return this.finalHealth;
    const counts = this.store.counts();
    return { state: this.stopped ? 'stopped' : !this.directoryDone || counts.pending || this.worker ? 'warming'
      : this.inventoryError || this.workerError || counts.failed || counts.stale ? 'partial' : 'ready',
    inventoryComplete: this.inventoryComplete, inventoryError: this.inventoryError, workerError: this.workerError,
    skipped: this.skipped, refreshed: this.refreshed, drifted: this.drifted, ...counts };
  }
  async waitIdle(): Promise<void> { while (this.worker) await this.worker; }
  async drain(): Promise<void> {
    await this.waitIdle();
    await Promise.allSettled([...this.searches]);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.drain();
    this.finalHealth = this.health();
  }
}

export { RecentSessions as RecentIndex };
