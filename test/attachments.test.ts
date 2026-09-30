import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentSchema, attachmentsSchema, inputSchema } from '../src/attachments.ts';
import { fixture, stageDelivery } from './fixtures.ts';

test('all public native attachment variants survive original receipt, split sends, and final raw projection', async () => {
  const f = fixture();
  try {
    const attachments = [
      { type: 'file' as const, path: '/synthetic/file', displayName: 'file' },
      { type: 'directory' as const, path: '/synthetic/directory' },
      { type: 'selection' as const, filePath: '/synthetic/source', displayName: 'selection',
        text: 'Selected source', selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 } } },
      { type: 'blob' as const, mimeType: 'image/png', data: 'YWJj', displayName: 'image' },
    ];
    assert.deepEqual(attachmentsSchema.parse(attachments), attachments);
    const result = stageDelivery(f, 'native-attachments', ['topic'], attachments);
    await f.runtime.wake();
    assert.deepEqual(f.service.receipt(f.db.must('messages', result.message.id)).input.attachments, attachments);
    assert.deepEqual((f.calls.find(call => call.name === 'prompt')!.body as { attachments: unknown }).attachments, attachments);
  } finally { f.close(); }
});
test('attachment boundary rejects preview URLs, relative paths, malformed selections/blob data and excess data', () => {
  for (const value of [
    { type: 'file', path: 'https://preview.invalid/file' },
    { type: 'directory', path: 'relative' },
    { type: 'selection', filePath: '/synthetic/source', displayName: 'source',
      selection: { start: { line: 4, character: 4 }, end: { line: 2, character: 0 } } },
    { type: 'blob', mimeType: 'image/png', data: 'data:image/png;base64,YWJj' },
    { type: 'blob', mimeType: 'invalid', data: 'YWJj' },
    { type: 'unknown', path: '/synthetic/file' },
  ]) assert.equal(attachmentSchema.safeParse(value).success, false);
  assert.equal(attachmentsSchema.safeParse(Array.from({ length: 21 }, () => ({ type: 'file', path: '/synthetic/file' }))).success, false);
  assert.equal(inputSchema.safeParse({ requestId: 'empty', text: '' }).success, false);
  assert.equal(inputSchema.safeParse({ requestId: 'attachment-only', text: '', attachments: [{ type: 'file', path: '/synthetic/file' }] }).success, true);
});
test('coordinator receives actual native attachments without treating blob bytes as prose evidence', async () => {
  const f = fixture();
  try {
    const attachments = [{ type: 'blob' as const, mimeType: 'image/png', data: 'c3ludGhldGljLWltYWdl' }];
    const original = f.service.accept({ requestId: 'image-source', text: 'Classify this image', attachments }).message;
    await f.runtime.wake();
    const prompt = f.calls.find(call => call.name === 'prompt')!.body as { attachments: unknown; text: string };
    assert.deepEqual(prompt.attachments, attachments);
    assert.equal(prompt.text.includes(attachments[0]!.data), false);
    assert.ok(prompt.text.includes(original.id));
    assert.deepEqual(f.db.must('messages', original.id).attachments, attachments);
  } finally { f.close(); }
});
