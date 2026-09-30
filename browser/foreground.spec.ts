import { expect, test } from '@playwright/test';
import { installFixture, json, publication } from './fixtures.ts';

test('foreground conversation rejects an older aggregation protocol without reading or sending its feed', async ({ page }) => {
  const fixture = await installFixture(page, {
    items: [publication(1, 'Old worker output must not enter foreground')],
    read: async (url, route) => {
      if (!url.pathname.endsWith('/state')) return false;
      await json(route, { protocolVersion: 3, timelineProtocol: 'message-snapshots-v1' });
      return true;
    },
  });
  await page.goto('/modules/assistant/main');
  await expect(page.getByRole('alert')).toContainText('协议不兼容');
  await expect(page.locator('[data-ca-item]')).toHaveCount(0);
  await page.getByPlaceholder('输入消息…').fill('协议确认前不发送');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(fixture.requests.some(request => request.path.startsWith('/timeline'))).toBe(false);
  expect(fixture.posts).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
});

test('old messages and clarification records stay available in an explicit read-only archive', async ({ page }) => {
  const original = publication(1, '原先用户消息', { speaker: 'user', clarifications: [{
    id: 'old-card', question: '旧版分类需要补充什么？', choices: ['A', 'B'], allowFreeform: true,
    createdAt: 1_750_000_001_000, answer: null, answeredAt: null, requestId: null,
  }] });
  const oldReply = publication(2, '原先后台完整回复', { topicTitle: '关于旧话题A和旧话题B' });
  const fixture = await installFixture(page, {
    items: [publication(100, '前台自然回复')], hasOlder: false, legacyItems: [original, oldReply],
  });
  await page.goto('/modules/assistant/main');
  const main = page.getByPlaceholder('输入消息…');
  await expect(page.getByRole('button', { name: 'coordinator：已就绪', exact: true })).toBeVisible();
  await main.fill('我的当前草稿');
  await page.getByRole('button', { name: 'coordinator：已就绪', exact: true }).click();
  await page.getByRole('button', { name: '查看旧版记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '助手 · 旧版记录', exact: true })).toBeVisible();
  await expect(page.locator('[data-ca-item]')).toHaveCount(2);
  await expect(page.locator('.ca-topic-heading')).toHaveText('关于旧话题A和旧话题B');
  const record = page.getByRole('region', { name: '旧版澄清记录', exact: true });
  await expect(record).toContainText('当时尚未回答');
  await expect(record.locator('input,textarea,button')).toHaveCount(0);
  await expect(main).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(fixture.posts).toEqual([]);
  expect(fixture.requests.some(request => request.path.includes('/clarifications/'))).toBe(false);
  await page.getByRole('button', { name: '返回当前对话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '助手', exact: true })).toBeVisible();
  await expect(main).toHaveValue('我的当前草稿');
  await expect(main).toBeEditable();
  await expect(page.locator('[data-ca-item]')).toHaveCount(1);
  await expect(page.locator('[data-ca-item]')).toContainText('前台自然回复');
  expect(fixture.posts).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
});

test('a natural foreground topic question uses the main Composer rather than a classification card', async ({ page }) => {
  const fixture = await installFixture(page, {
    items: [publication(1, '你指的是当前台账里的旅行，还是代码这个话题？')],
    hasOlder: false,
  });
  await page.goto('/modules/assistant/main');
  await expect(page.locator('[data-ca-item]')).toContainText('你指的是当前台账');
  await expect(page.locator('.ca-clarification')).toHaveCount(0);
  const main = page.getByPlaceholder('输入消息…');
  await main.fill('代码这个话题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(main).toHaveValue('');
  expect(fixture.posts.map(post => post.path)).toEqual(['/messages']);
  expect(fixture.posts[0]!.body.text).toBe('代码这个话题');
  expect(fixture.posts[0]!.body).not.toHaveProperty('replyTo');
  expect(fixture.consoleErrors).toEqual([]);
});
