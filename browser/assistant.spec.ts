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
  await expect(page.getByTestId('empty-homepage').getByRole('heading')).toHaveText('没有选择会话');
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
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('synthetic-assistant.png') });
  const back = page.getByRole('button', { name: '返回 Cockpit', exact: true });
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await expect(page.locator('.ca-header button')).toHaveCount(2);
  for (const [control, title] of [[back, '返回 Cockpit'], [settings, '设置']] as const) {
    await expect(control).toHaveClass('ck-icon-button');
    await expect(control).toHaveAttribute('title', title);
    await expect(control.locator('svg')).toHaveClass('ck-icon ck-icon-lg');
    await expect(control.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(control.locator('svg')).toHaveAttribute('focusable', 'false');
    const rect = await control.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(info.project.name.startsWith('mobile') ? 44 : 40);
    expect(rect!.height).toBeGreaterThanOrEqual(info.project.name.startsWith('mobile') ? 44 : 40);
  }
  expect((await back.boundingBox())!.x).toBeLessThan((await settings.boundingBox())!.x);
  await expect(back.locator('path').first()).toHaveAttribute('d', 'm12 19-7-7 7-7');
  await settings.click();
  const setup = page.getByRole('region', { name: '设置', exact: true });
  // These read-only assertions cannot scroll hidden settings into view.
  await expect(setup.getByRole('heading', { name: '角色设置', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(setup).toContainText('选择 coordinator 或 memory');
  await expect(page.locator('.ca-scroller')).toHaveJSProperty('scrollTop', 0);
  expect(fixture.posts).toEqual([]);
  assertClean(fixture);
});

test('not-ready users can edit and preserve drafts but cannot send, then refresh actual readiness', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await page.getByRole('button', { name: '选择合成会话', exact: true }).click();
  await page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入', exact: true }).fill('保留宿主草稿');
  await page.evaluate(() => history.pushState({}, '', '/#synthetic-selected-session'));
  const hostUrl = page.url();
  await openAssistant(page);
  const draft = page.getByRole('dialog').getByRole('textbox', { name: '消息输入', exact: true });
  const send = page.getByRole('dialog').getByRole('button', { name: '发送', exact: true });
  await draft.fill('尚未就绪也保留我的草稿');
  await expect(draft).toBeEditable();
  await expect(send).toBeDisabled();
  await draft.press('Enter');
  const savedText = await draft.inputValue();
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('selected-session')).toBeVisible();
  await expect(page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('保留宿主草稿');
  expect(page.url()).toBe(hostUrl);
  await openAssistant(page);
  await expect(draft).toHaveValue(savedText);
  expect(fixture.requests.filter(request => request.path === '/readiness')).toHaveLength(2);
  fixture.setReadiness(readiness());
  await page.getByRole('button', { name: '刷新就绪状态' }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(draft).toHaveValue('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]?.body.text).toBe(savedText.trim());
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
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const heading = page.getByRole('region', { name: '设置', exact: true })
    .getByRole('heading', { name: '角色设置', exact: true });
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
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('火车');
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('');
  expect(fixture.posts[0]?.body).toMatchObject({ text: '火车', replyTo: 'anchor-7' });
  await page.locator('[data-ca-item="publication-8"]').getByRole('button', { name: '回复', exact: true }).click();
  await expect(page.getByText('来源：synthetic-reception · 引用：anchor-8')).toBeVisible();
  await expect(reference.locator('.ca-choices')).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('关于旧问题的普通评论');
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await expect(page.getByText('来源：synthetic-reception · 引用：anchor-8')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('关于旧问题的普通评论');
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
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  fixture.setTimeline([later]);
  await openAssistant(page);
  await expect(page.locator('[data-ca-item="publication-1"]')).toHaveCount(0);
  await expect(reference).toContainText('retained-question-anchor');
  await expect(reference.getByRole('button', { name: '火车', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '火车', exact: true })).toHaveCount(1);
  await expect(page.locator('[data-ca-item="publication-2"]').getByRole('button', { name: '另一个选项', exact: true })).toBeEnabled();
  await reference.getByRole('button', { name: '火车', exact: true }).click();
  await expect(page.getByText('已选：火车', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  await page.getByRole('button', { name: '发送选项', exact: true }).click();
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
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  const send = page.getByRole('button', { name: /^(发送|发送选项|正在提交)$/ });
  const scroller = page.locator('.ca-scroller');
  const assertComposerVisible = async () => {
    await expect(page.locator('.ca-composer')).toBeInViewport();
    await expect(send).toBeInViewport();
    expect(await scroller.evaluate(element => element.clientHeight)).toBeGreaterThan(100);
  };
  await assertComposerVisible();
  await page.locator('[data-ca-item="publication-1"]').getByRole('button', { name: selected, exact: true }).click();
  await expect(page.getByText(`已选：${selected}`, { exact: true })).toBeVisible();
  await expect(draft).toHaveCount(0);
  await assertComposerVisible();
  await expect(scroller.getByRole('region', { name: '当前回复引用', exact: true })).toContainText('immutable-question-anchor');
  await expect(page.locator('.ca-composer').getByText('已选择回复引用', { exact: true })).toBeVisible();
  await expect(page.locator('.ca-composer').getByRole('button', { name: selected, exact: true })).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  await send.click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: selected, replyTo: 'immutable-question-anchor' });
  await page.locator('[data-ca-item="publication-2"]').getByRole('button', { name: '新的选择', exact: true }).click();
  await expect(page.getByText('已选：新的选择', { exact: true })).toBeVisible();
  await assertComposerVisible();
  release?.();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('已接受');
  await expect(page.getByText('已选：新的选择', { exact: true })).toBeVisible();
  expect(fixture.posts[0]?.body.replyTo).toBe('immutable-question-anchor');
  expect(fixture.posts).toHaveLength(1);
  assertClean(fixture);
});

test('role registration belongs to Cockpit; no manual UUID, create, bind or reception enrollment forms', async ({ page }) => {
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false });
  await page.goto('/');
  await openAssistant(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const setup = page.getByRole('region', { name: '设置', exact: true });
  await expect(setup).toContainText('在 Cockpit 创建会话或添加角色时选择 coordinator 或 memory');
  await expect(setup).toContainText('所有普通会话都会自动观察，无需单独接入');
  await expect(setup).toContainText('刷新只读取状态');
  await expect(setup).toContainText('冷加载包含宿主正常的原生工具初始化');
  await expect(setup).toContainText('不会额外修复资源、强制重载或自动启用被禁用的资源');
  await expect(setup.locator('input,select,form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /创建会话|绑定|接入接待者|检查会话/ })).toHaveCount(0);
  await expect(page.locator('.ca-role-status strong')).toHaveText(['coordinator', 'memory']);
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
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('状态未知');
  const requestId = String(fixture.posts[0]?.body.requestId);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await draft.fill('不应被旧请求清空的新草稿');
  await draft.press('Enter');
  const newerText = await draft.inputValue();
  await page.getByRole('button', { name: '检查发送回执' }).click();
  await expect(page.getByRole('article', { name: '发送回执', exact: true })).toContainText('输入已持久保存');
  await expect(draft).toHaveValue(newerText);
  expect(newerText.trim()).toBe('不应被旧请求清空的新草稿');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => request.path === `/inputs/${requestId}`)).toBe(true);
  assertClean(fixture);
});

test('opening loads only bound unloaded carriers, preserves pending receipts and never repairs invalid roles', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, { ready: false, items: [], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== '/roles/activate') return false;
      await gate;
      await json(route, { id: `activate:${post.body.requestId}`, fingerprint: 'synthetic',
        state: 'accepted', result: { loaded: ['synthetic-coordinator'] } });
      return true;
    },
  });
  const unloaded = readiness();
  unloaded.canSend = false;
  unloaded.roles[0]!.status = 'unloaded';
  unloaded.roles[1]!.status = 'invalid';
  unloaded.roles[1]!.detail = '角色已选择但尚未应用，请在 Cockpit 处理';
  fixture.setReadiness(unloaded);
  await page.goto('/');
  await openAssistant(page);
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]).toMatchObject({ path: '/roles/activate', body: { bindings: [
    { role: 'coordinator', sessionId: 'synthetic-coordinator', epoch: 1 },
    { role: 'memory', sessionId: 'synthetic-memory', epoch: 1 },
  ] } });
  expect(fixture.posts[0]!.body.requestId).toMatch(uuid);
  const receipt = page.getByRole('article', { name: '加载内部角色会话', exact: true });
  await expect(receipt).toContainText('处理中');
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await expect(receipt).toContainText('处理中');
  const draft = page.getByRole('textbox', { name: '消息输入', exact: true });
  await draft.fill('加载完成不得改变此草稿');
  await expect(page.locator('.ca-role-status').last()).toContainText('角色已选择但尚未应用');
  unloaded.roles[0]!.status = 'ready';
  fixture.setReadiness(unloaded);
  release();
  await expect(receipt).toContainText('已接受');
  await expect(page.locator('.ca-role-status').first()).toContainText('已就绪');
  await expect(draft).toHaveValue('加载完成不得改变此草稿');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
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
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  await openAssistant(page);
  await draft.fill('关闭后重新输入的内容');
  await expect(page.getByRole('button', { name: '正在提交', exact: true })).toBeDisabled();
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
  const receipt = page.getByRole('article', { name: '加载内部角色会话', exact: true });
  await expect(receipt).toContainText('状态未知');
  await page.getByRole('button', { name: '返回 Cockpit', exact: true }).click();
  unloaded.roles[0]!.status = 'unknown';
  fixture.setReadiness(unloaded);
  await openAssistant(page);
  await expect(page.locator('.ca-role-status').first()).toContainText('状态未知');
  await page.getByRole('button', { name: '检查操作状态' }).click();
  await expect(receipt).toContainText('回执状态：unknown');
  await receipt.getByRole('button', { name: '展开完整结果' }).click();
  await expect(receipt).toContainText('Still not confirmed');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => decodeURIComponent(request.path) === `/operations/activate:${activationId}`)).toBe(true);
  expect(fixture.requests.filter(request => request.path === '/readiness').length).toBeGreaterThanOrEqual(3);
  assertClean(fixture);
});
