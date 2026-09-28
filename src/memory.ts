import { randomUUID } from 'node:crypto';
import { Database, fingerprint } from './database.ts';
import { requireFact } from './errors.ts';
import type { Memory, Message, SourceRef, Work } from './types.ts';

type Entry = Pick<Memory, 'kind' | 'text' | 'sources'>;
interface Summary {
  topicId: string;
  kind: 'memory' | 'handoff';
  version: number;
  through: number;
  entries: Memory[];
}

const sourceOf = (message: Message): SourceRef => ({
  messageId: message.id, version: message.version, assignmentVersion: message.assignmentVersion,
});
const sourceKey = (source: SourceRef): string =>
  JSON.stringify([source.messageId, source.version, source.assignmentVersion]);
const coverageKey = (topicId: string, messageId: string, kind: 'memory' | 'handoff' = 'memory'): string =>
  `memory:coverage:${JSON.stringify([topicId, messageId, kind])}`;
const versionKey = (topicId: string, kind: 'memory' | 'handoff'): string =>
  `memory:version:${JSON.stringify([topicId, kind])}`;
const cycleKey = (topicId: string, kind: 'memory' | 'handoff'): string =>
  `memory:cycle:${JSON.stringify([topicId, kind])}`;

/** Mutations run in the caller's transaction; authorization belongs to the service. */
export class MemoryEngine {
  constructor(private readonly db: Database) {}

  schedule(topicId: string, kind: 'memory' | 'handoff' = 'memory'): Work | null {
    this.db.must('topics', topicId);
    requireFact(kind === 'memory' || kind === 'handoff', 'WORK_KIND', 'Unsupported memory work kind', 400);
    const messages = this.db.find('messages', message => message.topicId === topicId)
      .sort((left, right) => left.sequence - right.sequence);
    if (!messages.length) return null;
    const cutoff = messages[messages.length - 1]!.sequence;
    this.db.setMeta(cycleKey(topicId, kind), Math.max(cutoff, this.db.meta(cycleKey(topicId, kind), 0)));
    const active = this.db.find('work', work => work.topicId === topicId && work.kind === kind
      && (work.state === 'pending' || work.state === 'leased'));
    if (kind === 'handoff' && !active.length && messages.every(message => this.covered(message, kind))) {
      // Only an explicit request can start another handoff over already covered evidence.
      for (const message of messages) this.db.setMeta(coverageKey(topicId, message.id, kind), null);
    }
    return this.enqueue(topicId, kind);
  }

  private covered(message: Message, kind: 'memory' | 'handoff'): boolean {
    return message.topicId !== null
      && this.db.meta<string | null>(coverageKey(message.topicId, message.id, kind), null) === sourceKey(sourceOf(message));
  }

  private completedThrough(topicId: string): number {
    const messages = this.db.find('messages', message => message.topicId === topicId)
      .sort((left, right) => left.sequence - right.sequence);
    let through = 0;
    for (const message of messages) {
      if (!this.covered(message, 'memory')) break;
      through = message.sequence;
    }
    return through;
  }

  private enqueue(topicId: string, kind: 'memory' | 'handoff'): Work | null {
    const cutoff = this.db.meta(cycleKey(topicId, kind), 0);
    const dirty = this.db.find('messages', message => message.topicId === topicId
      && message.sequence <= cutoff && !this.covered(message, kind))
      .sort((left, right) => left.sequence - right.sequence);
    const active = this.db.find('work', work => work.topicId === topicId && work.kind === kind
      && (work.state === 'pending' || work.state === 'leased'));
    // Exact source coverage catches corrections and reclassification below the watermark.
    const reserved = new Set(active.flatMap(work => work.sources.map(sourceKey)));
    const selected = dirty.filter(message => !reserved.has(sourceKey(sourceOf(message)))).slice(0, 200);
    if (!selected.length) return dirty.length ? active[0] ?? null : null;
    const sources = selected.map(sourceOf);
    const through = selected[selected.length - 1]!.sequence;
    const duplicate = active.find(work => work.through === through
      && fingerprint(work.sources) === fingerprint(sources));
    if (duplicate) return duplicate;
    const work: Work = {
      id: randomUUID(), role: 'memory', kind, messageId: null, topicId,
      inputVersion: this.db.meta(versionKey(topicId, kind), 0) + 1,
      stateVersion: this.db.meta('stateVersion', 0), sources, through,
      state: 'pending', epoch: null, token: null, leaseUntil: 0, result: null,
    };
    this.db.put('work', work);
    return work;
  }

