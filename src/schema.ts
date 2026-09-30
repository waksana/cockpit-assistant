import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
export { inputSchema } from './attachments.ts';

export const id = z.string().min(1).max(200);
export const text = z.string().trim().min(1).max(100_000);
export const role = z.enum(['coordinator', 'memory']);
export const pageSchema = z.strictObject({
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50),
});
export const topicSchema = z.strictObject({
  topicId: id.optional(),
  title: z.string().trim().min(1).max(240),
  content: z.string().max(16_000),
  archived: z.boolean().optional(),
});
export const mappingSchema = z.strictObject({ topicId: id, sessionId: id.nullable() });
export const dispatchSchema = z.strictObject({
  items: z.array(z.strictObject({
    topicId: id, prompt: z.string().max(100_000).refine(value => value.trim().length > 0, 'A prompt is required'),
  })).min(1).max(100),
});
export const attributionSchema = z.strictObject({
  items: z.array(z.strictObject({ messageId: id, topicId: id })).min(1).max(100),
});
export const clarificationSchema = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export const historySchema = z.strictObject({
  sessionId: id, cursor: z.string().min(1).max(16_384).optional(),
});
export const source = z.strictObject({ messageId: id, version: z.int().positive(), assignmentVersion: z.int().nonnegative() });
// Memory keeps its source-bound extraction protocol; coordinator never receives these fields.
export const claimSchema = z.strictObject({
  role: z.literal('memory'), epoch: z.int().positive(), workId: id.optional(),
});
export const proofSchema = z.strictObject({
  requestId: id, workId: id, epoch: z.int().positive(), token: id,
  inputVersion: z.int().positive(), stateVersion: z.int().nonnegative(),
});
export const rememberSchema = proofSchema.extend({
  entries: z.array(z.strictObject({
    kind: z.enum(['confirmed', 'reported', 'inferred']), text: z.string().min(1).max(16_000),
    sources: z.array(source).min(1).max(200),
  })).max(100),
});
export const roleReadSchema = z.strictObject({
  role: z.literal('memory'), epoch: z.int().positive(),
  resource: z.enum(['work', 'topics', 'messages', 'memories']),
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50),
  workId: id,
});
export const activateRolesSchema = z.strictObject({
  requestId: id,
  bindings: z.array(z.strictObject({ role, sessionId: id, epoch: z.int().positive() })).min(1).max(2),
}).refine(value => new Set(value.bindings.map(binding => binding.role)).size === value.bindings.length,
  'Each role may appear only once');
export const enrollSchema = z.strictObject({
  requestId: id, sessionId: id, label: z.string().min(1).max(240),
  kind: z.enum(['reception', 'collaborator']), evidence: z.string().min(1).max(4000),
});
export const configSchema = z.strictObject({
  defaultCwd: z.string().min(1).max(4000).refine(isAbsolute, 'An absolute working directory is required').default(homedir),
  maxReceptions: z.int().min(1).max(100).default(32),
});
export const bindingSchema = z.strictObject({
  requestId: id, role, sessionId: id, expectedEpoch: z.int().nonnegative(),
  definitionVersion: z.literal('2'), expectedModelId: id,
});
export const createSessionSchema = z.strictObject({
  requestId: id, cwd: z.string().min(1).max(4000).refine(isAbsolute),
  role: role.optional(),
});
export type Proof = z.infer<typeof proofSchema>;
export type Config = z.infer<typeof configSchema>;
