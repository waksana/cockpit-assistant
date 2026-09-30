import type { AssistantService } from './service.ts';
import type { Runtime } from './runtime.ts';
import { requireFact } from './errors.ts';

function createdId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  for (const key of ['sessionId', 'createdId']) {
    if (typeof result[key] === 'string' && result[key]) return result[key];
  }
  return null;
}

/** Creation is reserved by topic, not by an input, model request, or observation attempt. */
export async function ensureTopicSession(service: AssistantService,
  runtime: Pick<Runtime, 'create' | 'observe'>, deliveryId: string): Promise<string> {
  const { db } = service;
  const delivery = db.must('deliveries', deliveryId);
  if (delivery.sessionId) return delivery.sessionId;
  requireFact(delivery.topicId, 'TOPIC_REQUIRED', 'Delivery has no topic or session');
  let topic = db.must('topics', delivery.topicId);
  let sessionId = topic.sessionId;
  if (!sessionId) {
    const requestId = `topic:${topic.id}`;
    const key = `create:${requestId}`;
    if (!db.get('operations', key)) {
      // Runtime persists the intent before calling native, including an ID carried by a partial error.
      try { await runtime.create({ requestId, cwd: service.config.defaultCwd }); }
      catch (error) {
        if (!createdId(db.get('operations', key)?.result)) throw error;
      }
    }
    sessionId = createdId(db.must('operations', key).result);
    requireFact(sessionId, 'TOPIC_CREATE_UNKNOWN',
      'Session creation has an uncertain result for this topic; it will not be repeated');
  }
  const resolved = sessionId;
  db.transaction(() => {
    topic = db.must('topics', topic.id);
    const current = db.must('deliveries', deliveryId);
    if (!topic.sessionId) {
      topic.sessionId = resolved;
      topic.version++;
      db.put('topics', topic);
      service.changed();
    }
    // A concurrent explicit mapping wins; the created identity remains in its operation receipt.
    if (!current.sessionId) {
      current.sessionId = topic.sessionId;
      db.put('deliveries', current);
    }
    sessionId = current.sessionId;
  });
  // Mapping and creation identity are durable before observation can fail.
  await runtime.observe(sessionId);
  return sessionId;
}
