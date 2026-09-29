import { z } from 'zod';
import { isAbsolute } from 'node:path';
export { inputSchema } from './attachments.ts';

export const id = z.string().min(1).max(200);
export const text = z.string().min(1).max(100_000);
export const role = z.enum(['coordinator', 'memory']);
export const source = z.strictObject({ messageId: id, version: z.int().positive(), assignmentVersion: z.int().nonnegative() });
export const claimSchema = z.strictObject({ role, epoch: z.int().positive(), workId: id.optional() });
export const proofSchema = z.strictObject({
  requestId: id, workId: id, epoch: z.int().positive(), token: id,
  inputVersion: z.int().positive(), stateVersion: z.int().nonnegative(),
});
export const createTopicSessionSchema = proofSchema.extend({
  cwd: z.string().min(1).max(4000).refine(isAbsolute, 'An explicit absolute working directory is required'),
  reason: z.string().trim().min(1).max(4000),
});
export const activateRolesSchema = z.strictObject({
  requestId: id,
  bindings: z.array(z.strictObject({ role, sessionId: id, epoch: z.int().positive() })).min(1).max(2),
}).refine(value => new Set(value.bindings.map(binding => binding.role)).size === value.bindings.length,
  'Each role may appear only once');
const topicSchema = z.strictObject({
  id: id.optional(), title: z.string().min(1).max(240).optional(),
  domain: z.string().max(240).nullable().optional(),
  independent: z.boolean().optional(), relatedTo: z.array(id).max(20).optional(),
});
export const decisionSchema = proofSchema.extend({
  topic: topicSchema,
  reason: z.string().min(1).max(4000),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('route'), sessionIds: z.array(id).min(1).max(8),
      routeVersion: z.int().nonnegative(), answerQuestionId: id.optional(),
      context: z.string().max(16_000).optional() }),
    z.strictObject({ kind: z.literal('publish'), text: text.optional() }),
    z.strictObject({ kind: z.literal('clarify'), text }),
    z.strictObject({ kind: z.literal('suppress'), reason: z.string().min(1).max(4000) }),
  ]),
});
export const rememberSchema = proofSchema.extend({
  entries: z.array(z.strictObject({
    kind: z.enum(['confirmed', 'reported', 'inferred']), text: z.string().min(1).max(16_000),
    sources: z.array(source).min(1).max(200),
  })).max(100),
});
export const enrollSchema = z.strictObject({
  requestId: id, sessionId: id, label: z.string().min(1).max(240),
  kind: z.enum(['reception', 'collaborator']), evidence: z.string().min(1).max(4000),
});
export const configSchema = z.strictObject({
  riskEnabled: z.boolean().default(true),
  riskCooldownMs: z.int().min(0).max(86_400_000).default(600_000),
  maxReceptions: z.int().min(1).max(100).default(32),
});
export const bindingSchema = z.strictObject({
  requestId: id, role, sessionId: id, expectedEpoch: z.int().nonnegative(),
  definitionVersion: z.literal('1'), expectedModelId: id,
});
export const createSessionSchema = z.strictObject({
  requestId: id, cwd: z.string().min(1).max(4000),
  role: role.optional(),
});
export const roleReadSchema = z.strictObject({
  role, epoch: z.int().positive(),
  resource: z.enum(['work', 'receipts', 'topics', 'routes', 'receptions', 'messages', 'questions', 'memories', 'deliveries']),
  after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(50),
  workId: id.optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
export type Proof = z.infer<typeof proofSchema>;
export type Config = z.infer<typeof configSchema>;
