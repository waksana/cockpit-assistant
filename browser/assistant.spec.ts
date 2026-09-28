import { expect, test, type Page } from '@playwright/test';
import { installFixture, json, publication, readiness, streamBody, timeline } from './fixtures.ts';

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await expect(page.getByRole('menu', { name: '全局菜单', exact: true })).toHaveClass('btn-menu');
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '助手', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).toHaveAttribute('aria-busy', 'false');
}
function assertClean(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('real host global menu opens on an empty homepage; complete Markdown, A/B/A and public theme', async ({ page }, info) => {
  const fixture = await installFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-homepage')).toHaveText('没有选择会话');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openAssistant(page);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const messages = page.locator('[data-ca-item]');
  await expect(messages).toHaveCount(timeline.length);
  expect(await messages.evaluateAll(elements => elements.map(element => element.getAttribute('data-ca-item'))))
    .toEqual(timeline.map(item => item.id));
  const headings = page.locator('.ca-topic-heading');
  await expect(headings).toHaveText(['旅行计划 A', '代码审查 B', '旅行计划 A']);
  const colors = await messages.evaluateAll(elements => elements.slice(0, 3).map(element =>
    (element as HTMLElement).style.getPropertyValue('--ca-topic-color')));
  expect(colors[0]).toBe(colors[2]);
  expect(colors[0]).not.toBe(colors[1]);
  const long = page.locator('[data-ca-item="publication-9"]');
  await expect(long.getByRole('heading', { name: '完整 Markdown 回答' })).toBeVisible();
  await expect(long.getByRole('table')).toContainText('已确认');
  await expect(long.locator('pre')).toContainText('const result');
  await expect(long.getByText('长回答结束标记', { exact: true })).toBeVisible();
  await expect(messages.first()).toContainText('来源：synthetic-reception');
  await expect(messages.first().locator('time')).toHaveAttribute('datetime', /2025-/);
  const measurements = await page.getByRole('dialog').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: window.innerWidth, height: window.innerHeight,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      token: style.getPropertyValue('--ck-color-surface').trim(),
      background: style.backgroundColor,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
    };
  });
  expect(measurements.left).toBeGreaterThanOrEqual(0);
  expect(measurements.right).toBeLessThanOrEqual(measurements.width + 1);
  expect(measurements.top).toBeGreaterThanOrEqual(0);
  expect(measurements.bottom).toBeLessThanOrEqual(measurements.height + 1);
  expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.clientWidth + 1);
  expect(measurements.token).not.toBe('');
  expect(measurements.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(measurements.dark).toBe(info.project.name.endsWith('dark'));
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('synthetic-assistant.png') });
  await page.getByRole('button', { name: '展开设置', exact: true }).click();
  const coordinator = page.getByRole('region', { name: '编排者设置', exact: true });
  // These read-only assertions cannot scroll a previously hidden form into view.
  await expect(coordinator.getByRole('heading', { name: '编排者', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(coordinator.getByRole('textbox', { name: '新会话工作目录', exact: true })).toBeInViewport();
  await expect(page.locator('.ca-scroller')).toHaveJSProperty('scrollTop', 0);
  expect(fixture.posts).toEqual([]);
  assertClean(fixture);
});

test('not-ready users can edit and preserve drafts but cannot send, then refresh actual readiness', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  const send = page.getByRole('button', { name: '发送', exact: true });
  await draft.fill('尚未就绪也保留我的草稿');
  await expect(draft).toBeEditable();
  await expect(send).toBeDisabled();
  await draft.press('Enter');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openAssistant(page);
  await expect(draft).toHaveValue('尚未就绪也保留我的草稿');
  fixture.setReadiness(readiness());
  await page.getByRole('button', { name: '刷新就绪状态' }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(draft).toHaveValue('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]?.body.text).toBe('尚未就绪也保留我的草稿');
  expect(fixture.posts[0]?.body.requestId).toMatch(uuid);
  assertClean(fixture);
});

test('settings opened before delayed history retain the viewport when the initial page arrives', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, {
    read: async (url, route) => {
      if (!url.pathname.endsWith('/timeline') || url.search !== '?limit=50') return false;
      await gate;
      await json(route, { items: timeline, before: timeline[0]!.sequence, hasMore: true,
        watermark: timeline.at(-1)!.sequence });
      return true;
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  const history = page.getByRole('region', { name: '对话记录', exact: true });
  await expect(history).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '展开设置', exact: true }).click();
  const heading = page.getByRole('region', { name: '编排者设置', exact: true })
    .getByRole('heading', { name: '编排者', exact: true });
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.ca-scroller')).toHaveJSProperty('scrollTop', 0);
  release?.();
  await expect(history).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-ca-item]')).toHaveCount(timeline.length);
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.ca-scroller')).toHaveJSProperty('scrollTop', 0);
  expect(fixture.requests.filter(request => request.path === '/timeline' && request.query === '?limit=50')).toHaveLength(1);
  assertClean(fixture);
});

