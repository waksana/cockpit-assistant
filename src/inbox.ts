import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireFact } from './errors.ts';
import type { Caller } from './gateway.ts';
import { Store, fingerprint, type InboxItem } from './store.ts';

const id = z.string().min(1).max(200);
const querySchema = z.strictObject({
  source: z.enum(['persisted', 'live']), direction: z.enum(['backward', 'forward']),
  cursor: z.string().min(1).max(32768).optional(),
  since: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(64).optional(),
  max_bytes: z.number().int().min(8192).max(65536).optional(),
  scan_pages: z.number().int().min(1).max(16).optional(),
  bootstrap: z.boolean().optional(),
});
const positionSchema = z.strictObject({
  query: querySchema, nextQuery: querySchema.nullable(), boundaryEventId: id.nullable(),
  hostCheckpoint: z.string().min(1).max(4096).optional(),
  coverage: z.enum(['recent-window', 'since-checkpoint']).default('recent-window'),
});
const checkpointSchema = z.strictObject({ version: id, receiptId: id, position: positionSchema, readAt: z.number() });
const progressSchema = z.strictObject({
  sessionId: id, readIds: z.array(id).max(100), position: positionSchema.nullable(),
  complete: z.boolean(), gap: z.string().min(1).max(1000).nullable(), readAt: z.number(),
});
const receiptSchema = z.strictObject({
  id, owner: id, inboxIds: z.array(id).min(1).max(100), readAt: z.number(),
  sources: z.array(z.strictObject({ sessionId: id, checkpoint: checkpointSchema.nullable() })).max(100),
  progress: z.array(progressSchema).max(100),
  disposition: z.enum(['unresolved', 'silent', 'reported-notified']), decidedAt: z.number().nullable(),
});
const receiptPointer = z.strictObject({ id });
export const resolveInput = z.strictObject({ receiptId: id, disposition: z.enum(['silent', 'notified']) });
export const checkpointInput = z.strictObject({
  receiptId: id, sessionId: id, readIds: z.array(id).max(100).default([]),
  position: positionSchema.nullable(), complete: z.boolean(),
  gap: z.string().min(1).max(1000).nullable().default(null), reset: z.boolean().default(false),
  expectedCheckpointVersion: id.nullable().optional(),
});

