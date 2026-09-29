import type { NativeAttachment } from '../src/attachments.ts';

export interface ChatReferenceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: NativeAttachment[];
}

export const chatReference: ChatReferenceMessage[] = [
  { id: 'reference-user', role: 'user', timestamp: 1_750_000_001_000,
    content: '请比较这两种方案。\n\n保留第二段文字与 **重点**。',
    attachments: [{ type: 'file', path: '/synthetic/reference/plan.txt', displayName: 'plan.txt' }] },
  { id: 'reference-answer', role: 'assistant', timestamp: 1_750_000_002_000,
    content: [
      '# 完整回答',
      '正文保持自然的阅读宽度，包含 **重点**、*说明*、`inline code` 与 [文档](https://example.invalid/docs)。',
      '> 引用不应该变成通知卡片。',
      '- 第一项\n- 第二项\n  - 嵌套条目',
      '1. 有序步骤\n2. 下一步',
      '| 方案 | 结论 |\n| --- | --- |\n| A | 可行 |\n| B | 待验证 |',
      '```typescript\nconst complete = true;\nconsole.log(complete);\n```',
      '正文结束标记。',
    ].join('\n\n') },
  { id: 'reference-continuation', role: 'assistant', timestamp: 1_750_000_003_000,
    content: '同一助手继续说明，不应重复插入来源、主题或时间大框。' },
  { id: 'reference-attachment', role: 'user', timestamp: 1_750_000_004_000, content: '',
    attachments: [{ type: 'file', path: '/synthetic/reference/notes.txt', displayName: 'notes.txt' }] },
  { id: 'reference-last', role: 'assistant', timestamp: 1_750_000_005_000,
    content: '已经收到附件，最后一条回答完整可见。' },
  { id: 'reference-untrusted', role: 'assistant', timestamp: 1_750_000_006_000,
    content: [
      '<script>window.fixtureUnexpectedScript = true</script>',
      '<img src="https://example.invalid/unsafe-image" onerror="window.fixtureUnexpectedScript = true">',
      '[不安全链接](javascript:window.fixtureUnexpectedScript=true)',
      '![远程图片](https://example.invalid/remote-image)',
      '**保留正常 Markdown**',
    ].join('\n\n') },
];