test('reply anchors distinguish pending choices from stale questions without hidden posting', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto('/');
  await openAssistant(page);
  await page.locator('[data-ca-item="publication-7"]').getByRole('button', { name: '回复', exact: true }).click();
  const reference = page.getByRole('region', { name: '当前回复引用', exact: true });
  await expect(page.getByText('来源：synthetic-reception · 引用：anchor-7')).toBeVisible();
  await page.getByRole('button', { name: '火车', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('火车');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
  expect(fixture.posts[0]?.body).toMatchObject({ text: '火车', replyTo: 'anchor-7' });
  await page.locator('[data-ca-item="publication-8"]').getByRole('button', { name: '回复', exact: true }).click();
  await expect(page.getByText('来源：synthetic-reception · 引用：anchor-8')).toBeVisible();
  await expect(reference.locator('.ca-choices')).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('关于旧问题的普通评论');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openAssistant(page);
  await expect(page.getByText('来源：synthetic-reception · 引用：anchor-8')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('关于旧问题的普通评论');
  assertClean(fixture);
});

test('a retained pending reply outside the reopened timeline keeps its choices without duplicates', async ({ page }) => {
  const question = publication(1, '需要保留选项的早期问题', {
    type: 'question', anchorId: 'retained-question-anchor',
    question: { state: 'pending', choices: ['火车', '飞机'], allowFreeform: false },
  });
  const later = publication(2, '最新窗口内的另一个问题', {
    type: 'question', question: { state: 'pending', choices: ['另一个选项'], allowFreeform: false },
  });
  const fixture = await installFixture(page, { items: [question], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  await page.locator('[data-ca-item="publication-1"]').getByRole('button', { name: '回复', exact: true }).click();
  const reference = page.getByRole('region', { name: '当前回复引用', exact: true });
  await expect(reference.locator('.ca-choices')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  fixture.setTimeline([later]);
  await openAssistant(page);
  await expect(page.locator('[data-ca-item="publication-1"]')).toHaveCount(0);
  await expect(reference).toContainText('retained-question-anchor');
  await expect(reference.getByRole('button', { name: '火车', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(1);
  await expect(page.locator('[data-ca-item="publication-2"]').getByRole('button', { name: '另一个选项', exact: true })).toBeEnabled();
  await reference.getByRole('button', { name: '火车', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('火车');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: '火车', replyTo: 'retained-question-anchor' });
  assertClean(fixture);
});

test('six long question choices stay in the scroller and preserve the selected reply anchor', async ({ page }) => {
  const choices = Array.from({ length: 6 }, (_, index) => `选项${index + 1}：${'合成长选项'.repeat(24).slice(0, 116)}`);
  const selected = choices[3]!;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const question = publication(1, '请从六个完整的长选项中选择', {
    type: 'question', question: { state: 'pending', choices, allowFreeform: false },
    anchorId: 'immutable-question-anchor',
  });
  const later = publication(2, '另一个独立的待回答问题', {
    type: 'question', question: { state: 'pending', choices: ['新的选择'], allowFreeform: false },
    anchorId: 'different-question-anchor',
  });
  const fixture = await installFixture(page, { items: [question, later], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/messages') return false;
      await gate;
      await json(route, { accepted: true });
      return true;
    },
  });
  await page.goto('/');
  await openAssistant(page);
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  const send = page.getByRole('button', { name: '发送', exact: true });
  const scroller = page.locator('.ca-scroller');
  const assertComposerVisible = async () => {
    await expect(draft).toBeInViewport();
    await expect(send).toBeInViewport();
    expect(await scroller.evaluate(element => element.clientHeight)).toBeGreaterThan(100);
  };
  await assertComposerVisible();
  await page.locator('[data-ca-item="publication-1"]').getByRole('button', { name: selected, exact: true }).click();
  await expect(draft).toHaveValue(selected);
  await assertComposerVisible();
  await expect(scroller.getByRole('region', { name: '当前回复引用', exact: true })).toContainText('immutable-question-anchor');
  await expect(page.locator('.ca-composer').getByText('已选择回复引用', { exact: true })).toBeVisible();
  await expect(page.locator('.ca-composer').getByRole('button', { name: selected, exact: true })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  await send.click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: selected, replyTo: 'immutable-question-anchor' });
  await page.locator('[data-ca-item="publication-2"]').getByRole('button', { name: '新的选择', exact: true }).click();
  await expect(draft).toHaveValue('新的选择');
  await assertComposerVisible();
  release?.();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('已接受');
  await expect(draft).toHaveValue('新的选择');
  expect(fixture.posts[0]?.body.replyTo).toBe('immutable-question-anchor');
  expect(fixture.posts).toHaveLength(1);
  assertClean(fixture);
});

test('explicit create, inspect, bind and enrollment stay synthetic and use current model/epoch', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  await page.getByRole('button', { name: '展开设置' }).click();
  const coordinator = page.getByRole('region', { name: '编排者设置', exact: true });
  await coordinator.getByRole('textbox', { name: '新会话工作目录' }).fill('/synthetic/project');
  await coordinator.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('article', { name: '创建编排者', exact: true })).toContainText('synthetic-created-coordinator');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]).toMatchObject({ path: '/sessions', body: { cwd: '/synthetic/project', role: 'coordinator' } });
  await coordinator.getByRole('textbox', { name: '已有会话编号' }).fill('synthetic-created-coordinator');
  await coordinator.getByRole('button', { name: '检查会话', exact: true }).click();
  await expect(coordinator).toContainText('实际模型（只读）');
  await expect(coordinator).toContainText('synthetic-model');
  await coordinator.getByRole('button', { name: '明确绑定为编排者' }).click();
  await expect.poll(() => fixture.posts.length).toBe(2);
  expect(fixture.posts[1]).toMatchObject({ path: '/roles/bind', body: {
    role: 'coordinator', sessionId: 'synthetic-created-coordinator',
    expectedModelId: 'synthetic-model', expectedEpoch: 0, definitionVersion: '1',
  } });
  const memory = page.getByRole('region', { name: '记忆者设置', exact: true });
  await memory.getByRole('textbox', { name: '新会话工作目录' }).fill('/synthetic/project');
  await memory.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('article', { name: '创建记忆者', exact: true })).toContainText('synthetic-created-memory');
  await memory.getByRole('textbox', { name: '已有会话编号' }).fill('synthetic-created-memory');
  await memory.getByRole('button', { name: '检查会话', exact: true }).click();
  await memory.getByRole('button', { name: '明确绑定为记忆者' }).click();
  await expect.poll(() => fixture.posts.length).toBe(4);
  expect(fixture.posts[3]).toMatchObject({ path: '/roles/bind', body: {
    role: 'memory', sessionId: 'synthetic-created-memory', expectedModelId: 'synthetic-model',
    expectedEpoch: 0, definitionVersion: '1',
  } });
  const reception = page.getByRole('region', { name: '接待者设置', exact: true });
  await reception.getByRole('textbox', { name: '已有会话编号' }).fill('synthetic-reception');
  await reception.getByRole('button', { name: '检查会话', exact: true }).click();
  await reception.getByRole('textbox', { name: '接待者名称' }).fill('我的接待者');
  await reception.getByRole('button', { name: '明确接入接待者' }).click();
  await expect(page.getByRole('article', { name: '接入接待者', exact: true })).toContainText('已接受');
  expect(fixture.posts[4]).toMatchObject({ path: '/enrollment', body: {
    sessionId: 'synthetic-reception', label: '我的接待者', kind: 'reception',
  } });
  const ids = fixture.posts.map(post => post.body.requestId);
  expect(new Set(ids).size).toBe(5);
  for (const id of ids) expect(id).toMatch(uuid);
  expect(fixture.posts.every(post => !['/prompt', '/sessions/reload'].includes(post.path))).toBe(true);
  assertClean(fixture);
});

test('unknown input never resends; receipt lookup uses the original ID and preserves a newer draft', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/messages') return false;
      await json(route, { upstream: 'unknown synthetic transport result' }, 503);
      return true;
    } });
  await page.goto('/');
  await openAssistant(page);
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  await draft.fill('仅发送一次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('状态未知');
  const requestId = String(fixture.posts[0]?.body.requestId);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openAssistant(page);
  await draft.fill('不应被旧请求清空的新草稿');
  await draft.press('Enter');
  await page.getByRole('button', { name: '检查发送回执' }).click();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('输入已保存');
  await expect(draft).toHaveValue('不应被旧请求清空的新草稿');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => request.path === `/inputs/${requestId}`)).toBe(true);
  assertClean(fixture);
});

