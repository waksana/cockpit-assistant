import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { TimelineItem } from '../src/ui-types.ts';
import { chatReference } from './chat-reference.ts';
import { installFixture, json, longMarkdown, publication, streamBody } from './fixtures.ts';

const system = (sequence: number, text: string, type: TimelineItem['type'] = 'status') =>
  publication(sequence, text, { type, speaker: 'system', messageId: null });
const source = (messageId: string, version = 1) => ({ messageId, version, assignmentVersion: 0 });

async function ready(page: Page) {
  await expect(page.locator('.ca-page')).toBeVisible();
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toBeInViewport();
}

function clean(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.posts).toEqual([]);
}

async function measureRows(rows: Locator) {
  for (const row of await rows.all()) await row.scrollIntoViewIfNeeded();
  return rows.evaluateAll(elements => {
    const properties = [
      'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
      'border', 'border-radius', 'padding', 'margin', 'max-width', 'text-align',
      'white-space', 'overflow-wrap', 'display', 'gap', 'align-items',
    ];
    let previousBottom: number | undefined;
    return elements.map(element => {
      const row = element.querySelector<HTMLElement>('.user-message, .message.is-doc');
      if (!row) throw new Error('Expected the native complete user/assistant message surface');
      const box = row.getBoundingClientRect();
      const inspect = (node: Element) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          css: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])),
          width: rect.width, height: rect.height, x: rect.left, yWithinRow: rect.top - box.top,
        };
      };
      const gap = previousBottom === undefined ? null : box.top - previousBottom;
      previousBottom = box.bottom;
      return {
        row: inspect(row), gap,
        bubble: Array.from(row.querySelectorAll('.message.is-out')).map(inspect),
        body: Array.from(row.querySelectorAll('.message-body')).map(inspect),
        markdown: Array.from(row.querySelectorAll('.message-body h1, .message-body p, .message-body blockquote, '
          + '.message-body ul, .message-body ol, .message-body li, .message-body table, .message-body pre, '
          + '.message-body code, .message-body a')).map(inspect),
        attachments: Array.from(row.querySelectorAll('.message-attachments, .message-attachment')).map(inspect),
        timestamps: Array.from(row.querySelectorAll('time')).map(node => ({
          ...inspect(node), text: node.textContent, datetime: node.getAttribute('datetime'),
        })),
      };
    });
  });
}

