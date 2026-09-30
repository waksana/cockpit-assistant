import { expect, test, type Page } from '@playwright/test';
import { installFixture, json, publication, readiness, streamBody, timeline } from './fixtures.ts';

async function openAssistant(page: Page) {
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await expect(page.getByRole('menu', { name: '全局菜单', exact: true })).toHaveClass('btn-menu');
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await expect(page.locator('.ca-page')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).toHaveAttribute('aria-busy', 'false');
}
async function detail(page: Page, name: string | RegExp) {
  const control = page.getByRole('button', { name, exact: typeof name === 'string' });
  await expect(control).toBeVisible();
  if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
}
function assertClean(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.posts.filter(post => post.path === '/messages')
    .every(post => !Object.hasOwn(post.body, 'replyTo'))).toBe(true);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('real host global menu opens on an empty homepage; complete conversation and public theme without provenance cards', async ({ page }, info) => {
  const fixture = await installFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-homepage').getByRole('heading')).toHaveText('没有选择会话');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openAssistant(page);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const messages = page.locator('[data-ca-item]');
  await expect(messages).toHaveCount(timeline.length);
  expect(await messages.evaluateAll(elements => elements.map(element => element.getAttribute('data-ca-item'))))
    .toEqual(timeline.map(item => item.id));
  await expect(page.locator('.ca-topic-heading')).toHaveCount(4);
  await expect(messages.first().locator('.ca-topic-heading')).toHaveCount(0);
  await expect(messages.nth(1).locator('.ca-topic-heading')).toHaveCount(0);
  await expect(messages.nth(2).locator('.ca-topic-heading')).toHaveText('旅行计划 A');
  await expect(messages.nth(2).locator('.ca-topic-heading')).toHaveCSS('border-inline-start-width', '0px');
  await expect(messages.first()).toContainText('A：先讨论旅行计划');
  await expect(messages.nth(1)).toContainText('B：现在讨论代码审查');
  await expect(messages.nth(2)).toContainText('A：继续刚才的旅行计划');
  await expect(page.getByRole('region', { name: '对话记录', exact: true }))
    .not.toContainText(/来源：|synthetic-reception|代码审查 B/);
  const long = page.locator('[data-ca-item="publication-9"]');
  await expect(long.getByRole('heading', { name: '完整 Markdown 回答' })).toBeVisible();
  await expect(long.getByRole('table')).toContainText('已确认');
  await expect(long.locator('pre')).toContainText('const result');
  await expect(long.getByText('长回答结束标记', { exact: true })).toBeVisible();
  await expect(messages.first().locator('time')).toHaveAttribute('datetime', /2025-/);
  const measurements = await page.locator('.ca-page').evaluate(element => {
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
  expect(measurements.dark).toBe(info.project.name.endsWith('dark'));
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('synthetic-assistant.png') });
  const back = page.getByRole('link', { name: '返回 Cockpit', exact: true });
  const coordinator = page.getByRole('button', { name: 'coordinator：已就绪', exact: true });
  const connection = page.getByRole('button', { name: '实时连接：已连接', exact: true });
  await expect(page.locator('.ca-header button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^memory：/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  for (const [control, title] of [[back, '返回 Cockpit'], [coordinator, 'coordinator：已就绪'],
    [connection, '实时连接：已连接']] as const) {
    await expect(control).toHaveClass(title.startsWith('coordinator')
      ? /ck-button/ : 'ck-icon-button');
    await expect(control).toHaveAttribute('title', title);
    await expect(control.locator('svg')).toHaveClass(/ck-icon/);
    await expect(control.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(control.locator('svg')).toHaveAttribute('focusable', 'false');
    const rect = await control.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(info.project.name.startsWith('mobile') ? 44 : 40);
    expect(rect!.height).toBeGreaterThanOrEqual(info.project.name.startsWith('mobile') ? 44 : 40);
  }
  expect((await back.boundingBox())!.x).toBeLessThan((await coordinator.boundingBox())!.x);
  await expect(back.locator('path').first()).toHaveAttribute('d', 'm12 19-7-7 7-7');
  await expect(coordinator).toHaveText('coordinator');
  await expect(connection).toHaveText('');
  await coordinator.click();
  const setup = page.getByRole('region', { name: '状态详情', exact: true });
  await expect(setup).toBeInViewport({ ratio: 1 });
  await expect(setup).toContainText('synthetic-coordinator');
  await expect(setup).not.toContainText('synthetic-memory');
  await setup.getByRole('button', { name: '刷新就绪状态' }).focus();
  await page.keyboard.press('Escape');
  await expect(setup).toHaveCount(0);
  await expect(coordinator).toBeFocused();
  expect(fixture.posts).toEqual([]);
  assertClean(fixture);
});

test('not-ready users can edit and preserve drafts but cannot send, then refresh actual readiness', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await page.getByRole('button', { name: '选择合成会话', exact: true }).click();
  await page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入', exact: true }).fill('保留宿主草稿');
  await openAssistant(page);
  await expect(page.getByTestId('selected-session')).toHaveCount(0);
  const draft = page.locator('.ca-page').getByRole('textbox', { name: '消息输入', exact: true });
  const send = page.locator('.ca-page').getByRole('button', { name: '发送', exact: true });
  await draft.fill('尚未就绪也保留我的草稿');
  await expect(draft).toBeEditable();
  await expect(send).toBeDisabled();
  await draft.press('Enter');
  const savedText = await draft.inputValue();
  expect(fixture.posts).toEqual([]);
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('empty-homepage')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await page.getByRole('button', { name: '选择合成会话', exact: true }).click();
  await expect(page.getByTestId('selected-session')).toBeVisible();
  await expect(page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('保留宿主草稿');
  await openAssistant(page);
  await expect(draft).toHaveValue(savedText);
  expect(fixture.requests.filter(request => request.path === '/readiness')).toHaveLength(2);
  fixture.setReadiness(readiness());
  await detail(page, /^coordinator：/);
  await page.getByRole('button', { name: '刷新就绪状态' }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(draft).toHaveValue('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]?.body.text).toBe(savedText);
  expect(fixture.posts[0]?.body.requestId).toMatch(uuid);
  assertClean(fixture);
});

test('compact status detail remains visible while delayed history arrives', async ({ page }) => {
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
  await detail(page, /^实时连接：/);
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeDisabled();
  await detail(page, /^coordinator：/);
  const heading = page.getByRole('region', { name: '状态详情', exact: true });
  await expect(heading).toBeInViewport({ ratio: 1 });
  release?.();
  await expect(history).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-ca-item]')).toHaveCount(timeline.length);
  await expect(heading).toBeInViewport({ ratio: 1 });
  expect(fixture.requests.filter(request => request.path === '/timeline' && request.query === '?limit=50')).toHaveLength(1);
  assertClean(fixture);
});

test('question options are ordinary text answered only through Composer without hidden posting', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto('/');
  await openAssistant(page);
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '当前回复引用', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-ca-item="publication-7"]').getByRole('listitem')).toHaveText(['火车', '飞机']);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('火车');
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('火车');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('');
  expect(fixture.posts[0]?.body.text).toBe('火车');
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  await expect(page.locator('[data-ca-item="publication-8"]').getByRole('button')).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('关于旧问题的普通评论');
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('关于旧问题的普通评论');
  assertClean(fixture);
});

