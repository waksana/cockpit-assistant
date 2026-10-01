import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentSchema, attachmentsSchema } from '../src/attachments.ts';

test('all supported native descriptors keep their literal payload', () => {
  const attachments = [
    { type: 'file', path: '/synthetic/file', displayName: 'File' },
    { type: 'directory', path: '/synthetic/dir' },
    { type: 'selection', filePath: '/synthetic/source', displayName: 'Source', text: 'Selected text',
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } },
    { type: 'blob', mimeType: 'image/png', data: 'YWJj' },
  ];
  assert.deepEqual(attachmentsSchema.parse(attachments), attachments);
});
test('native attachment validation rejects URLs, invalid ranges, data and excessive size', () => {
  for (const value of [
    { type: 'file', path: 'https://preview.invalid/file' }, { type: 'directory', path: 'relative' },
    { type: 'selection', filePath: '/synthetic/source', displayName: 'Source',
      selection: { start: { line: 4, character: 4 }, end: { line: 2, character: 0 } } },
    { type: 'blob', mimeType: 'image/png', data: 'data:image/png;base64,YWJj' },
    { type: 'blob', mimeType: 'invalid', data: 'YWJj' }, { type: 'unknown', path: '/synthetic/file' },
  ]) assert.equal(attachmentSchema.safeParse(value).success, false);
  assert.equal(attachmentsSchema.safeParse(Array.from({ length: 21 }, () => ({ type: 'file', path: '/synthetic/file' }))).success, false);
});
