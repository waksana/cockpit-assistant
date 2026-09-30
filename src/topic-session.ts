import type { ModuleHostApi, ModuleHostIntentBody, SessionToolScope, ToolScope } from '@waksana/cockpit-module-sdk/backend';
import type { AssistantService } from './service.ts';
import { errorText, requireFact } from './errors.ts';
import type { Role } from './types.ts';

export const coordinatorTools = ['assistant_topics', 'assistant_topic', 'assistant_dispatch', 'assistant_status',
  'assistant_inbox', 'assistant_history', 'assistant_source'];
export const organizerTools = ['assistant_topics', 'assistant_topic', 'assistant_sessions', 'assistant_history'];
export const workerBuiltins = ['view', 'grep', 'glob', 'bash', 'apply_patch', 'ask_user', 'skill'];
export function roleScope(role: Role): ToolScope {
  return role === 'worker' ? { builtins: workerBuiltins, mcpServers: [] }
    : { builtins: [], mcpServers: [{ name: 'assistant', tools: role === 'coordinator' ? coordinatorTools : organizerTools }] };
}
export function scopeMatches(actual: ToolScope | null | undefined, role: 'coordinator' | 'organizer'): boolean {
  const expected = roleScope(role);
  return !!actual && actual.builtins.length === 0 && actual.mcpServers.length === 1
    && actual.mcpServers[0]!.name === 'assistant'
    && actual.mcpServers[0]!.tools.length === expected.mcpServers[0]!.tools.length
    && expected.mcpServers[0]!.tools.every(tool => actual.mcpServers[0]!.tools.includes(tool));
}
export function roleScopeProof(evidence: SessionToolScope, role: 'coordinator' | 'organizer'): boolean {
  if (!evidence.loaded || !scopeMatches(evidence.configured, role) || !scopeMatches(evidence.applied, role)
    || evidence.tools === null) return false;
  const required = roleScope(role).mcpServers[0]!;
  if (evidence.tools.length !== required.tools.length) return false;
  const rawNames = new Set<string>(), aliases = new Map<string, string>();
  for (const tool of evidence.tools) {
    if (tool.mcpServerName !== required.name || !tool.mcpToolName || !required.tools.includes(tool.mcpToolName)
      || rawNames.has(tool.mcpToolName) || !tool.name.trim()
      || tool.namespacedName !== undefined && !tool.namespacedName.trim()) return false;
    rawNames.add(tool.mcpToolName);
    for (const name of new Set([tool.name, ...(tool.namespacedName ? [tool.namespacedName] : [])])) {
      if (aliases.has(name) && aliases.get(name) !== tool.mcpToolName) return false;
      aliases.set(name, tool.mcpToolName);
    }
  }
  return rawNames.size === required.tools.length;
}
export function creationOptions(service: AssistantService, host: ModuleHostApi, role: Role, cwd?: string) {
  requireFact(host.toolScopeVersion === 1,
    'HOST_CAPABILITY', 'Persistent native toolScopeVersion 1 is required for new Assistant sessions');
  const worker = role === 'worker' ? service.config.worker : {};
  requireFact(!worker.skills?.length && !worker.mcpServers?.length,
    'WORKER_CONFIG_UNSUPPORTED', 'Public Host session/new does not persist skills/mcpServers; resources-prepare affects only the current session, not cold-start defaults. Role instructions do not prove all Skills are loaded.');
  const selected = worker.roles ?? [];
  const roles = [...selected.filter(r => !(r.moduleId === 'assistant' && r.roleId === 'worker')),
    { moduleId: 'assistant', roleId: role }];
  const toolScope = worker.toolScope ?? roleScope(role);
  requireFact(role !== 'worker' || toolScope.mcpServers.every(server => server.name !== 'cockpit' && server.name !== 'assistant'),
    'WORKER_SCOPE', 'Default workers cannot have generic peer or foreground Assistant MCP access');
  const options: ModuleHostIntentBody<'session/new'> = {
    cwd: cwd ?? worker.cwd ?? service.config.defaultCwd, roles, toolScope };
  return options;
}
export async function ensureTopicSession(service: AssistantService, host: ModuleHostApi, id: string): Promise<string> {
  let row = service.db.must('topic_messages', id);
  if (row.sessionId) return row.sessionId;
  let topic = service.db.must('topics', row.topicId);
  if (!topic.sessionId) {
    requireFact(topic.mappingState === 'unbound', 'TOPIC_CREATE_UNKNOWN', 'Worker creation is uncertain; inspect the original native session');
    // Validate all template fields before marking any native effect as calling.
    const options = creationOptions(service, host, 'worker');
    topic.mappingState = 'calling'; service.db.put('topics', topic);
    try {
      const result = await host.call('session/new', options);
      requireFact(result.sessionId, 'CREATE_UNCONFIRMED', 'Native creation has no confirmed real ID');
      topic = service.db.must('topics', topic.id);
      topic.creationReceipt = result;
      if (!topic.sessionId) {
        topic.sessionId = result.sessionId; topic.mappingState = 'bound'; topic.mappingError = null; topic.version++;
      }
      service.db.transaction(() => {
        service.db.save('workers', { id: result.sessionId, registeredBy: row.messageId, parentSessionId: null });
        service.db.put('topics', topic);
      });
    } catch (error) {
      topic = service.db.must('topics', topic.id);
      if (topic.mappingState === 'calling') {
        const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        topic.mappingState = 'unknown'; topic.mappingError = errorText(error);
        topic.creationReceipt = { error: errorText(error),
          ...(typeof detail.sessionId === 'string' ? { sessionId: detail.sessionId } : {}),
          ...(typeof detail.createdId === 'string' ? { createdId: detail.createdId } : {}) };
        service.db.put('topics', topic);
      }
      throw error;
    }
  }
  row = service.db.must('topic_messages', id);
  if (!row.sessionId) { row.sessionId = topic.sessionId; service.db.put('topic_messages', row); }
  return row.sessionId!;
}
