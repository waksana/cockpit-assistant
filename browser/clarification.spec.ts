import { expect, test } from '@playwright/test';
import { installFixture, json, publication } from './fixtures.ts';
import type { Clarification } from '../frontend/clarification.ts';

const pending = (id = 'q1', patch: Partial<Clarification> = {}): Clarification => ({
  id, question: '你指的是哪个项目？', choices: [], allowFreeform: true,
  createdAt: 1_750_000_100_000, answer: null, answeredAt: null, requestId: null, ...patch,
});

test('clarification stays on its original row and a stale reload cannot reopen the answered card', async ({ page }) => {
  let clarification = pending();
  let message = publication(1, '继续之前的项目', { speaker: 'user', clarifications: [clarification] });
  const path = '/messages/publication-1/clarifications/q1';
  const fixture = await installFixture(page, {
    items: [message], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== path) return false;
      clarification = { ...clarification, answer: String(post.body.answer),
        answeredAt: 1_750_000_101_000, requestId: String(post.body.requestId) };
      message = { ...message, snapshotRevision: 20, clarifications: [clarification] };
      fixture.setTimeline([message]);
      await json(route, { messageId: message.id, clarification });
      return true;
    },
    read: async (url, route) => {
      if (!url.pathname.endsWith(path)) return false;
      await json(route, { messageId: message.id, clarification });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  const row = page.locator('[data-ca-item="publication-1"]');
  const card = row.getByRole('group', { name: '需要澄清', exact: true });
  await expect(card).toBeVisible();
  await expect(page.locator('[data-ca-item]')).toHaveCount(1);
  await expect(row.getByText('继续之前的项目', { exact: true })).toHaveCount(1);
  const main = page.getByPlaceholder('输入消息…', { exact: true });
  await main.fill('不要清掉主输入框');
  await card.getByRole('textbox').fill('指的是 Cockpit 项目');
  await card.getByRole('button', { name: '提交补充', exact: true }).click();
  await expect(row.getByRole('group', { name: '已完成的澄清', exact: true })).toContainText('指的是 Cockpit 项目');
  await expect(main).toHaveValue('不要清掉主输入框');
  expect(fixture.posts.map(post => post.path)).toEqual([path]);
  expect(Object.keys(fixture.posts[0]!.body).sort()).toEqual(['answer', 'requestId']);
  fixture.setTimeline([{ ...message, snapshotRevision: 1, clarifications: [pending()] }]);
  await page.reload();
  await expect(row.getByRole('group', { name: '已完成的澄清', exact: true })).toContainText('指的是 Cockpit 项目');
  await expect(row.getByText('继续之前的项目', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-ca-item]')).toHaveCount(1);
  expect(fixture.requests.some(request => request.path === path && request.method === 'GET')).toBe(true);
  expect(fixture.posts).toHaveLength(1);
  expect(await page.evaluate(() => window.fixtureNativeSends)).toBe(0);
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
});

test('delivery failure feedback is retained by timeline validation and shown with the original', async ({ page }) => {
  const original = publication(1, '这条原话保持可见', { speaker: 'user',
    deliveryIssues: [{ topicMessageId: 'delivery-1', state: 'unknown', detail: '投递回执无法确认，请查看原会话' }],
  });
  const fixture = await installFixture(page, { items: [original], hasOlder: false });
  await page.goto('/modules/assistant/main');
  const row = page.locator('[data-ca-item="publication-1"]');
  await expect(row.getByRole('alert')).toHaveText('投递回执无法确认，请查看原会话');
  await expect(row.getByText('这条原话保持可见', { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-ca-item]')).toHaveCount(1);
  expect(fixture.posts).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
});

test('local clarification choices do not turn ordinary business questions into answer cards', async ({ page }) => {
  let clarification = pending('q1', { choices: ['旅行项目', '代码项目'], allowFreeform: false });
  const original = publication(1, '继续之前的事项', { speaker: 'user', clarifications: [clarification] });
  const nativeQuestion = publication(2, '选择交通方式', { type: 'question',
    question: { state: 'pending', stateVersion: 1, choices: ['火车', '飞机'], allowFreeform: false } });
  const fixture = await installFixture(page, { items: [original, nativeQuestion], hasOlder: false,
    post: async (post, route) => {
      if (!post.path.endsWith('/clarifications/q1')) return false;
      clarification = { ...clarification, answer: String(post.body.answer),
        answeredAt: 1_750_000_102_000, requestId: String(post.body.requestId) };
      await json(route, { messageId: original.id, clarification });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  const card = page.getByRole('group', { name: '需要澄清', exact: true });
  await expect(card.getByRole('textbox')).toHaveCount(0);
  const business = page.locator('[data-ca-item="publication-2"]');
  await expect(business).toContainText('火车');
  await expect(business.getByRole('button')).toHaveCount(0);
  await card.getByRole('button', { name: '代码项目', exact: true }).click();
  await expect(page.getByRole('group', { name: '已完成的澄清', exact: true })).toContainText('代码项目');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]!.body.answer).toBe('代码项目');
  expect(fixture.consoleErrors).toEqual([]);
});

test('lost local answer response is passively confirmed after reload and never resent', async ({ page }) => {
  let clarification = pending();
  let message = publication(1, '确认之前的项目', { speaker: 'user', clarifications: [clarification] });
  const path = '/messages/publication-1/clarifications/q1';
  const fixture = await installFixture(page, { items: [message], hasOlder: false,
    post: async (post, route) => {
      if (post.path !== path) return false;
      clarification = { ...clarification, answer: String(post.body.answer),
        answeredAt: 1_750_000_103_000, requestId: String(post.body.requestId) };
      message = { ...message, snapshotRevision: 10, clarifications: [clarification] };
      fixture.setTimeline([message]);
      await route.abort('failed');
      return true;
    },
    read: async (url, route) => {
      if (!url.pathname.endsWith(path)) return false;
      await json(route, { messageId: message.id, clarification });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  const card = page.getByRole('group', { name: '需要澄清', exact: true });
  await card.getByRole('textbox').fill('已经保存的补充');
  await card.getByRole('button', { name: '提交补充', exact: true }).click();
  await expect(card.getByRole('textbox')).toHaveValue('已经保存的补充');
  await expect(card.getByRole('status')).toContainText('状态未确认');
  await expect(card.getByRole('button', { name: '提交补充', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('group', { name: '已完成的澄清', exact: true })).toContainText('已经保存的补充');
  await expect.poll(() => fixture.requests.filter(request => request.path === path && request.method === 'GET').length)
    .toBeGreaterThan(0);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.consoleErrors).toEqual([]);
});

test('clarification IME and message identity are isolated from another waiting message', async ({ page }) => {
  const first = publication(1, '第一个待澄清事项', { speaker: 'user', clarifications: [pending('q1')] });
  const second = publication(2, '第二个待澄清事项', { speaker: 'user', clarifications: [pending('q2')] });
  const fixture = await installFixture(page, { items: [first, second], hasOlder: false,
    post: async (post, route) => {
      if (!post.path.endsWith('/clarifications/q2')) return false;
      await json(route, { messageId: second.id, clarification: {
        ...pending('q2'), answer: String(post.body.answer), requestId: String(post.body.requestId),
        answeredAt: 1_750_000_104_000,
      } });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  const firstCard = page.locator('[data-ca-clarification="q1"]');
  const secondCard = page.locator('[data-ca-clarification="q2"]');
  await firstCard.getByRole('textbox').fill('第一个草稿');
  await secondCard.getByRole('textbox').fill('第二个补充');
  await secondCard.getByRole('textbox').evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true }));
  });
  expect(fixture.posts).toHaveLength(0);
  await secondCard.getByRole('button', { name: '提交补充', exact: true }).click();
  await expect(secondCard).toHaveAttribute('data-state', 'answered');
  await expect(firstCard).toHaveAttribute('data-state', 'pending');
  await expect(firstCard.getByRole('textbox')).toHaveValue('第一个草稿');
  expect(fixture.posts.map(post => post.path)).toEqual(['/messages/publication-2/clarifications/q2']);
  await expect(page.locator('[data-ca-item]')).toHaveCount(2);
  expect(fixture.consoleErrors).toEqual([]);
});