test('complete public messages match real native Chat rows, Markdown, spacing, time and attachments', async ({ page }) => {
  const items = chatReference.map((message, index) => publication(index + 1, message.content, {
    id: message.id, messageId: message.id, speaker: message.role, createdAt: message.timestamp,
    attachments: message.attachments ?? [],
  }));
  const fixture = await installFixture(page, { items, hasOlder: false });
  await page.goto('/?transcript=1');
  await page.getByRole('button', { name: '选择合成会话', exact: true }).click();
  const nativeRows = page.locator('[data-testid="selected-session"] [data-message-frame]');
  await expect(nativeRows).toHaveCount(items.length);
  await expect(nativeRows.nth(1).locator('table')).toContainText('待验证');
  const native = await measureRows(nativeRows);
  expect(native[0]!.bubble).toHaveLength(1);
  expect(native[0]!.timestamps).toHaveLength(1);
  expect(native[1]!.markdown.length).toBeGreaterThan(10);
  expect(native[1]!.timestamps).toHaveLength(1);
  expect(native[2]!.timestamps).toHaveLength(0);
  expect(native[3]!.attachments.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await ready(page);
  await expect(page.getByTestId('selected-session')).toHaveCount(0);
  const assistantRows = page.locator('[data-ca-item]');
  await expect(assistantRows).toHaveCount(items.length);
  expect(await measureRows(assistantRows)).toEqual(native);
  await expect(assistantRows.nth(1)).toContainText('正文结束标记。');
  await expect(assistantRows.nth(4)).toContainText('已经收到附件，最后一条回答完整可见。');
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toBeInViewport();
  await expect(page.locator('.ca-topic-heading, .ca-message-sources')).toHaveCount(0);
  clean(fixture);
});

test('unsafe links, raw HTML and media follow the native Markdown renderer without execution or fetching', async ({ page }) => {
  const sample = chatReference.find(message => message.id === 'reference-untrusted')!;
  const fixture = await installFixture(page, {
    items: [publication(1, sample.content, { id: sample.id, createdAt: sample.timestamp })], hasOlder: false,
  });
  const inspect = (row: Locator) => row.locator('.message-body').evaluate(body => ({
    text: body.textContent,
    links: Array.from(body.querySelectorAll('a')).map(link => ({
      text: link.textContent, href: link.getAttribute('href'), target: link.target, rel: link.rel,
    })),
    forbiddenElements: body.querySelectorAll('script, img, iframe, object, embed').length,
    executed: Object.hasOwn(window, 'fixtureUnexpectedScript'),
  }));
  await page.goto('/?transcript=1');
  await page.getByRole('button', { name: '选择合成会话', exact: true }).click();
  const nativeRow = page.locator(`[data-message-frame="${sample.id}"]`);
  await expect(nativeRow).toContainText('保留正常 Markdown');
  const native = await inspect(nativeRow);
  expect(native.forbiddenElements).toBe(0);
  expect(native.executed).toBe(false);
  expect(native.links).toHaveLength(1);
  expect(native.links[0]!.href ?? '').not.toMatch(/^\s*javascript:/i);
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await ready(page);
  const assistantRow = page.locator(`[data-ca-item="${sample.id}"]`);
  await expect(assistantRow).toContainText('保留正常 Markdown');
  expect(await inspect(assistantRow)).toEqual(native);
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toBeInViewport();
  clean(fixture);
});

test('interleaved status, wake, risk and correction retain only natural conversation in original order', async ({ page }) => {
  const target = 'natural-answer';
  const provenance = '12345678-1234-4234-8234-123456789abc';
  const items = [
    publication(1, '用户的自然问题', { speaker: 'user' }),
    system(2, '内部状态消息不得显示'),
    publication(3, '需要修正的旧正文', { messageId: target, sources: [source(target)], sessionId: provenance }),
    system(4, '唤醒通知不得显示'),
    system(5, '风险报告不得显示', 'risk'),
    publication(6, '第二个自然问题', { speaker: 'user', topicId: 'another-topic', topicTitle: '内部主题标题' }),
    publication(7, '内部修正通知不得显示', {
      type: 'correction', speaker: 'system', messageId: target, sources: [source(target, 2)],
      revision: { version: 2, text: '修正后的完整自然回答', attachments: [] },
    }),
    publication(8, '最后的自然回答'),
  ];
  const fixture = await installFixture(page, { items, hasOlder: false });
  await page.goto('/modules/assistant/main');
  await ready(page);
  const rows = page.locator('[data-ca-item]');
  await expect(rows).toHaveCount(4);
  expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-ca-item'))))
    .toEqual(['publication-1', 'publication-3', 'publication-6', 'publication-8']);
  await expect(rows.nth(1)).toContainText('修正后的完整自然回答');
  const conversation = page.getByRole('region', { name: '对话记录', exact: true });
  await expect(conversation).not.toContainText(/内部|唤醒通知|风险报告|需要修正的旧正文|synthetic-reception|topic-a/);
  await expect(conversation).not.toContainText(provenance);
  await expect(conversation.locator('.ca-topic-heading, .message.is-system')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
  clean(fixture);
});

test('a system-only history is an empty conversation, not notification bubbles or an empty-state card', async ({ page }) => {
  const items = [system(1, '内部状态'), system(2, '内部唤醒'), system(3, '内部风险', 'risk'),
    system(4, '内部修正', 'correction'), system(5, '内部 carrier 原文', 'message')];
  const fixture = await installFixture(page, { items, hasOlder: false });
  await page.goto('/modules/assistant/main');
  await ready(page);
  await expect(page.locator('[data-ca-item]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).toHaveText('');
  await expect(page.getByRole('heading', { name: '对话记录', exact: true })).toHaveCount(0);
  await expect(page.getByText(/暂无消息|暂无对话|开始对话/)).toHaveCount(0);
  await expect.poll(() => fixture.requests.some(request =>
    request.path === '/timeline/stream' && request.query.includes('after=5'))).toBe(true);
  await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('系统历史不妨碍编辑');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  clean(fixture);
});

test('revision projection preserves same-version summaries and clarification while applying only newer target snapshots', async ({ page }) => {
  const summaryId = 'summary-message';
  const correctedId = 'status-corrected-message';
  const items = [
    publication(1, 'coordinator 已发布的同版本自然摘要', {
      messageId: summaryId, sources: [source(summaryId)],
      revision: { version: 1, text: '同版本原始正文不得覆盖摘要', attachments: [] },
    }),
    publication(2, '待修正的第二条正文', { messageId: correctedId, sources: [source(correctedId)] }),
    publication(3, '请补充这条输入的背景', { type: 'clarification', messageId: correctedId }),
    publication(4, '内部状态更新通知', {
      type: 'status', speaker: 'system', messageId: correctedId,
      revision: { version: 2, text: '只更新第二条的完整正文',
        attachments: [{ type: 'file', path: '/synthetic/revised.txt', displayName: 'revised.txt' }] },
    }),
    publication(5, '过时的内部修正通知', {
      type: 'correction', speaker: 'system', messageId: correctedId,
      revision: { version: 1, text: '旧版本不得回退正文', attachments: [] },
    }),
  ];
  const fixture = await installFixture(page, { items, hasOlder: false });
  await page.goto('/modules/assistant/main');
  await ready(page);
  const rows = page.locator('[data-ca-item]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('coordinator 已发布的同版本自然摘要');
  await expect(rows.nth(1)).toContainText('只更新第二条的完整正文');
  await expect(rows.nth(1)).toContainText('revised.txt');
  await expect(rows.nth(2)).toContainText('请补充这条输入的背景');
  await expect(page.getByRole('region', { name: '对话记录', exact: true }))
    .not.toContainText(/内部|同版本原始正文|旧版本不得回退|待修正的第二条/);
  await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
  clean(fixture);
});

test('multiple system-only history pages are traversed until older real conversation becomes readable', async ({ page }) => {
  const visited: number[] = [];
  const fixture = await installFixture(page, {
    items: [system(90, '最新内部状态'), system(91, '最新内部风险', 'risk')], hasOlder: true,
    read: async (url, route) => {
      if (!url.pathname.endsWith('/timeline') || !url.searchParams.has('before')) return false;
      const before = Number(url.searchParams.get('before'));
      visited.push(before);
      const items = before === 90 ? [system(60, '第二页内部状态'), system(61, '第二页内部风险', 'risk')]
        : before === 60 ? [system(30, '第三页内部唤醒'), system(31, '第三页内部修正', 'correction')]
          : before === 30 ? [publication(1, '较早的真实用户问题', { speaker: 'user' }),
            publication(2, '较早的完整助手回答')] : [];
      await json(route, { items, before: items[0]?.sequence ?? null, hasMore: before !== 30, watermark: 91 });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  await ready(page);
  await expect(page.locator('[data-ca-item]')).toHaveCount(2);
  expect(visited).toEqual([90, 60, 30]);
  await expect(page.getByText('较早的真实用户问题', { exact: true })).toBeVisible();
  await expect(page.getByText('较早的完整助手回答', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).not.toContainText('内部');
  await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0);
  await expect.poll(() => fixture.requests.some(request =>
    request.path === '/timeline/stream' && request.query.includes('after=91'))).toBe(true);
  clean(fixture);
});

test('a later history read with newer question state overrides a higher-sequence cached status snapshot', async ({ page }) => {
  const messageId = 'versioned-question';
  const cachedStatus = publication(3, '过期的内部问题状态', {
    type: 'status', speaker: 'system', messageId,
    question: { state: 'unknown', stateVersion: 2, choices: ['使用新状态的选项'], allowFreeform: false },
  });
  const originalQuestion = publication(1, '应该仍可选择的原始问题', {
    type: 'question', messageId, sources: [source(messageId)],
    revision: { version: 1, text: '应该仍可选择的原始问题', attachments: [] },
    question: { state: 'pending', stateVersion: 3, choices: ['使用新状态的选项'], allowFreeform: false },
  });
  const fixture = await installFixture(page, { items: [cachedStatus], hasOlder: true,
    read: async (url, route) => {
      if (!url.pathname.endsWith('/timeline') || url.searchParams.get('before') !== '3') return false;
      await json(route, { items: [originalQuestion], before: 1, hasMore: false, watermark: 3 });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  await ready(page);
  await expect(page.locator('[data-ca-item]')).toHaveCount(1);
  await expect(page.getByText('应该仍可选择的原始问题', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).not.toContainText('内部');
  await page.getByRole('button', { name: '使用新状态的选项', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('使用新状态的选项');
  clean(fixture);
});

test('hidden SSE advances the raw cursor and corrects text without unread; only new dialogue increments unread', async ({ page }) => {
  let releaseHidden!: () => void;
  let releaseDialogue!: () => void;
  const hiddenGate = new Promise<void>(resolve => { releaseHidden = resolve; });
  const dialogueGate = new Promise<void>(resolve => { releaseDialogue = resolve; });
  const target = 'corrected-message';
  const initial = [
    publication(1, '开头的真实提问', { speaker: 'user' }),
    publication(2, '修正前的自然正文', { messageId: target, sources: [source(target)] }),
    publication(3, longMarkdown),
    publication(4, '当前最后一条自然回答'),
  ];
  const status = system(5, '内部唤醒状态');
  const risk = system(6, '内部风险报告', 'risk');
  const corrected = publication(7, '内部修正通知', {
    type: 'correction', speaker: 'system', messageId: target, sources: [source(target, 2)],
    revision: { version: 2, text: '修正后的自然正文', attachments: [] },
  });
  const next = publication(8, '新增的唯一自然回答');
  let connections = 0;
  const fixture = await installFixture(page, { items: initial, hasOlder: false,
    stream: async (_after, route) => {
      const connection = ++connections;
      if (connection > 2) return false;
      if (connection === 1) {
        await hiddenGate;
        fixture.setTimeline([...initial, status, risk, corrected]);
        await route.fulfill({ contentType: 'text/event-stream', body: streamBody([status, status, corrected]) });
      } else {
        await dialogueGate;
        fixture.setTimeline([...initial, status, risk, corrected, next]);
        await route.fulfill({ contentType: 'text/event-stream', body: streamBody([corrected, next, next]) });
      }
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  await ready(page);
  const scroller = page.locator('.ca-scroller');
  await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  releaseHidden();
  await expect(page.locator('[data-ca-item="publication-2"]')).toContainText('修正后的自然正文');
  await expect.poll(() => fixture.requests.some(request =>
    request.path === '/timeline' && request.query.includes('after=5'))).toBe(true);
  await expect.poll(() => fixture.requests.some(request =>
    request.path === '/timeline/stream' && request.query.includes('after=7'))).toBe(true);
  await expect(page.locator('[data-ca-item]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
  expect(await scroller.evaluate(element => element.scrollTop)).toBeLessThan(100);
  releaseDialogue();
  await expect(page.locator('[data-ca-item]')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '1 条新消息，查看最新', exact: true })).toBeVisible();
  await expect.poll(() => fixture.requests.some(request =>
    request.path === '/timeline/stream' && request.query.includes('after=8'))).toBe(true);
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).not.toContainText(/内部|修正前/);
  await page.getByRole('button', { name: '1 条新消息，查看最新', exact: true }).click();
  await expect(page.getByText('新增的唯一自然回答', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
  clean(fixture);
});

test('late real messageList middleware registration and revocation preserve reading anchors and resize following', async ({ page }) => {
  const target = 'late-resizing-answer';
  const initial = [
    publication(1, '保留这段对话的阅读位置', { speaker: 'user' }),
    publication(2, longMarkdown),
    publication(3, '最后一条短回答', { messageId: target, sources: [source(target)] }),
  ];
  const updates = [2, 3].map((version, index) => publication(4 + index, '内部正文修正通知', {
    type: 'correction', speaker: 'system', messageId: target,
    revision: { version, text: `${longMarkdown}\n\n${'内容调整后继续保持贴底。\n\n'.repeat(30 * version)}增长结束 ${version}`, attachments: [] },
  }));
  const releases: (() => void)[] = [];
  const gates = updates.map(() => new Promise<void>(release => { releases.push(release); }));
  let connections = 0;
  const fixture = await installFixture(page, { items: initial, hasOlder: false,
    stream: async (_after, route) => {
      const index = connections++;
      if (index >= gates.length) return false;
      await gates[index];
      fixture.setTimeline([...initial, ...updates.slice(0, index + 1)]);
      await route.fulfill({ contentType: 'text/event-stream', body: streamBody([updates[index]!]) });
      return true;
    },
  });
  const digest = 'd'.repeat(64);
  const entry = `/_modules/assets/synthetic-message-list/${digest}/index.js`;
  await page.route('**/_modules', async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { modules: unknown[] };
    manifest.modules.push({
      id: 'synthetic-message-list', name: 'Late message-list middleware', version: '0.1.0',
      digest, config: {}, styles: [], entry, apiBase: `/_modules/synthetic-message-list/${digest}/api`,
    });
    await route.fulfill({ json: manifest });
  });
  await page.route(`**${entry}`, route => route.fulfill({
    path: resolve('node_modules/.cache/assistant-browser/message-list-probe.js'), contentType: 'text/javascript',
  }));
  await page.goto('/modules/assistant/main');
  await ready(page);
  await expect.poll(() => page.evaluate(() => !!window.messageListProbe)).toBe(true);
  const scroller = page.locator('.ca-scroller');
  const editor = page.getByRole('textbox', { name: '消息输入', exact: true });
  await editor.fill('节点替换不得重启页面或丢草稿');
  const editorNode = await editor.elementHandle();
  const readAnchor = () => scroller.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const first = Array.from(element.querySelectorAll<HTMLElement>('[data-ca-item]'))
      .find(item => item.getBoundingClientRect().bottom > top)!;
    return { id: first.dataset.caItem, offset: first.getBoundingClientRect().top - top };
  });
  for (const [index, operation] of ['activate', 'revoke'].entries()) {
    await scroller.evaluate(element => { element.scrollTop = 400; element.dispatchEvent(new Event('scroll')); });
    const before = await readAnchor();
    const oldViewport = await scroller.elementHandle();
    if (operation === 'activate') {
      await page.evaluate(() => window.messageListProbe.activate());
      await expect(page.getByTestId('late-message-list')).toBeVisible();
    } else {
      await page.evaluate(() => window.revokeMessageListProbe());
      await expect(page.getByTestId('late-message-list')).toHaveCount(0);
      expect(await page.evaluate(() => window.messageListProbe.disposed)).toBe(true);
    }
    await expect.poll(() => oldViewport!.evaluate(element => element.isConnected)).toBe(false);
    await expect.poll(async () => (await readAnchor()).id).toBe(before.id);
    await expect.poll(async () => Math.abs((await readAnchor()).offset - before.offset)).toBeLessThan(1);
    expect(await editorNode!.evaluate(element => element.isConnected)).toBe(true);
    await expect(editor).toHaveValue('节点替换不得重启页面或丢草稿');
    await scroller.focus();
    await page.keyboard.press('Control+End');
    await expect.poll(() => scroller.evaluate(element =>
      element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    releases[index]!();
    await expect(page.locator('[data-ca-item="publication-3"]')).toContainText(`增长结束 ${index + 2}`);
    await expect.poll(() => scroller.evaluate(element =>
      element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await expect(page.getByText(`增长结束 ${index + 2}`, { exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
    await expect(page.locator('[data-ca-item]')).toHaveCount(3);
    await oldViewport!.dispose();
  }
  expect(fixture.requests.filter(request => request.path === '/timeline' && request.query === '?limit=50')).toHaveLength(1);
  await editorNode!.dispose();
  clean(fixture);
});
