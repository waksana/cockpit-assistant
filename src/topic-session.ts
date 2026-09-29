import type { McpInvocationMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import type { Runtime } from './runtime.ts';
import { createTopicSessionSchema } from './schema.ts';
import type { AssistantService } from './service.ts';
import type { Operation } from './types.ts';

type TopicSessionRuntime = Pick<Runtime, 'authorize' | 'create' | 'observe'>;
const observations = new WeakMap<AssistantService['db'], Map<string, Promise<Operation>>>();

function createdId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['sessionId', 'createdId'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length) return candidate;
  }
  return createdId(record.result, depth + 1);
}

function details(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function pendingObservation(service: AssistantService, receipt: Operation) {
  const result = details(receipt.result);
  const observation = details(result.observation);
  const nativeKey = result.nativeOperationId;
  const requestId = result.requestId;
  const attempts = typeof observation.attempts === 'number' ? observation.attempts : 0;
  if (receipt.state === 'rejected' || observation.state === 'observed' || attempts >= 3
    || typeof nativeKey !== 'string' || typeof requestId !== 'string') return null;
  const nativeOperation = service.db.get('operations', nativeKey);
  if (!createdId(result) && !createdId(nativeOperation?.result)) return null;
  return { nativeKey, requestKey: `topic-create-request:${requestId}`,
    nextAttemptAt: typeof observation.nextAttemptAt === 'number' ? observation.nextAttemptAt : 0 };
}

export function topicObservationDeadlines(service: AssistantService): number[] {
  return service.db.find('operations', op => op.id.startsWith('topic-create:'))
    .flatMap(receipt => {
      const pending = pendingObservation(service, receipt);
      return pending ? [pending.nextAttemptAt || service.now()] : [];
    });
}

export async function recoverTopicObservations(service: AssistantService, runtime: TopicSessionRuntime): Promise<void> {
  for (const receipt of service.db.find('operations', op => op.id.startsWith('topic-create:'))) {
    const pending = pendingObservation(service, receipt);
    if (pending && pending.nextAttemptAt <= service.now())
      await observeCreated(service, runtime, receipt, pending.requestKey, pending.nativeKey);
  }
}

function observeCreated(service: AssistantService, runtime: TopicSessionRuntime, receipt: Operation,
  requestKey: string, nativeKey: string): Promise<Operation> {
  const { db } = service;
  let pending = observations.get(db);
  if (!pending) {
    pending = new Map();
    observations.set(db, pending);
  }
  const existing = pending.get(requestKey);
  if (existing) return existing;
  const result = details(receipt.result);
  const previousObservation = details(result.observation);
  if (receipt.state === 'rejected' || previousObservation.state === 'observed'
    || typeof previousObservation.attempts === 'number' && previousObservation.attempts >= 3
    || typeof previousObservation.nextAttemptAt === 'number' && previousObservation.nextAttemptAt > service.now()) {
    return Promise.resolve(receipt);
  }
  const nativeOperation = db.get('operations', nativeKey);
  const sessionId = createdId(result) ?? createdId(nativeOperation?.result)
    ?? createdId(result.nativeOperation) ?? createdId(result.nativeResult);
  if (!sessionId) return Promise.resolve(receipt);
  const operation = Promise.resolve().then(async () => {
    const prior = details(result.observation);
    const attempts = (typeof prior.attempts === 'number' ? prior.attempts : 0) + 1;
    if (receipt.state === 'calling' || receipt.state === 'unknown') {
      receipt.state = nativeOperation?.state === 'accepted' ? 'accepted' : 'unknown';
    }
    receipt.result = { ...result, createdId: sessionId,
      ...(nativeOperation ? { nativeOperation } : {}),
      observation: { state: 'pending', attempts, nextAttemptAt: 0 } };
    const save = (): void => db.transaction(() => {
      db.put('operations', receipt);
      db.put('operations', { ...receipt, id: requestKey });
    });
    save();
    let observation: unknown;
    try {
      await runtime.observe(sessionId);
      observation = { state: 'observed', attempts, nextAttemptAt: 0,
        eligible: db.get('receptions', sessionId)?.enabled === true };
    } catch (error) {
      observation = { state: 'failed', attempts, nextAttemptAt: attempts < 3 ? service.now() + 1000 * attempts : 0,
        error: errorText(error) };
    }
    receipt.result = { ...details(receipt.result), observation };
    save();
    return receipt;
  }).finally(() => { pending.delete(requestKey); });
  pending.set(requestKey, operation);
  return operation;
}

/** Creation reserves one native effect per input, independently of its later routing decision. */
export async function createTopicSession(service: AssistantService, runtime: TopicSessionRuntime,
  identity: McpInvocationMeta, input: unknown): Promise<Operation> {
  const value = createTopicSessionSchema.parse(input);
  await runtime.authorize(identity, 'coordinator', value.epoch);
  const { db } = service;
  const key = `topic-create:${value.workId}`;
  const requestKey = `topic-create-request:${value.requestId}`;
  const hash = fingerprint({ identity, input: value });
  // Reauthorization may change only the epoch, never the original intent or work proof.
  const replayFingerprint = fingerprint({ identity, input: { ...value, epoch: 0 } });
  const nativeRequestId = `topic-create:${fingerprint([value.workId, value.requestId])}`;
  const nativeKey = `create:${nativeRequestId}`;
  const replay = db.transaction(() => {
    service.authorize(identity, 'coordinator', value.epoch);
    const prior = db.get('operations', requestKey);
    if (prior) {
      requireFact(prior.fingerprint === hash || prior.state !== 'rejected'
        && details(prior.result).replayFingerprint === replayFingerprint,
      'IDEMPOTENCY_CONFLICT', 'Session creation request changed');
      return { ...prior, id: key };
    }
    const reserved = db.get('operations', key);
    requireFact(!reserved || reserved.state === 'rejected'
      && typeof reserved.result === 'object' && reserved.result !== null
      && 'retryAllowed' in reserved.result && reserved.result.retryAllowed === true,
    'WORK_CREATE_RESERVED', 'This work already reserved session creation; read its original receipt, never create again');
    const work = service.checkWork(identity, 'coordinator', value);
    requireFact(work.kind === 'input' && work.messageId, 'WORK_KIND', 'Only ordinary incoming user input may create a session');
    const message = db.must('messages', work.messageId);
    requireFact(message.version === work.inputVersion, 'STALE_INPUT', 'Input message was corrected');
    requireFact(message.kind === 'user' && !message.historical && !message.sessionId,
      'WORK_KIND', 'Native outputs and historical messages cannot create sessions');
    requireFact(!message.replyTo, 'ANCHOR_MISMATCH', 'Historical anchored input must stay with its original session');
    const receipt: Operation = { id: key, fingerprint: hash, state: 'calling',
      result: { requestId: value.requestId, workId: value.workId, cwd: value.cwd, reason: value.reason,
        replayFingerprint,
        nativeOperationId: nativeKey, createdId: null, observation: 'not_started', retryAllowed: false,
        next: 'Read this receipt; creation alone does not route input or complete work.' } };
    db.put('operations', receipt);
    db.put('operations', { ...receipt, id: requestKey });
    return null;
  });
  if (replay) return observeCreated(service, runtime, replay, requestKey, nativeKey);

  let nativeResult: unknown;
  let nativeError: unknown;
  let failed = false;
  try {
    nativeResult = await runtime.create({ requestId: nativeRequestId, cwd: value.cwd });
  } catch (error) {
    failed = true;
    nativeError = error;
  }
  const nativeOperation = db.get('operations', nativeKey);
  const sessionId = createdId(nativeOperation?.result) ?? createdId(nativeResult) ?? createdId(nativeError);
  // Only a known rejection before Runtime reserved its native intent permits a corrected choice.
  const retryAllowed = failed && nativeError instanceof BusinessError && !nativeOperation && !sessionId;
  const state = retryAllowed ? 'rejected' : failed ? 'unknown'
    : nativeOperation?.state ?? (sessionId ? 'accepted' : 'unknown');
  const receipt: Operation = { id: key, fingerprint: hash, state,
    result: { requestId: value.requestId, workId: value.workId, cwd: value.cwd, reason: value.reason,
      replayFingerprint,
      nativeOperationId: nativeKey, nativeOperation: nativeOperation ?? null, nativeResult: nativeResult ?? null,
      ...(failed ? { error: { code: nativeError instanceof BusinessError ? nativeError.code : 'NATIVE_CREATE_ERROR',
        message: errorText(nativeError) } } : {}),
      createdId: sessionId, observation: sessionId ? 'pending' : 'not_started', retryAllowed,
      next: 'Claim and read fresh work/state before assistant_decide. Creation is not routing or completion; never retry an uncertain creation under a new ID.' } };
  db.transaction(() => {
    db.put('operations', receipt);
    db.put('operations', { ...receipt, id: requestKey });
  });
  return observeCreated(service, runtime, receipt, requestKey, nativeKey);
}
