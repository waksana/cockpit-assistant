import type { Page, Route } from '@playwright/test';
import type { InputReceipt, Readiness, TimelineItem, TimelinePage } from '../src/ui-types.ts';
import type { Operation, Role } from '../src/types.ts';
import { mergeSnapshots } from '../frontend/timeline.ts';

export const apiPattern = '**/_modules/assistant/*/api/**';
export const longMarkdown = [
  '# 完整 Markdown 回答',
  '这是一条完整的长回答，不应被裁成摘要。',
  '> 引用内容仍然可读。',
  '- 第一项\n- 第二项\n  - 嵌套内容',
  '| 方案 | 状态 |\n| --- | --- |\n| A | 已确认 |\n| B | 待确认 |',
  '```typescript\nconst result = { complete: true, topic: "A" };\n```',
  '[文档](https://example.invalid/docs)',
  ...Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 段：这是用于检查滚动、阅读和完整性的合成段落。`.repeat(4)),
  '**长回答结束标记**',
].join('\n\n');

type TimelinePatch = Omit<Partial<TimelineItem>, 'question'> & {
  question?: (Omit<NonNullable<TimelineItem['question']>, 'requestId'> & { requestId?: string }) | null;
};
export function publication(sequence: number, text: string, patch: TimelinePatch = {}): TimelineItem {
  const id = patch.messageId ?? patch.id ?? `publication-${sequence}`;
  return {
    sequence, snapshotRevision: sequence, type: 'message',
    topicId: 'topic-a', topicTitle: '旅行计划 A', text,
    createdAt: 1_750_000_000_000 + sequence * 1000, speaker: 'assistant',
    sessionId: 'synthetic-reception', attachments: [], clarifications: [], diagnostic: null, deliveryIssues: [], ...patch,
    question: patch.question ? { requestId: `ask-${id}`, ...patch.question } : null,
    id, messageId: id,
  };
}
export const older = [
  publication(1, '更早的完整消息一'),
  publication(2, '更早的完整消息二', { speaker: 'user' }),
  publication(3, '更早的完整消息三'),
];
export const timeline = [
  publication(4, 'A：先讨论旅行计划', { speaker: 'user' }),
  publication(5, 'B：现在讨论代码审查', { topicId: 'topic-b', topicTitle: '代码审查 B', speaker: 'user' }),
  publication(6, 'A：继续刚才的旅行计划'),
  publication(7, '请选择交通方式', { type: 'question', question: { state: 'pending', stateVersion: 1, choices: ['火车', '飞机'], allowFreeform: true } }),
  publication(8, '旧问题已经失效', { type: 'question', question: { state: 'stale', stateVersion: 1, choices: ['旧选项'], allowFreeform: false } }),
  publication(9, longMarkdown),
];
export function readiness(ready = true): Readiness {
  return {
    canSend: ready,
    roles: (['coordinator'] as Role[]).map(role => ({
      role, sessionId: ready ? `synthetic-${role}` : null,
      modelId: ready ? 'synthetic-model' : null, cwd: ready ? '/synthetic/project' : null,
      status: ready ? 'ready' : 'unbound', detail: ready ? null : '尚未绑定',
    })),
    receptions: ready ? [{
      id: 'synthetic-reception', label: '合成接待者', availability: 'loaded',
    }] : [],
  };
}
export type Post = { path: string; body: Record<string, unknown> };
export type RequestRecord = { method: string; path: string; query: string };
export interface FixtureOptions {
  ready?: boolean;
  items?: TimelineItem[];
  hasOlder?: boolean;
  legacyItems?: TimelineItem[];
  post?: (post: Post, route: Route) => Promise<boolean>;
  read?: (url: URL, route: Route) => Promise<boolean>;
  stream?: (after: number, route: Route) => Promise<boolean>;
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});
export { json };

export async function installFixture(page: Page, options: FixtureOptions = {}) {
  const posts: Post[] = [];
  const requests: RequestRecord[] = [];
  const receipts = new Map<string, InputReceipt>();
  const operations = new Map<string, Operation>();
  let currentReadiness = readiness(options.ready ?? true);
  let latest = mergeSnapshots(options.items ?? timeline);
  const seenUnexpected: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => {
    // HTTP failures are deliberately exercised, but JS/render/runtime errors are not.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(message.text());
    }
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const staticPath = ['/', '/host.js', '/host.css', '/_modules', '/favicon.ico'].includes(url.pathname)
      || url.pathname.startsWith('/modules/')
      || url.pathname.startsWith('/_modules/assets/assistant/')
      || url.pathname.startsWith('/_modules/assets/synthetic-probe/');
    if (url.origin !== 'http://127.0.0.1:' + (process.env.ASSISTANT_BROWSER_PORT ?? '4179') || !staticPath) {
      seenUnexpected.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname.startsWith('/modules/') && route.request().isNavigationRequest()) {
      // Only the HTTP SPA fallback is synthetic. The production host parses,
      // renders and navigates the original URL; no fixture router is involved.
      const response = await page.request.get('/');
      await route.fulfill({ response });
      return;
    }
    await route.fallback();
  });
  await page.route(apiPattern, async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/_modules\/assistant\/[^/]+\/api/, '');
    requests.push({ method: route.request().method(), path, query: url.search });
    if (path === '/timeline/stream') {
      if (await options.stream?.(Number(url.searchParams.get('after') ?? 0), route)) return;
      await route.continue();
      return;
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const post = { path, body };
      posts.push(post);
      if (path === '/messages') {
        const requestId = String(body.requestId);
        receipts.set(requestId, {
          requestId,
          input: structuredClone(body) as InputReceipt['input'],
          message: {
            id: `input-${requestId}`, kind: 'user', raw: String(body.text),
            attachments: structuredClone(body.attachments ?? []) as InputReceipt['message']['attachments'],
            sessionId: null, nativeEventId: null, nativeMessageId: null,
            sequence: 100, revision: 100, createdAt: 1_750_000_100_000,
            processed: false, excluded: false, diagnostic: null, question: null,
            clarification: null, clarificationHistory: [],
          }, topicMessages: [], hasMore: { topicMessages: false },
        });
      }
      if (await options.post?.(post, route)) return;
      if (path === '/messages') { await json(route, { messageId: `input-${String(body.requestId)}`, accepted: true }); return; }
      const prefix = path === '/roles/activate' ? 'activate'
        : path === '/sessions' ? 'create' : path === '/roles/bind' ? 'bind' : null;
      if (prefix) {
        const result = path === '/roles/activate' ? { bindings: body.bindings }
          : path === '/sessions'
          ? { sessionId: `synthetic-created-${body.role ?? 'reception'}`, modelId: 'synthetic-model', cwd: body.cwd }
          : { sessionId: body.sessionId, role: body.role };
        const operation: Operation = { id: `${prefix}:${String(body.requestId)}`, kind: prefix,
          fingerprint: 'synthetic', state: 'accepted', result };
        operations.set(operation.id, operation);
        await json(route, operation);
        return;
      }
    } else {
      if (await options.read?.(url, route)) return;
      if (path === '/state') {
        await json(route, { protocolVersion: 4, timelineProtocol: 'foreground-message-snapshots-v1',
          legacyTimelinePath: '/legacy/timeline' });
        return;
      }
      if (path === '/readiness') { await json(route, currentReadiness); return; }
      if (path === '/legacy/timeline') {
        const items = options.legacyItems ?? [];
        await json(route, { items, before: items[0]?.sequence ?? null, hasMore: false,
          watermark: Math.max(0, ...items.map(item => item.snapshotRevision)) });
        return;
      }
      if (path === '/timeline') {
        const before = url.searchParams.get('before');
        const after = url.searchParams.get('after');
        const items = before ? older.filter(item => item.sequence < Number(before))
          : after ? latest.filter(item => item.snapshotRevision! > Number(after))
            .sort((a, b) => a.snapshotRevision! - b.snapshotRevision!) : latest;
        const result: TimelinePage = {
          items, before: items[0]?.sequence ?? null,
          hasMore: before || after ? false : (options.hasOlder ?? true),
          watermark: Math.max(0, ...latest.map(item => item.snapshotRevision!)),
          ...(after ? { cursor: items.at(-1)?.snapshotRevision ?? Number(after) } : {}),
        };
        await json(route, result);
        return;
      }
      if (/^\/sessions\/[^/]+\/inspect$/.test(path)) {
        await json(route, { sessionId: decodeURIComponent(path.split('/')[2]!), modelId: 'synthetic-model',
          cwd: '/synthetic/project', loaded: true, status: 'idle', rolesNeedReload: false });
        return;
      }
      if (path.startsWith('/inputs/')) {
        const receipt = receipts.get(decodeURIComponent(path.slice('/inputs/'.length)));
        await json(route, receipt ?? { error: { code: 'NOT_FOUND', message: 'No synthetic receipt' } }, receipt ? 200 : 404);
        return;
      }
      if (path.startsWith('/operations/')) {
        const receipt = operations.get(decodeURIComponent(path.slice('/operations/'.length)));
        await json(route, receipt ?? { error: { code: 'NOT_FOUND', message: 'No synthetic operation' } }, receipt ? 200 : 404);
        return;
      }
    }
    seenUnexpected.push(`${route.request().method()} ${path}`);
    await json(route, { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: path } }, 501);
  });
  return {
    posts, requests, receipts, consoleErrors, seenUnexpected,
    setReadiness: (value: Readiness) => { currentReadiness = value; },
    setTimeline: (items: TimelineItem[]) => { latest = mergeSnapshots(items); },
  };
}

export function streamBody(items: TimelineItem[]) {
  return items.map(item => `event: publication\nid: ${item.snapshotRevision}\ndata: ${JSON.stringify(item)}\n\n`).join('');
}