export class Inbox {
  constructor(readonly store: Store, readonly stopped: () => boolean) {}
  returned(caller: Caller, items: InboxItem[]) {
    if (!items.length) return null;
    const inboxIds = items.map(item => item.id), key = `inbox-range:${fingerprint([caller.sessionId, inboxIds])}`;
    const pointer = this.store.state(key, receiptPointer);
    if (pointer) {
      const receipt = this.store.state(`inbox-read:${pointer.id}`, receiptSchema);
      requireFact(receipt, 'READ_RECEIPT', 'The original inbox read receipt is missing');
      return receipt;
    }
    const sources = [...new Set(items.map(item => item.session_id))].map(sessionId => ({
      sessionId, checkpoint: this.store.state(`checkpoint:${fingerprint([caller.sessionId, sessionId])}`, checkpointSchema),
    }));
    const receipt = { id: randomUUID(), owner: caller.sessionId, inboxIds, sources, progress: [],
      readAt: Date.now(),
      disposition: 'unresolved' as const, decidedAt: null };
    this.store.transaction(() => {
      this.store.saveState(`inbox-read:${receipt.id}`, receipt, receiptSchema);
      this.store.saveState(key, { id: receipt.id }, receiptPointer);
    });
    return receipt;
  }
  checkpoint(caller: Caller, input: z.infer<typeof checkpointInput>) {
    requireFact(!this.stopped(), 'STOPPING', 'Assistant stopped before recording read position', 503);
    const receipt = this.store.state(`inbox-read:${input.receiptId}`, receiptSchema);
    requireFact(receipt && receipt.owner === caller.sessionId, 'READ_RECEIPT', 'Use this caller session\'s returned inbox receipt', 403);
    requireFact(receipt.disposition === 'unresolved', 'ALREADY_HANDLED', 'This range was already handled');
    const source = receipt.sources.find(item => item.sessionId === input.sessionId);
    requireFact(source, 'CHECKPOINT_SOURCE', 'Read positions must identify a source in this inbox range');
    requireFact(input.complete || !input.readIds.length, 'READ_INCOMPLETE',
      'Do not acknowledge inbox IDs until the intended range and all fragments are complete');
    requireFact(!input.gap || !input.complete, 'READ_GAP', 'A gap cannot be reported as a complete read');
    const ids = new Set(input.readIds);
    requireFact(ids.size === input.readIds.length, 'READ_IDS', 'Read IDs must be distinct');
    const entries = this.store.inbox().filter(item => ids.has(item.id));
    requireFact(input.readIds.every(id => receipt.inboxIds.includes(id))
      && entries.every(item => item.session_id === input.sessionId), 'READ_IDS',
    'Read reports cover only exact IDs from this source and returned range');
    requireFact(input.position || entries.every(item => item.kind === 'ask'), 'READ_POSITION',
      'Chat updates need an actual Host query/continuation and boundary, not a native ID used as a cursor');
    if (input.position && input.complete) requireFact(input.position.boundaryEventId || input.position.hostCheckpoint, 'READ_POSITION',
      'A complete Chat range needs its actual Host checkpoint or event boundary for explicit rereading');
    requireFact(input.position?.coverage !== 'since-checkpoint'
      || source.checkpoint?.position.hostCheckpoint || source.checkpoint?.position.boundaryEventId,
      'CHECKPOINT_BOUNDARY', 'Without a prior boundary, identify the read as a recent window, not complete unread history');
    const previous = receipt.progress.find(item => item.sessionId === input.sessionId);
    requireFact(!previous?.complete || input.complete || input.reset, 'READ_COMPLETE',
      'A completed read cannot regress to partial without an explicit reset');
    if (input.position) {
      const { query, nextQuery } = input.position;
      requireFact(!query.bootstrap || query.source === 'live' && query.direction === 'backward' && !query.cursor,
        'CHECKPOINT_QUERY', 'Bootstrap belongs only to an initial backward live query');
      requireFact(!query.since || query.direction === 'backward' && !query.bootstrap,
        'CHECKPOINT_QUERY', 'Host since reads require backward direction without bootstrap');
      requireFact(!nextQuery || !nextQuery.bootstrap && nextQuery.since === query.since,
        'CHECKPOINT_QUERY', 'Continuation retains the original since token and never bootstraps again');
      requireFact(!nextQuery || nextQuery.source === query.source
        && (nextQuery.direction === query.direction
          || query.bootstrap && query.direction === 'backward' && nextQuery.direction === 'forward'),
      'CHECKPOINT_QUERY', 'Continuation must retain its Host source and direction, except a live bootstrap forward cursor');
    }
    requireFact(!previous?.gap || input.reset, 'READ_GAP', 'Explicitly reset a gapped read; never silently advance it');
    const oldPosition = previous?.position ?? source.checkpoint?.position;
    if (oldPosition && input.position && !input.reset) requireFact(
      oldPosition.query.source === input.position.query.source
      && (oldPosition.query.direction === input.position.query.direction
        || oldPosition.nextQuery?.direction === input.position.query.direction),
      'CHECKPOINT_QUERY', 'Do not mix source/direction; explicitly rebuild the read position if necessary');
    const progress = { sessionId: input.sessionId,
      readIds: [...new Set([...(input.reset ? [] : previous?.readIds ?? []), ...input.readIds])], position: input.position,
      complete: input.complete, gap: input.gap, readAt: Date.now() };
    const key = `checkpoint:${fingerprint([caller.sessionId, input.sessionId])}`;
    const current = this.store.state(key, checkpointSchema);
    const expectedVersion = input.expectedCheckpointVersion === undefined
      ? source.checkpoint?.version ?? null : input.expectedCheckpointVersion;
    const checkpointState = !input.complete || !input.position ? 'not-advanced'
      : current?.receiptId === receipt.id && fingerprint(current.position) === fingerprint(input.position) ? 'unchanged'
        : (current?.version ?? null) === expectedVersion ? 'advanced' : 'stale-base';
    const checkpoint = checkpointState === 'advanced' && input.position
      ? { version: randomUUID(), receiptId: receipt.id, position: input.position, readAt: progress.readAt } : current;
    this.store.transaction(() => {
      receipt.progress = [...receipt.progress.filter(item => item.sessionId !== input.sessionId), progress];
      this.store.saveState(`inbox-read:${receipt.id}`, receipt, receiptSchema);
      if (checkpointState === 'advanced' && checkpoint) this.store.saveState(key, checkpoint, checkpointSchema);
    });
    return { receipt, checkpoint, checkpointState, basis: 'agent-reported-reading', chatReadVerified: false };
  }
  pending(owner: string, after: number) {
    const rows = this.store.sql.prepare(`SELECT seen.rowid AS position, seen.fingerprint FROM seen
      WHERE seen.id LIKE 'evidence:inbox-read:%' AND seen.rowid>?
      AND json_extract(seen.fingerprint,'$.owner')=?
      AND json_extract(seen.fingerprint,'$.disposition')='unresolved'
      AND EXISTS(SELECT 1 FROM json_each(seen.fingerprint,'$.inboxIds') AS returned
        JOIN mailbox ON mailbox.id=returned.value WHERE NOT EXISTS
          (SELECT 1 FROM seen AS archived WHERE archived.id='inbox-archived:'||mailbox.id))
      ORDER BY seen.rowid LIMIT 51`).all(after, owner);
    const selected = rows.slice(0, 50);
    return { items: selected.map(row => receiptSchema.parse(JSON.parse(String(row.fingerprint)))),
      nextAfter: selected.length ? Number(selected.at(-1)!.position) : after, hasMore: rows.length > 50 };
  }
  resolve(caller: Caller, input: z.infer<typeof resolveInput>) {
    requireFact(!this.stopped(), 'STOPPING', 'Assistant stopped before recording inbox handling', 503);
    const receipt = this.store.state(`inbox-read:${input.receiptId}`, receiptSchema);
    requireFact(receipt && receipt.owner === caller.sessionId, 'READ_RECEIPT',
      'Use an actual inbox receipt returned to this caller session', 403);
    const disposition = input.disposition === 'silent' ? 'silent' : 'reported-notified';
    const remaining = new Set(this.store.inbox().map(item => item.id));
    const readIds = new Set(receipt.progress.filter(item => item.complete && !item.gap).flatMap(item => item.readIds));
    requireFact(receipt.inboxIds.every(id => !remaining.has(id) || readIds.has(id)), 'READ_INCOMPLETE',
      'Record the completed read range for every remaining inbox ID before reporting handling');
    requireFact(receipt.disposition === 'unresolved' || receipt.disposition === disposition,
      'DECISION_CONFLICT', 'This inbox range already has a different handling report');
    if (receipt.disposition === 'unresolved') this.store.transaction(() => {
      receipt.disposition = disposition; receipt.decidedAt = Date.now();
      this.store.saveState(`inbox-read:${receipt.id}`, receipt, receiptSchema);
      this.store.removeResolved(receipt.inboxIds);
    });
    return { ...receipt, basis: 'agent-reported-handling', userDeliveryVerified: false,
      chatReadVerified: false };
  }
}
