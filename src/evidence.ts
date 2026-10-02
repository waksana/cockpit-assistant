import { randomUUID } from 'node:crypto';
import type { NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { z } from 'zod';
import type { Caller, Gateway } from './gateway.ts';
import { requireFact } from './errors.ts';
import { Store, fingerprint } from './store.ts';
import { questionIdentity } from './question.ts';

const id = z.string().min(1).max(200);
const cursor = z.string().max(16384);
const checkpointSchema = z.strictObject({ eventId: id, receiptId: id, readAt: z.number() });
const rangeSchema = z.array(z.strictObject({ eventId: id, hash: z.string() }));
const ticketSchema = z.strictObject({
  id, sessionId: id, owner: id, cursor: cursor.nullable(), boundary: id.nullable(),
  head: id.nullable(), checkpoint: id.nullable(), hash: z.string().nullable(),
  offset: z.number(), receiptId: id.nullable(), next: id.nullable(),
  recoveryIds: z.array(id).nullable(),
  range: rangeSchema.nullable(), expected: rangeSchema.nullable(),
});
const readSchema = z.strictObject({
  id, ticketId: id, sessionId: id, owner: id, toolCallId: id, interactionId: id.nullable(),
  eventIds: z.array(id), messageIds: z.array(id), updateIds: z.array(id), inboxIds: z.array(id),
  questionHash: z.string().nullable(),
  readAt: z.number(), disposition: z.enum(['unresolved', 'silent', 'awaiting-output', 'notified', 'expired-question']),
  decisionInteraction: id.nullable(), decisionToolCallId: id.nullable(),
  outputEventId: id.nullable(), outputMessageId: id.nullable(),
  decidedAt: z.number().nullable(), notifiedAt: z.number().nullable(),
});
type Ticket = z.infer<typeof ticketSchema>;
export type EvidenceRead = z.infer<typeof readSchema>;
export const readInput = z.strictObject({ token: id, offset: z.int().nonnegative().default(0),
  recover: z.boolean().default(false) });
export const resolveInput = z.strictObject({
  receiptId: id, disposition: z.enum(['silent', 'notify']),
});
const primary = (event: NativeChatEvent) => !event.ephemeral && !event.agentId && !event.parentToolCallId
  && !event.data.agentId && !event.data.parentToolCallId;
const evidenceEvent = (event: NativeChatEvent) => primary(event)
  && ['user.message', 'assistant.message', 'session.error', 'abort', 'session.idle'].includes(event.type);
const bodyEvent = (event: NativeChatEvent) => evidenceEvent(event) && event.type !== 'session.idle';
const MAX_EVENTS = 16;
const OUTPUT_CHARS = 12000;
const decisionSchema = z.strictObject({ receiptId: id });
const outputScanSchema = z.strictObject({ checkedAt: z.number(), pages: z.number(),
  evidence: z.enum(['observed', 'unknown']), olderCursor: cursor.nullable() });

/** Only native positions and processing receipts persist here, never conversation bodies. */
export class Evidence {
  constructor(readonly store: Store, readonly native: Gateway, readonly stopped: () => boolean) {}
  private saveTicket(value: Ticket) { this.store.saveState(`ticket:${value.id}`, value, ticketSchema); }
  private ticket(value: Omit<Ticket, 'id' | 'hash' | 'offset' | 'receiptId' | 'next' | 'range'>) {
    const result: Ticket = { ...value, id: randomUUID(), hash: null, offset: 0, receiptId: null, next: null, range: null };
    this.saveTicket(result);
    return result;
  }
  private async page(sessionId: string, max: number, position: string | null) {
    requireFact(!this.stopped(), 'STOPPING', 'Assistant stopped before reading native evidence', 503);
    const page = await this.native.host.call('session/chat', { sessionId, source: 'persisted', direction: 'backward',
      max, bootstrap: false, waitMs: 0, ...(position ? { cursor: position } : {}) });
    requireFact(page.sessionId === sessionId && page.source === 'persisted' && page.direction === 'backward',
      'NATIVE_HISTORY', 'Native Chat returned a different source');
    requireFact(page.events.length <= max && (!page.hasMore || !!page.cursor && page.cursor !== position),
      'NATIVE_HISTORY', 'Native Chat exceeded its page bound or did not advance');
    return page;
  }
  locations(sessionId: string, owner: string, nativeIds: string[]) {
    return this.ticket({ sessionId, owner, cursor: null, boundary: null, head: null,
      checkpoint: null, recoveryIds: nativeIds, expected: null }).id;
  }
  private priorDecisions(receipt: EvidenceRead) {
    return receipt.updateIds.flatMap(eventId => {
      const decision = this.store.state(`decision:${fingerprint([receipt.owner, receipt.sessionId, eventId])}`, decisionSchema);
      const prior = decision ? this.store.state(`read:${decision.receiptId}`, readSchema) : null;
      return prior ? [{ eventId, receiptId: prior.id, disposition: prior.disposition,
        outputEventId: prior.outputEventId, outputMessageId: prior.outputMessageId }] : [];
    });
  }
  async check(sessionId: string, owner: string) {
    const at = Date.now(), page = await this.page(sessionId, 1, null);
    requireFact(page.cursorStatus === 'ok', 'NATIVE_HISTORY', 'The native tail is unavailable; freshness is unknown');
    const head = page.events.at(-1)?.id ?? null;
    const previous = this.store.state(`checkpoint:${sessionId}`, checkpointSchema);
    const changed = head !== (previous?.eventId ?? null);
    const ticket = head ? this.ticket({ sessionId, owner, cursor: null, boundary: previous?.eventId ?? null,
      head: null, checkpoint: previous?.eventId ?? null, recoveryIds: null, expected: null }) : null;
    return { checkedAt: at, source: 'native-chat', headEventId: head, changed, empty: !head,
      readToken: ticket?.id ?? null, lastRead: previous, evidenceInThisResponse: false,
      recovery: 'If prior evidence is not in your context, read with recover:true even when changed:false. Never infer progress from registry text.' };
  }
  async read(caller: Caller, input: z.infer<typeof readInput>) {
    let ticket = this.store.state(`ticket:${input.token}`, ticketSchema);
    requireFact(ticket && ticket.owner === caller.sessionId, 'READ_TOKEN', 'Use this foreground\'s service-issued read token', 403);
    const meta = await this.native.session(ticket.sessionId);
    requireFact(this.store.managed(ticket.sessionId) && meta
      && (Array.isArray(meta.roles) || Array.isArray(meta.appliedRoles))
      && ![...(meta.roles ?? []), ...(meta.appliedRoles ?? [])].some(role => role.moduleId === 'assistant' && role.roleId !== 'worker'),
    'HISTORY_SCOPE', 'The token source must still be a registered business session', 403);
    if (input.recover) {
      requireFact(input.offset === 0, 'READ_OFFSET', 'Recovery starts a new bounded read');
      const previous = ticket.receiptId ? this.store.state(`read:${ticket.receiptId}`, readSchema) : null;
      ticket = this.ticket({ sessionId: ticket.sessionId, owner: caller.sessionId,
        cursor: ticket.cursor, head: null, boundary: null, checkpoint: null,
        recoveryIds: previous?.eventIds.length ? previous.eventIds : ticket.recoveryIds ?? ticket.range?.map(row => row.eventId) ?? null,
        expected: ticket.expected ?? ticket.range });
    }
    requireFact(input.offset <= ticket.offset, 'READ_OFFSET', 'Read fragments consecutively; skipped bytes cannot count as read');
    const page = await this.page(ticket.sessionId, MAX_EVENTS, ticket.cursor);
    const latest = this.store.state(`ticket:${ticket.id}`, ticketSchema);
    requireFact(latest, 'READ_TOKEN', 'The read token disappeared while reading native Chat');
    ticket = latest;
    if (page.cursorStatus !== 'ok') return { status: 'cursor-expired', token: ticket.id,
      evidenceRead: false, recoveryRequired: 'Run assistant_status for a fresh native tail and read its token with recover:true; old coverage remains unknown.' };
    const hash = fingerprint(page);
    if (ticket.hash && ticket.hash !== hash) return { status: 'range-changed', token: ticket.id,
      evidenceRead: false, recoveryRequired: 'Read this token with recover:true to find its exact original event IDs, or check a fresh tail. No read position advanced.' };
    const boundaryIndex = ticket.boundary ? page.events.findIndex(event => event.id === ticket.boundary) : -1;
    const selected = boundaryIndex < 0 ? page.events : page.events.slice(boundaryIndex + 1);
    const originals = selected.filter(event => evidenceEvent(event)
      && (!ticket.recoveryIds || ticket.recoveryIds.includes(event.id)
        || typeof event.data.messageId === 'string' && ticket.recoveryIds.includes(event.data.messageId)));
    for (const event of originals) {
      const expected = ticket.expected?.find(row => row.eventId === event.id);
      requireFact(!expected || expected.hash === fingerprint(event), 'NATIVE_EVENT_CHANGED',
        'An original native event changed contents during recovery; do not substitute it for previously read evidence');
    }
    ticket.range ??= originals.map(event => ({ eventId: event.id, hash: fingerprint(event) }));
    const events = originals.map(event => ({
      eventId: event.id, messageId: typeof event.data.messageId === 'string' ? event.data.messageId : null,
      timestamp: event.timestamp ?? null, type: event.type,
      ...(typeof event.data.content === 'string' ? { content: event.data.content } : {}),
      ...(typeof event.data.message === 'string' ? { error: event.data.message } : {}),
      ...(Array.isArray(event.data.attachments) ? { attachments: event.data.attachments } : {}),
      ...(event.type === 'abort' ? { warning: 'Native processing was interrupted; earlier output may be incomplete.' } : {}),
    }));
    const serialized = JSON.stringify(events);
    ticket.head ??= page.events.at(-1)?.id ?? null;
    ticket.hash = hash;
    const end = Math.min(serialized.length, input.offset + OUTPUT_CHARS);
    ticket.offset = Math.max(ticket.offset, end);
    this.saveTicket(ticket);
    if (end < serialized.length) return { status: 'fragment', token: ticket.id, sessionId: ticket.sessionId,
      encoding: 'JSON', fragment: serialized.slice(input.offset, end), offset: input.offset, nextOffset: end,
      totalCharacters: serialized.length, evidenceRead: false, receiptId: null };
    let receipt = ticket.receiptId ? this.store.state(`read:${ticket.receiptId}`, readSchema) : null;
    if (!receipt) {
      const eventIds = events.map(event => event.eventId);
      const messageIds = events.flatMap(event => event.messageId ? [event.messageId] : []);
      const inboxIds = this.store.inbox().filter(item => item.session_id === ticket.sessionId
        && (eventIds.includes(this.store.source(item.id)?.eventId ?? item.native_id) || messageIds.includes(item.native_id)))
        .map(item => item.id);
      const updateIds = events.filter(event => ['assistant.message', 'session.error', 'abort'].includes(event.type))
        .map(event => event.eventId);
      receipt = { id: randomUUID(), ticketId: ticket.id, sessionId: ticket.sessionId, owner: caller.sessionId,
        toolCallId: caller.toolCallId, interactionId: caller.input?.interactionId ?? null,
        eventIds, messageIds, questionHash: null, updateIds, inboxIds, readAt: Date.now(),
        disposition: updateIds.length ? 'unresolved' : 'silent',
        decisionInteraction: null, decisionToolCallId: null, outputEventId: null, outputMessageId: null, decidedAt: null, notifiedAt: null };
      this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
      ticket.receiptId = receipt.id;
    }
    const remaining = ticket.recoveryIds?.filter(id => !receipt.eventIds.includes(id) && !receipt.messageIds.includes(id)) ?? null;
    const more = page.hasMore && (remaining ? remaining.length > 0
      : ticket.boundary ? boundaryIndex < 0 : !selected.some(bodyEvent));
    if (more && !ticket.next) ticket.next = this.ticket({ sessionId: ticket.sessionId, owner: ticket.owner,
      cursor: page.cursor, boundary: ticket.boundary, head: ticket.head, checkpoint: ticket.checkpoint,
      recoveryIds: remaining, expected: ticket.expected }).id;
    const boundaryMissing = !page.hasMore && !!ticket.boundary && boundaryIndex < 0;
    const complete = !more && (!remaining || remaining.length === 0) && !boundaryMissing;
    if (complete && !ticket.recoveryIds && ticket.head) {
      const current = this.store.state(`checkpoint:${ticket.sessionId}`, checkpointSchema);
      if ((current?.eventId ?? null) === ticket.checkpoint)
        this.store.saveState(`checkpoint:${ticket.sessionId}`,
          { eventId: ticket.head, receiptId: receipt.id, readAt: receipt.readAt }, checkpointSchema);
    }
    this.saveTicket(ticket);
    return { status: 'read', token: ticket.id, sessionId: ticket.sessionId, receipt, priorDispositions: this.priorDecisions(receipt),
      ...(input.offset ? { encoding: 'JSON', fragment: serialized.slice(input.offset, end),
        offset: input.offset, nextOffset: null, totalCharacters: serialized.length } : { events }),
      nextToken: more ? ticket.next : null, complete, boundaryMissing, olderHistoryAvailable: page.hasMore,
      olderCursor: page.cursor, coverage: ticket.boundary ? 'since-prior-read' : ticket.recoveryIds ? 'exact-event-recovery' : 'recent-window',
      missingEventIds: !more ? remaining : null, evidenceRead: true,
      warning: 'A read receipt proves the tool returned this range, not that the user was notified. If the response/context is lost, recover evidence before deciding.' };
  }
  pending(owner: string, after = 0) {
    return this.store.sql.prepare(`SELECT fingerprint FROM seen WHERE id LIKE 'evidence:read:%'
      AND json_extract(fingerprint,'$.owner')=?
      AND json_extract(fingerprint,'$.disposition') IN ('unresolved','awaiting-output')
      AND json_array_length(json_extract(fingerprint,'$.updateIds')) > 0 AND rowid > ?
      ORDER BY rowid LIMIT 50`).all(owner, after).map(row => readSchema.parse(JSON.parse(String(row.fingerprint))));
  }
  async reconcileOutput(owner: string) {
    const waiting = () => this.store.sql.prepare(`SELECT 1 FROM seen WHERE id LIKE 'evidence:read:%'
      AND json_extract(fingerprint,'$.owner')=?
      AND json_extract(fingerprint,'$.disposition')='awaiting-output' LIMIT 1`).get(owner);
    if (!waiting()) return;
    let position: string | null = null, events: NativeChatEvent[] = [], pages = 0, more = true;
    while (more && pages < 4 && waiting()) {
      const page = await this.page(owner, MAX_EVENTS, position);
      pages++;
      if (page.cursorStatus !== 'ok') break;
      events = [...page.events, ...events];
      this.recordOutputs(owner, events);
      position = page.cursor; more = page.hasMore;
    }
    this.store.saveState(`output-scan:${owner}`, { checkedAt: Date.now(), pages,
      evidence: waiting() ? 'unknown' : 'observed', olderCursor: more ? position : null }, outputScanSchema);
  }
  pendingSummary(owner: string, after = 0) {
    const rows = this.pending(owner, after), last = rows.at(-1);
    const nextAfter = last ? Number(this.store.sql.prepare('SELECT rowid FROM seen WHERE id=?')
      .get(`evidence:read:${last.id}`)?.rowid) : after;
    return { items: rows.map(row => ({ receiptId: row.id, readToken: row.questionHash ? null : row.ticketId,
      questionId: row.questionHash ? row.eventIds[0] : null,
      sessionId: row.sessionId, readAt: row.readAt, disposition: row.disposition,
      outputEventId: row.outputEventId, decisionInteraction: row.decisionInteraction })),
    nextAfter, hasMore: rows.length === 50,
    outputRecovery: this.store.state(`output-scan:${owner}`, outputScanSchema) };
  }
  question(caller: Caller, inboxId: string, requestId: string, sessionId: string) {
    const key = `ask-read:${fingerprint([caller.sessionId, caller.toolCallId, inboxId])}`;
    const prior = this.store.state(key, decisionSchema);
    if (prior) {
      const receipt = this.store.state(`read:${prior.receiptId}`, readSchema);
      requireFact(receipt, 'READ_RECEIPT', 'The original question receipt is missing');
      return receipt;
    }
    const receipt: EvidenceRead = { id: randomUUID(), ticketId: requestId, sessionId, owner: caller.sessionId,
      toolCallId: caller.toolCallId, interactionId: caller.input?.interactionId ?? null,
      eventIds: [requestId], messageIds: [], updateIds: [requestId], inboxIds: [inboxId], readAt: Date.now(),
      questionHash: fingerprint(questionIdentity(this.store.inbox().find(item => item.id === inboxId)?.question)),
      disposition: 'unresolved', decisionInteraction: null, outputEventId: null, outputMessageId: null,
      decisionToolCallId: null, decidedAt: null, notifiedAt: null };
    this.store.saveState(key, { receiptId: receipt.id }, decisionSchema);
    this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
    return receipt;
  }
  expireQuestion(inboxId: string) {
    const rows = this.store.sql.prepare(`SELECT fingerprint FROM seen WHERE id LIKE 'evidence:read:%'
      AND json_extract(fingerprint,'$.questionHash') IS NOT NULL
      AND json_extract(fingerprint,'$.disposition')='unresolved'`).all();
    for (const row of rows) {
      const receipt = readSchema.parse(JSON.parse(String(row.fingerprint)));
      if (!receipt.inboxIds.includes(inboxId)) continue;
      receipt.disposition = 'expired-question'; receipt.decidedAt = Date.now();
      this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
    }
  }
  async resolve(caller: Caller, input: z.infer<typeof resolveInput>) {
    let receipt = this.store.state(`read:${input.receiptId}`, readSchema);
    requireFact(receipt && receipt.owner === caller.sessionId, 'READ_RECEIPT', 'Use an actual successful evidence read from this foreground', 403);
    requireFact(receipt.eventIds.length > 0, 'READ_EMPTY', 'An empty read cannot authorize a presentation');
    const disposition = input.disposition === 'notify' ? 'awaiting-output' : 'silent';
    if (receipt.disposition !== 'unresolved') {
      requireFact(receipt.disposition === disposition || input.disposition === 'notify' && receipt.disposition === 'notified',
        'DECISION_CONFLICT', 'This evidence already has a disposition; inspect the original foreground Chat instead of changing or replaying it');
      return receipt;
    }
    if (receipt.questionHash) {
      const current = await this.native.session(receipt.sessionId);
      requireFact(current?.loaded && current.ask
        && fingerprint(questionIdentity(current.ask)) === receipt.questionHash, 'STALE_ASK',
      'The source question is no longer confirmed current; do not present an old decision as live');
      requireFact(input.disposition !== 'silent', 'ASK_PRESENTATION',
        'A currently valid question needs the user; do not silently consume it as an ordinary duplicate update');
      const latest = this.store.state(`read:${input.receiptId}`, readSchema);
      requireFact(latest && latest.disposition === 'unresolved', 'DECISION_CHANGED', 'Another call already decided this question');
      receipt = latest;
    }
    requireFact(!this.stopped(), 'STOPPING', 'Assistant stopped before resolving evidence', 503);
    requireFact(input.disposition !== 'notify' || caller.input?.interactionId,
      'DECISION_PROVENANCE', 'A notification decision needs the current native interaction identity');
    const prior = this.priorDecisions(receipt);
    const matchingInboxIds = () => this.store.inbox().filter(item => item.session_id === receipt.sessionId
      && (receipt.eventIds.includes(this.store.source(item.id)?.eventId ?? item.native_id)
        || receipt.messageIds.includes(item.native_id))).map(item => item.id);
    if (receipt.updateIds.length && receipt.updateIds.every(id => prior.some(row => row.eventId === id))) {
      receipt.disposition = 'silent'; receipt.decidedAt = Date.now();
      this.store.transaction(() => {
        this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
        this.store.removeResolved(matchingInboxIds());
      });
      return { ...receipt, alreadyHandled: true, priorDispositions: prior };
    }
    return this.store.transaction(() => {
      receipt.disposition = disposition; receipt.decidedAt = Date.now();
      receipt.decisionInteraction = caller.input?.interactionId ?? null;
      receipt.decisionToolCallId = caller.toolCallId;
      this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
      for (const eventId of receipt.updateIds) if (!prior.some(row => row.eventId === eventId))
        this.store.saveState(`decision:${fingerprint([receipt.owner, receipt.sessionId, eventId])}`,
          { receiptId: receipt.id }, decisionSchema);
      for (const eventId of receipt.updateIds) {
        const key = `handled:${fingerprint([receipt.sessionId, eventId])}`;
        if (!this.store.receipt(key)) this.store.remember(key, receipt.id);
      }
      this.store.removeResolved(matchingInboxIds());
      return receipt;
    });
  }
  async observeForeground(sessionId: string, event: NativeChatEvent) {
    if (!primary(event) || event.type !== 'assistant.message' || !event.data.interactionId
      || Array.isArray(event.data.toolRequests) && event.data.toolRequests.length
      || typeof event.data.content !== 'string' || !event.data.content.trim()) return;
    await this.reconcileOutput(sessionId);
  }
  recordOutputs(sessionId: string, events: NativeChatEvent[]) {
    for (const [index, event] of events.entries()) {
      if (!primary(event) || event.type !== 'assistant.message' || !event.data.interactionId
        || Array.isArray(event.data.toolRequests) && event.data.toolRequests.length
        || typeof event.data.content !== 'string' || !event.data.content.trim()) continue;
      const rows = this.store.sql.prepare(`SELECT fingerprint FROM seen WHERE id LIKE 'evidence:read:%'
        AND json_extract(fingerprint,'$.owner')=?
        AND json_extract(fingerprint,'$.disposition')='awaiting-output'
        AND json_extract(fingerprint,'$.decisionInteraction')=?`).all(sessionId, String(event.data.interactionId));
      for (const row of rows) {
        const receipt = readSchema.parse(JSON.parse(String(row.fingerprint)));
        const boundary = events.findIndex(candidate => primary(candidate) && candidate.type === 'assistant.message'
          && candidate.data.interactionId === receipt.decisionInteraction
          && Array.isArray(candidate.data.toolRequests) && candidate.data.toolRequests.some(tool =>
            tool && typeof tool === 'object' && 'toolCallId' in tool && tool.toolCallId === receipt.decisionToolCallId));
        if (boundary < 0 || boundary >= index) continue;
        receipt.disposition = 'notified'; receipt.notifiedAt = Date.now();
        receipt.outputEventId = event.id;
        receipt.outputMessageId = typeof event.data.messageId === 'string' ? event.data.messageId : null;
        this.store.saveState(`read:${receipt.id}`, receipt, readSchema);
      }
    }
  }
}
