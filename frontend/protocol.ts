import { z } from 'zod';

export const conversationProtocolSchema = z.object({
  protocolVersion: z.literal(4),
  timelineProtocol: z.literal('foreground-message-snapshots-v1'),
  legacyTimelinePath: z.literal('/legacy/timeline'),
});
export const legacyClarificationSchema = z.object({
  id: z.string().min(1), question: z.string(), choices: z.array(z.string()), allowFreeform: z.boolean(),
  createdAt: z.number().finite(), answer: z.string().nullable(),
  answeredAt: z.number().finite().nullable(), requestId: z.string().nullable(),
});