test('binding requires explicitly loaded sessions and known applied roles, without automatic repair', async ({ page }) => {
  let inspection: { loaded: boolean; rolesNeedReload: boolean | null } = { loaded: false, rolesNeedReload: false };
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false,
    read: async (url, route) => {
      if (!url.pathname.endsWith('/inspect')) return false;
      await json(route, { sessionId: 'synthetic-coordinator', modelId: 'synthetic-model',
        cwd: '/synthetic/project', status: 'idle', ...inspection });
      return true;
    },
  });
  await page.goto('/');
  await openAssistant(page);
  await page.getByRole('button', { name: '展开设置' }).click();
  const coordinator = page.getByRole('region', { name: '编排者设置', exact: true });
  await coordinator.getByRole('textbox', { name: '已有会话编号' }).fill('synthetic-coordinator');
  const inspect = coordinator.getByRole('button', { name: '检查会话', exact: true });
  const bind = coordinator.getByRole('button', { name: '明确绑定为编排者' });
  await inspect.click();
  await expect(coordinator).toContainText('助手不会自动加载');
  await expect(bind).toBeDisabled();
  inspection = { loaded: true, rolesNeedReload: true };
  await inspect.click();
  await expect(coordinator).toContainText('助手不会自动修复');
  await expect(bind).toBeDisabled();
  inspection = { loaded: true, rolesNeedReload: null };
  await inspect.click();
  await expect(coordinator).toContainText('角色配置是否已应用尚不明确');
  await expect(bind).toBeDisabled();
  expect(fixture.posts).toEqual([]);
  inspection = { loaded: true, rolesNeedReload: false };
  await inspect.click();
  await expect(bind).toBeEnabled();
  await bind.click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.path).toBe('/roles/bind');
  assertClean(fixture);
});

