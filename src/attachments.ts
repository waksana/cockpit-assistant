import { z } from 'zod';
import type { NativeAttachment as SdkAttachment } from '@waksana/cockpit-module-sdk/backend';

export type NativeAttachment = SdkAttachment;
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 1_000_000;

const displayName = z.string().min(1).max(1000);
const nativePath = z.string().min(1).max(4000)
  .refine(value => value.startsWith('/') && !value.includes('\0'),
    'Use an absolute native filesystem path, not a preview URL');
const position = z.strictObject({
  line: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  character: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const selection = z.strictObject({ start: position, end: position })
  .refine(value => value.end.line > value.start.line
    || value.end.line === value.start.line && value.end.character >= value.start.character,
  'Selection end must not precede its start');
export const attachmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), path: nativePath, displayName: displayName.optional() }),
  z.strictObject({ type: z.literal('directory'), path: nativePath, displayName: displayName.optional() }),
  z.strictObject({ type: z.literal('selection'), filePath: nativePath, displayName,
    selection: selection.optional(), text: z.string().max(100_000).optional() }),
  z.strictObject({ type: z.literal('blob'), displayName: displayName.optional(),
    mimeType: z.string().min(1).max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*(?:;[^\r\n]*)?$/),
    data: z.string().min(1).max(MAX_ATTACHMENT_BYTES)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        'Blob data must be base64, not a data or preview URL') }),
]);
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS)
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ATTACHMENT_BYTES,
    `Attachment descriptions must fit within ${MAX_ATTACHMENT_BYTES} UTF-8 bytes`);
const inputFields = {
  requestId: z.string().min(1).max(200),
  text: z.string().max(100_000),
  attachments: attachmentsSchema.default([]),
  topicId: z.string().min(1).max(200).optional(),
};
export const inputSchema = z.strictObject(inputFields).refine(value => value.text.length > 0 || value.attachments.length > 0,
  'Text or at least one native attachment is required');
export type NativeInput = z.infer<typeof inputSchema>;
/** Read-only compatibility for immutable receipts accepted before natural routing. */
export const receiptInputSchema = z.strictObject({
  ...inputFields, replyTo: z.string().min(1).max(200).optional(),
}).refine(value => value.text.length > 0 || value.attachments.length > 0,
  'Text or at least one native attachment is required');
export type ReceiptInput = z.infer<typeof receiptInputSchema>;

/** Only absent legacy fields normalize; malformed present data must fail visibly. */
export function withAttachments<T extends object>(value: T): T & { attachments: NativeAttachment[] } {
  return { ...value, attachments: attachmentsSchema.parse('attachments' in value ? value.attachments : []) };
}
