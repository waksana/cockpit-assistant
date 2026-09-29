import type { McpInvocationMeta } from '@waksana/cockpit-module-sdk/backend';
import { fingerprint } from './database.ts';
import { BusinessError, errorText, requireFact } from './errors.ts';
import type { Runtime } from './runtime.ts';
import { createTopicSessionSchema } from './schema.ts';
import type { AssistantService } from './service.ts';
import type { Operation } from './types.ts';

type TopicSessionRuntime = Pick<Runtime, 'authorize' | 'create' | 'observe'>;

function createdId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['sessionId', 'createdId'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length) return candidate;
  }
  return createdId(record.result, depth + 1);
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
  const nativeRequestId = `topic-create:${fingerprint([value.workId, value.requestId])}`;
  const nativeKey = `create:${nativeRequestId}`;
  const replay = db.transaction(() => {
    service.authorize(identity, 'coordinator', value.epoch);
    const prior = db.get('operations', requestKey);
    if (prior) {
      requireFact(prior.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Session creation request changed');
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
        nativeOperationId: nativeKey, createdId: null, observation: 'not_started', retryAllowed: false,
        next: 'Read this receipt; creation alone does not route input or complete work.' } };
    db.put('operations', receipt);
    db.put('operations', { ...receipt, id: requestKey });
    return null;
  });
  if (replay) return replay;

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
      nativeOperationId: nativeKey, nativeOperation: nativeOperation ?? null, nativeResult: nativeResult ?? null,
      ...(failed ? { error: { code: nativeError instanceof BusinessError ? nativeError.code : 'NATIVE_CREATE_ERROR',
        message: errorText(nativeError) } } : {}),
      createdId: sessionId, observation: sessionId ? 'pending' : 'not_started', retryAllowed,
      next: 'Claim and read fresh work/state before assistant_decide. Creation is not routing or completion; never retry an uncertain creation under a new ID.' } };
  const save = (): void => db.transaction(() => {
    db.put('operations', receipt);
    db.put('operations', { ...receipt, id: requestKey });
  });
  save();
  if (sessionId) {
    let observation: unknown;
    try {
      await runtime.observe(sessionId);
      observation = { state: 'observed', eligible: db.get('receptions', sessionId)?.enabled === true };
    } catch (error) {
      observation = { state: 'failed', error: errorText(error) };
    }
    receipt.result = { ...(receipt.result as Record<string, unknown>), observation };
    save();
  }
  return receipt;
}