test('late POST completion after close/reopen cannot erase new typing or duplicate the write', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/messages') return false;
      await gate;
      await json(route, { accepted: true });
      return true;
    } });
  await page.goto('/');
  await openAssistant(page);
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  await draft.fill('旧请求还在飞行中');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openAssistant(page);
  await draft.fill('关闭后重新输入的内容');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  release?.();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('已接受');
  await expect(draft).toHaveValue('关闭后重新输入的内容');
  expect(fixture.posts).toHaveLength(1);
  assertClean(fixture);
});

test('paging and duplicate/out-of-order SSE recover from the applied cursor without losing reading position', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let streamCount = 0;
  const ten = publication(10, '新增的完整消息十');
  const eleven = publication(11, '补读的完整消息十一');
  const twelve = publication(12, '补读的完整消息十二');
  const fixture = await installFixture(page, {
    stream: async (_after, route) => {
      if (++streamCount !== 1) return false;
      await gate;
      fixture.setTimeline([...timeline, ten, eleven, twelve]);
      await route.fulfill({ contentType: 'text/event-stream', body: streamBody([ten, ten, twelve]) });
      return true;
    },
  });
  await page.goto('/');
  await openAssistant(page);
  const scroller = page.locator('.ca-scroller');
  await page.getByRole('button', { name: '加载更早消息' }).scrollIntoViewIfNeeded();
  const before = await page.locator('[data-ca-item="publication-4"]').evaluate(element => element.getBoundingClientRect().top);
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.locator('[data-ca-item]')).toHaveCount(9);
  const after = await page.locator('[data-ca-item="publication-4"]').evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(before - after)).toBeLessThan(5);
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  release?.();
  await expect(page.locator('[data-ca-item]')).toHaveCount(12);
  expect(await page.locator('[data-ca-item]').evaluateAll(elements => elements.map(element => element.getAttribute('data-ca-item'))))
    .toEqual(Array.from({ length: 12 }, (_, index) => `publication-${index + 1}`));
  await expect.poll(() => fixture.requests.some(request => request.path === '/timeline' && request.query.includes('after=10'))).toBe(true);
  await expect.poll(() => fixture.requests.some(request => request.path === '/timeline/stream' && request.query.includes('after=12'))).toBe(true);
  await expect(page.getByRole('button', { name: '3 条新消息，查看最新' })).toBeVisible();
  expect(await scroller.evaluate(element => element.scrollTop)).toBeLessThan(100);
  await page.getByRole('button', { name: '3 条新消息，查看最新' }).click();
  await expect(page.getByText('补读的完整消息十二', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: /条新消息，查看最新/ })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  assertClean(fixture);
});