test('a typed answer survives reopening as text without retaining a question target', async ({ page }) => {
  const question = publication(1, '需要保留选项的早期问题', {
    type: 'question',
    question: { state: 'pending', stateVersion: 1, choices: ['火车', '飞机'], allowFreeform: false },
  });
  const later = publication(2, '最新窗口内的另一个问题', {
    type: 'question', question: { state: 'pending', stateVersion: 1, choices: ['另一个选项'], allowFreeform: false },
  });
  const fixture = await installFixture(page, { items: [question], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  await expect(page.locator('[data-ca-item="publication-1"]').getByRole('listitem')).toHaveText(['火车', '飞机']);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(0);
  await page.getByRole('textbox').fill('火车');
  await expect(page.getByRole('textbox')).toHaveValue('火车');
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  fixture.setTimeline([later]);
  await openAssistant(page);
  await expect(page.locator('[data-ca-item="publication-1"]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '当前回复引用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-ca-item="publication-2"]').getByRole('listitem')).toHaveText(['另一个选项']);
  await expect(page.locator('[data-ca-item="publication-2"]').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveValue('火车');
  await page.getByRole('textbox').fill('普通补充，不受旧问题限制');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body.text).toBe('普通补充，不受旧问题限制');
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  assertClean(fixture);
});

test('six long question choices stay in the scroller and never replace the public Composer', async ({ page }) => {
  const choices = Array.from({ length: 6 }, (_, index) => `选项${index + 1}：${'合成长选项'.repeat(24).slice(0, 116)}`);
  const selected = choices[3]!;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const question = publication(1, '请从六个完整的长选项中选择', {
    type: 'question', question: { state: 'pending', stateVersion: 1, choices, allowFreeform: false },
  });
  const later = publication(2, '另一个独立的待回答问题', {
    type: 'question', question: { state: 'pending', stateVersion: 1, choices: ['新的选择'], allowFreeform: false },
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
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  const send = page.getByRole('button', { name: /^(发送|发送选项|正在提交)$/ });
  const scroller = page.locator('.ca-scroller');
  const assertComposerVisible = async () => {
    await expect(page.locator('.ca-page .chat-input-area')).toBeInViewport({ ratio: 1 });
    await expect(draft).toBeInViewport();
    await expect(send).toBeInViewport();
    expect(await scroller.evaluate(element => element.clientHeight)).toBeGreaterThan(100);
  };
  await assertComposerVisible();
  await expect(page.locator('[data-ca-item="publication-1"]').getByRole('listitem')).toHaveText(choices);
  await expect(page.locator('[data-ca-item="publication-1"]').getByRole('button')).toHaveCount(0);
  await draft.fill(selected);
  await expect(draft).toHaveValue(selected);
  await assertComposerVisible();
  await expect(page.getByRole('region', { name: '当前回复引用', exact: true })).toHaveCount(0);
  await expect(page.locator('.ca-page .chat-input-area').getByRole('button', { name: selected, exact: true })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  await send.click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body.text).toBe(selected);
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  await expect(page.locator('[data-ca-item="publication-2"]').getByRole('listitem')).toHaveText(['新的选择']);
  await draft.fill('新的选择');
  await expect(draft).toHaveValue('新的选择');
  await assertComposerVisible();
  release?.();
  await expect(page.getByRole('button', { name: '正在提交', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送回执', exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue('新的选择');
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  expect(fixture.posts).toHaveLength(1);
  assertClean(fixture);
});

test('role registration belongs to Cockpit; no manual UUID, create, bind or reception enrollment forms', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  await detail(page, /^coordinator：/);
  const setup = page.getByRole('region', { name: '状态详情', exact: true });
  await expect(setup).toContainText('在 Cockpit 创建会话或添加角色时选择 coordinator');
  await expect(setup.locator('input,select,form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(创建会话|绑定|接入接待者|检查会话)/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'coordinator：未绑定' })).toHaveText('coordinator');
  await expect(page.getByRole('button', { name: /^memory：/ })).toHaveCount(0);
  await expect(page.getByText(/编排者|记忆者|Assistant coordinator|Assistant memory/)).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  const ready = readiness();
  ready.receptions = [];
  fixture.setReadiness(ready);
  await page.getByRole('button', { name: '刷新就绪状态' }).click();
  await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('无需配置接待会话');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
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
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  await draft.fill('仅发送一次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(/暂时无法确认发送状态/)).toBeVisible();
  const requestId = String(fixture.posts[0]?.body.requestId);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await draft.fill('不应被旧请求清空的新草稿');
  await draft.press('Enter');
  const newerText = await draft.inputValue();
  await expect(page.getByText(/暂时无法确认发送状态/)).toHaveCount(0);
  await expect(draft).toHaveValue(newerText);
  expect(newerText.trim()).toBe('不应被旧请求清空的新草稿');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => request.path === `/inputs/${requestId}`)).toBe(true);
  assertClean(fixture);
});

test('opening loads the bound coordinator and preserves its pending receipt without a memory carrier', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/roles/activate') return false;
      await gate;
      await json(route, { id: `activate:${post.body.requestId}`, kind: 'activate', fingerprint: 'synthetic',
        state: 'accepted', result: { loaded: ['synthetic-coordinator'] } });
      return true;
    },
  });
  const unloaded = readiness();
  unloaded.canSend = false;
  unloaded.roles[0]!.status = 'unloaded';
  fixture.setReadiness(unloaded);
  await page.goto('/');
  await openAssistant(page);
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]).toMatchObject({ path: '/roles/activate', body: { bindings: [
    { role: 'coordinator', sessionId: 'synthetic-coordinator' },
  ] } });
  expect(fixture.posts[0]!.body.requestId).toMatch(uuid);
  const receipt = page.getByText('正在准备角色会话…', { exact: true });
  await detail(page, /^coordinator：/);
  await expect(receipt).toBeVisible();
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await detail(page, /^coordinator：/);
  await expect(receipt).toBeVisible();
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  await draft.fill('加载完成不得改变此草稿');
  await expect(page.getByRole('button', { name: /^memory：/ })).toHaveCount(0);
  unloaded.roles[0]!.status = 'ready';
  unloaded.canSend = true;
  fixture.setReadiness(unloaded);
  release();
  await expect(receipt).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'coordinator：已就绪' })).toBeVisible();
  await expect(draft).toHaveValue('加载完成不得改变此草稿');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1);
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
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  await draft.fill('旧请求还在飞行中');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await draft.fill('关闭后重新输入的内容');
  await expect(page.getByRole('button', { name: '正在提交', exact: true })).toBeDisabled();
  release?.();
  await expect(page.getByRole('button', { name: '正在提交', exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue('关闭后重新输入的内容');
  expect(fixture.posts).toHaveLength(1);
  assertClean(fixture);
});

test('paging and duplicate SSE recover sparse revisions after a disconnect without losing reading position', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let streamCount = 0;
  const ten = publication(10, '新增的完整消息十', { snapshotRevision: 20 });
  const eleven = publication(11, '补读的完整消息十一', { snapshotRevision: 30 });
  const twelve = publication(12, '补读的完整消息十二', { snapshotRevision: 50 });
  const fixture = await installFixture(page, {
    stream: async (_after, route) => {
      if (++streamCount !== 1) return false;
      await gate;
      fixture.setTimeline([...timeline, ten, eleven, twelve]);
      await route.fulfill({ contentType: 'text/event-stream',
        body: streamBody([ten, ten]) + 'event: error\ndata: interrupted fixture stream\n\n' });
      return true;
    },
  });
  await page.goto('/');
  await openAssistant(page);
  const scroller = page.locator('.ca-scroller');
  const earlier = page.getByRole('button', { name: '加载更早消息' });
  await earlier.scrollIntoViewIfNeeded();
  await earlier.focus();
  const anchor = page.locator('[data-ca-item="publication-4"] [data-message-id]');
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top);
  await earlier.click();
  await expect(page.locator('[data-ca-item]')).toHaveCount(9);
  await expect.poll(async () => Math.abs(before - await anchor.evaluate(element =>
    element.getBoundingClientRect().top))).toBeLessThan(5);
  await scroller.press('Home');
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  release?.();
  await expect(page.locator('[data-ca-item]')).toHaveCount(12);
  expect(await page.locator('[data-ca-item]').evaluateAll(elements => elements.map(element => element.getAttribute('data-ca-item'))))
    .toEqual(Array.from({ length: 12 }, (_, index) => `publication-${index + 1}`));
  await expect.poll(() => fixture.requests.some(request => request.path === '/timeline' && request.query.includes('after=20'))).toBe(true);
  await expect.poll(() => fixture.requests.some(request => request.path === '/timeline/stream' && request.query.includes('after=50'))).toBe(true);
  await expect(page.getByRole('button', { name: '有新内容 · 回到最新' })).toBeVisible();
  expect(await scroller.evaluate(element => element.scrollTop)).toBeLessThan(100);
  await page.getByRole('button', { name: '有新内容 · 回到最新' }).click();
  await expect(page.getByText('补读的完整消息十二', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '有新内容 · 回到最新' })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  assertClean(fixture);
});

