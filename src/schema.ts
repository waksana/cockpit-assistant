import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
export { inputSchema } from './attachments.ts';
export const id = z.string().min(1).max(200);
export const role = z.enum(['coordinator', 'organizer', 'worker']);
const cwd = z.string().min(1).max(4000).refine(isAbsolute);
export const pageSchema = z.strictObject({
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50),
});
const scopeName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const rawToolName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const toolScopeSchema = z.strictObject({
  builtins: z.array(scopeName).max(256).refine(unique, 'Scoped builtins must be unique'),
  mcpServers: z.array(z.strictObject({ name: scopeName,
    tools: z.array(rawToolName).max(256).refine(unique, 'Scoped raw MCP tools must be unique') })).max(64)
    .refine(values => unique(values.map(value => value.name)), 'Scoped servers must be unique'),
});
const roles = z.array(z.strictObject({ moduleId: id, roleId: id })).max(64);
const mcpServers = z.array(z.strictObject({ name: id, tools: z.array(id).max(256).optional() })).max(64);
export const configSchema = z.strictObject({
  defaultCwd: cwd.default(homedir),
  foregroundSessionId: id.nullable().default(null),
  worker: z.strictObject({ cwd: cwd.optional(), roles: roles.optional(),
    skills: z.array(id).max(0, 'Unsupported persistent worker.skills: resources-prepare is current-session only, not a cold-start default').optional(),
    mcpServers: mcpServers.max(0, 'Unsupported persistent worker.mcpServers: resources-prepare is current-session only, not a cold-start default').optional(),
    toolScope: toolScopeSchema.optional() }).default({}),
}).refine(v => !v.worker.roles?.some(r => r.moduleId === 'assistant' && r.roleId !== 'worker'),
  'Default workers cannot carry frontend or organizer roles');
export const topicSchema = z.strictObject({
  topicId: id.optional(), title: z.string().trim().min(1).max(240).optional(),
  content: z.string().max(16_000).optional(), archived: z.boolean().optional(),
  sessionId: id.nullable().optional(),
});
export const dispatchSchema = z.strictObject({
  items: z.array(z.strictObject({ topicId: id,
    prompt: z.string().max(100_000).refine(v => !!v.trim(), 'A faithful prompt is required') })).min(1).max(100),
});
export const presentationSchema = z.strictObject({
  ids: z.array(id).min(1).max(100).refine(unique, 'Presentation IDs must be unique'),
  text: z.string().max(100_000).refine(value => !!value.trim(), 'Full natural presentation text is required'),
});
export const inboxSchema = z.strictObject({ ids: z.array(id).min(1).max(100).optional(),
  presentation: presentationSchema.optional(),
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50) })
  .refine(value => !(value.ids && value.presentation), 'Read first; presentation is a separate declaration');
export const statusSchema = z.strictObject({ topicId: id.optional() });
export const historySchema = z.strictObject({ sessionId: id, cursor: z.string().min(1).max(16_384).optional() });
export const sourceSchema = z.strictObject({ messageId: id });
export const activateRolesSchema = z.strictObject({
  requestId: id, bindings: z.array(z.strictObject({ role: z.literal('coordinator'), sessionId: id })).length(1),
});
export const bindingSchema = z.strictObject({ requestId: id, role: z.enum(['coordinator', 'organizer']), sessionId: id });
export const createSessionSchema = z.strictObject({ requestId: id, cwd, role });
export const organizerInputSchema = z.strictObject({ requestId: id, text: z.string().min(1).max(100_000),
  historySessionIds: z.array(id).max(100).default([]) });
export type Config = z.infer<typeof configSchema>;