  commit(work: Work, entries: Entry[]): Summary {
    const saved = this.db.must('work', work.id);
    requireFact(saved.role === 'memory' && (saved.kind === 'memory' || saved.kind === 'handoff')
      && saved.topicId !== null, 'WORK_KIND', 'Expected topic memory or handoff work');
    requireFact((saved.state === 'pending' || saved.state === 'leased')
      && fingerprint(saved) === fingerprint(work), 'STALE_WORK', 'Memory work is no longer current');
    const topic = this.db.must('topics', saved.topicId);
    requireFact(saved.sources.length > 0 && saved.sources.length <= 200,
      'SOURCE_REQUIRED', 'Memory work requires 1..200 sources', 400);
    const allowed = new Set(saved.sources.map(sourceKey));
    for (const source of saved.sources) {
      const message = this.db.get('messages', source.messageId);
      requireFact(message && message.topicId === topic.id && message.sequence <= saved.through
        && message.version === source.version && message.assignmentVersion === source.assignmentVersion,
      'STALE_SOURCE', 'Memory source was changed, removed, or reclassified');
    }
    requireFact(Array.isArray(entries) && entries.length <= 100,
      'MEMORY_LIMIT', 'A memory batch may contain at most 100 entries', 400);
    // Validate the entire batch before writing, including sources not used by an entry.
    for (const entry of entries) {
      requireFact(entry && ['confirmed', 'reported', 'inferred'].includes(entry.kind),
        'MEMORY_KIND', 'Memory kind must preserve its evidence strength', 400);
      requireFact(typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.text.length <= 16_000,
        'MEMORY_TEXT', 'Memory text must contain 1..16000 characters', 400);
      requireFact(Array.isArray(entry.sources) && entry.sources.length > 0 && entry.sources.length <= 200,
        'SOURCE_REQUIRED', 'Each memory entry requires 1..200 sources', 400);
      for (const source of entry.sources) {
        requireFact(source && typeof source.messageId === 'string' && source.messageId.length > 0
          && source.messageId.length <= 200 && Number.isSafeInteger(source.version) && source.version > 0
          && Number.isSafeInteger(source.assignmentVersion) && source.assignmentVersion >= 0
          && allowed.has(sourceKey(source)),
        'SOURCE_MISMATCH', 'Entry sources must match the exact work snapshot', 400);
      }
    }
    const version = this.db.next(versionKey(topic.id, saved.kind));
    const memories: Memory[] = entries.map(entry => ({
      id: randomUUID(), topicId: topic.id, version, kind: entry.kind, text: entry.text,
      sources: entry.sources.map(source => ({
        messageId: source.messageId, version: source.version, assignmentVersion: source.assignmentVersion,
      })),
      workId: saved.id, valid: true, correction: null,
    }));
    const result: Summary = { topicId: topic.id, kind: saved.kind, version, through: saved.through, entries: memories };
    for (const source of saved.sources) {
      this.db.setMeta(coverageKey(topic.id, source.messageId, saved.kind), sourceKey(source));
    }
    if (saved.kind === 'memory') {
      for (const memory of memories) this.db.put('memories', memory);
      topic.version++;
      topic.memoryThrough = this.completedThrough(topic.id);
      this.db.put('topics', topic);
    } else {
      // Handoff summaries are not ordinary memories and never advance their coverage.
      this.db.setMeta(`memory:handoff:${saved.id}`, result);
    }
    saved.state = 'done';
    saved.result = result;
    this.db.put('work', saved);
    // Continue the explicitly requested wave, not new arrivals beyond its cutoff.
    this.enqueue(topic.id, saved.kind);
    return result;
  }

  invalidate(messageId: string, reason: string): void {
    requireFact(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 4000,
      'CORRECTION_REASON', 'Invalidation requires a reason of 1..4000 characters', 400);
    const message = this.db.must('messages', messageId);
    const affected = new Set<string>();
    if (message.topicId) affected.add(message.topicId);
    for (const memory of this.db.find('memories', item =>
      item.valid && item.sources.some(source => source.messageId === messageId))) {
      memory.valid = false;
      memory.correction = reason;
      this.db.put('memories', memory);
      affected.add(memory.topicId);
      // A multi-source conclusion must be rebuilt from its remaining evidence too.
      for (const source of memory.sources) {
        this.db.setMeta(coverageKey(memory.topicId, source.messageId), null);
      }
    }
    for (const work of this.db.find('work', item =>
      item.sources.some(source => source.messageId === messageId))) {
      if (work.state === 'pending' || work.state === 'leased') {
        work.state = 'invalidated';
        this.db.put('work', work);
        if (work.topicId) affected.add(work.topicId);
      } else if (work.kind === 'handoff' && work.state === 'done') {
        const summary = this.db.meta<Summary | null>(`memory:handoff:${work.id}`, null);
        if (summary) {
          for (const entry of summary.entries) {
            if (entry.valid && entry.sources.some(source => source.messageId === messageId)) {
              entry.valid = false;
              entry.correction = reason;
              for (const source of entry.sources) {
                this.db.setMeta(coverageKey(entry.topicId, source.messageId, 'handoff'), null);
              }
            }
          }
          this.db.setMeta(`memory:handoff:${work.id}`, summary);
          work.result = summary;
          this.db.put('work', work);
        }
      }
    }
    for (const topicId of affected) {
      this.db.setMeta(coverageKey(topicId, messageId), null);
      this.db.setMeta(coverageKey(topicId, messageId, 'handoff'), null);
      const topic = this.db.must('topics', topicId);
      topic.dirtyThrough = Math.max(topic.dirtyThrough, message.sequence);
      topic.memoryThrough = this.completedThrough(topicId);
      this.db.put('topics', topic);
    }
  }

  resumeAffected(messageId: string): void {
    const current = this.db.must('messages', messageId);
    const topics = new Set(this.db.find('work', work => work.role === 'memory'
      && work.sources.some(source => source.messageId === messageId)).flatMap(work => work.topicId ? [work.topicId] : []));
    if (current.topicId) topics.add(current.topicId);
    for (const topicId of topics) {
      const topic = this.db.must('topics', topicId);
      topic.memoryThrough = this.completedThrough(topicId);
      this.db.put('topics', topic);
      for (const kind of ['memory', 'handoff'] as const) {
        if (this.db.meta(cycleKey(topicId, kind), 0) > 0) this.enqueue(topicId, kind);
      }
    }
  }

  list(topicId: string, after = 0, limit = 100) {
    this.db.must('topics', topicId);
    const page = this.db.list('memories', after, limit);
    return { ...page, items: page.items.filter(memory => memory.topicId === topicId) };
  }
}