test('unknown internal activation stays inspectable across reopen with no new-ID retry or guessed readiness', async ({ page }) => {
  let activationId = '';
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/roles/activate') return false;
      activationId = String(post.body.requestId);
      await json(route, { id: `activate:${activationId}`, fingerprint: 'synthetic',
        state: 'unknown', result: { detail: 'Synthetic acknowledgement lost' } });
      return true;
    },
    read: async (url, route) => {
      if (!url.pathname.includes('/operations/')) return false;
      await json(route, { id: `activate:${activationId}`, fingerprint: 'synthetic', state: 'unknown',
        result: { detail: 'Still not confirmed; do not repeat' } });
      return true;
    },
  });
  const unloaded = readiness();
  unloaded.canSend = false;
  unloaded.roles[0]!.status = 'unloaded';
  fixture.setReadiness(unloaded);
  await page.goto('/');
  await openAssistant(page);
  const receipt = page.getByText('角色会话尚未就绪，请刷新就绪状态。', { exact: true });
  await detail(page, /^coordinator：/);
  await expect(receipt).toBeVisible();
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  unloaded.roles[0]!.status = 'unknown';
  fixture.setReadiness(unloaded);
  await openAssistant(page);
  await detail(page, /^coordinator：/);
  await expect(page.getByRole('button', { name: 'coordinator：状态未知' })).toBeVisible();
  await page.getByRole('button', { name: '刷新就绪状态' }).click();
  await expect(receipt).toBeVisible();
  await expect(page.getByRole('button', { name: '检查操作状态' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开完整结果' })).toHaveCount(0);
  await expect(page.getByText('Still not confirmed')).toHaveCount(0);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => decodeURIComponent(request.path) === `/operations/activate:${activationId}`)).toBe(true);
  expect(fixture.requests.filter(request => request.path === '/readiness').length).toBeGreaterThanOrEqual(3);
  assertClean(fixture);
});
