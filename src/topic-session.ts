import type { ModuleHostApi } from '@waksana/cockpit-module-sdk/backend';
import type { AssistantService } from './service.ts';
import { errorText, requireFact } from './errors.ts';

/** An uncertain topic creation is durable and never silently repeated. */
export async function ensureTopicSession(service: AssistantService, host: ModuleHostApi, topicMessageId: string): Promise<string> {
  const { db } = service;
  let row = db.must('topic_messages', topicMessageId);
  if (row.sessionId) return row.sessionId;
  let topic = db.must('topics', row.topicId);
  if (!topic.sessionId) {
    requireFact(topic.mappingState === 'unbound', 'TOPIC_CREATE_UNKNOWN',
      topic.mappingError ?? 'Topic session creation is uncertain; inspect the original native session');
    topic.mappingState = 'calling';
    db.put('topics', topic);
    let result: { sessionId: string };
    try {
      result = await host.call('session/new', { cwd: service.config.defaultCwd });
      requireFact(typeof result.sessionId === 'string' && !!result.sessionId, 'CREATE_UNCONFIRMED', 'Native creation has no confirmed real ID');
    } catch (error) {
      db.transaction(() => {
        topic = db.must('topics', topic.id);
        if (topic.mappingState === 'calling') {
          topic.mappingState = 'unknown'; topic.mappingError = errorText(error);
          const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
          topic.creationReceipt = { error: errorText(error),
            ...(typeof detail.sessionId === 'string' ? { sessionId: detail.sessionId } : {}),
            ...(typeof detail.createdId === 'string' ? { createdId: detail.createdId } : {}) };
          db.put('topics', topic);
        }
      });
      throw error;
    }
    db.transaction(() => {
      topic = db.must('topics', topic.id);
      topic.creationReceipt = result;
      if (!topic.sessionId) {
        topic.sessionId = result.sessionId; topic.mappingState = 'bound'; topic.mappingError = null; topic.version++;
      }
      db.put('topics', topic);
    });
  }
  db.transaction(() => {
    row = db.must('topic_messages', row.id); topic = db.must('topics', topic.id);
    requireFact(topic.sessionId, 'TOPIC_CREATE_UNKNOWN', 'No confirmed topic session mapping');
    if (!row.sessionId) { row.sessionId = topic.sessionId; db.put('topic_messages', row); }
  });
  return db.must('topic_messages', row.id).sessionId!;
}