test('unknown create receipt stays inspectable after reopening and never creates twice', async ({ page }) => {
  let createdId = '';
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/sessions') return false;
      createdId = String(post.body.requestId);
      await json(route, { state: 'unknown', result: { detail: 'Synthetic acknowledgement lost' } });
      return true;
    },
    read: async (url, route) => {
      if (!url.pathname.includes('/operations/')) return false;
      await json(route, { id: `create:${createdId}`, fingerprint: 'synthetic', state: 'unknown',
        result: { detail: 'Still not confirmed; do not repeat' } });
      return true;
    },
  });
  await page.goto('/');
  await openAssistant(page);
  await page.getByRole('button', { name: '展开设置' }).click();
  const coordinator = page.getByRole('region', { name: '编排者设置', exact: true });
  await coordinator.getByRole('textbox', { name: '新会话工作目录' }).fill('/synthetic/project');
  await coordinator.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('article', { name: '创建编排者', exact: true })).toContainText('状态未知');
  await expect(coordinator.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
  const memory = page.getByRole('region', { name: '记忆者设置', exact: true });
  await memory.getByRole('textbox', { name: '新会话工作目录' }).fill('/synthetic/memory');
  await expect(memory.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
  const reception = page.getByRole('region', { name: '接待者设置', exact: true });
  await reception.getByRole('textbox', { name: '新会话工作目录' }).fill('/synthetic/reception');
  await expect(reception.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openAssistant(page);
  await page.getByRole('button', { name: '检查操作状态' }).click();
  await expect(page.getByRole('article', { name: '创建编排者', exact: true })).toContainText('Still not confirmed');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => decodeURIComponent(request.path) === `/operations/create:${createdId}`)).toBe(true);
  assertClean(fixture);
});
