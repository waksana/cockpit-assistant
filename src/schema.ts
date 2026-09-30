import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
export { inputSchema } from './attachments.ts';
export const id = z.string().min(1).max(200);
export const role = z.literal('coordinator');
export const pageSchema = z.strictObject({
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50),
});
export const completeSchema = z.strictObject({
  messageId: id,
  topics: z.array(z.strictObject({
    topicId: id, title: z.string().trim().min(1).max(240), content: z.string().max(16_000),
    archived: z.boolean().optional(), sessionId: id.nullable().optional(),
  })).max(100).default([]),
  items: z.array(z.strictObject({
    topicId: id, prompt: z.string().max(100_000).refine(value => !!value.trim(), 'A prompt is required').optional(),
  })).min(1).max(100),
});
export const clarificationSchema = z.strictObject({
  messageId: id, question: z.string().max(4000).refine(value => !!value.trim(), 'A question is required'),
  choices: z.array(z.string().min(1).max(4000)).max(100).default([]),
  allowFreeform: z.boolean().default(true),
}).refine(value => value.allowFreeform || value.choices.length > 0, 'Choices or freeform must be available');
export const clarificationAnswerSchema = z.strictObject({
  requestId: id, answer: z.string().max(100_000).refine(value => !!value.trim(), 'An answer is required'),
});
export const historySchema = z.strictObject({ sessionId: id, cursor: z.string().min(1).max(16_384).optional() });
export const sourceSchema = z.strictObject({ messageId: id });
export const activateRolesSchema = z.strictObject({
  requestId: id, bindings: z.array(z.strictObject({ role, sessionId: id })).length(1),
});
export const bindingSchema = z.strictObject({ requestId: id, role, sessionId: id });
export const createSessionSchema = z.strictObject({
  requestId: id, cwd: z.string().min(1).max(4000).refine(isAbsolute), role: role.optional(),
});
export const configSchema = z.strictObject({
  defaultCwd: z.string().min(1).max(4000).refine(isAbsolute).default(homedir),
});
export type Complete = z.infer<typeof completeSchema>;
export type Config = z.infer<typeof configSchema>;
