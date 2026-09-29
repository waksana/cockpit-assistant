import { expect, test, type Page } from '@playwright/test';
import { installFixture, json, readiness } from './fixtures.ts';

async function enter(page: Page) {
  await page.getByRole('button', { name: '全局菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await expect(page.locator('.ca-page')).toBeVisible();
  await expect(page.getByRole('region', { name: '对话记录' })).toHaveAttribute('aria-busy', 'false');
}
function clean(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
}

test('production App routes own direct URL, reload, history, home return and module revocation', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await page.goto('/');
  await enter(page);
  const route = new URL(page.url()).pathname;
  expect(route).toMatch(/^\/modules\/assistant\/[a-z][a-z0-9-]*$/);
  await expect(page.getByRole('heading', { name: '助手', level: 1 })).toBeVisible();
  await expect(page.locator('dialog, [role="dialog"], :modal')).toHaveCount(0);
  await expect(page.getByTestId('empty-homepage')).toHaveCount(0);
  await page.getByRole('textbox').fill('跨路由保留的草稿');
  await page.goBack();
  await expect(page.getByTestId('empty-homepage')).toBeVisible();
  await expect(page.locator('.ca-page')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('textbox')).toHaveValue('跨路由保留的草稿');
  await page.reload();
  await expect(page.getByRole('textbox')).toHaveValue('跨路由保留的草稿');
  await page.goto(route);
  await expect(page.getByRole('textbox')).toHaveValue('跨路由保留的草稿');
  await page.getByRole('link', { name: '返回 Cockpit' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('empty-homepage')).toBeVisible();
  await enter(page);
  await page.evaluate(() => window.stopFixture());
  await expect(page.locator('.ca-page')).toHaveCount(0);
  await expect(page.getByText(/模块页面不存在或已不可用/)).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('link', { name: '返回主页' }).click();
  await expect(page.getByTestId('empty-homepage')).toBeVisible();
  await page.goto('/modules/assistant/unknown-page');
  await expect(page.getByText(/模块页面不存在或已不可用/)).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  clean(fixture);
});

test('role names and status icons are independent; checking and every nonready role remain inspectable', async ({ page }) => {
  let releaseReadiness: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let failed = false;
  let disconnected = false;
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    read: async (url, route) => {
      if (!url.pathname.endsWith('/readiness')) return false;
      if (gate) await gate;
      if (!failed) return false;
      await json(route, { error: { code: 'SYNTHETIC_READY_FAILED', message: 'Synthetic readiness failure' } }, 503);
      return true;
    },
    stream: async (_after, route) => {
      if (!disconnected) return false;
      await route.abort('failed');
      return true;
    },
  });
  await page.goto('/'); await enter(page);
  await page.getByRole('textbox').fill('发送门禁测试');
  for (const [status, label] of [
    ['unbound', '未绑定'], ['unloaded', '未加载'], ['invalid', '不可用'],
    ['unknown', '状态未知'], ['ready', '已就绪'],
  ] as const) {
    const value = readiness();
    value.roles[0]!.status = status;
    value.canSend = status === 'ready';
    fixture.setReadiness(value);
    const control = page.getByRole('button', { name: /^coordinator：/ });
    if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
    await page.getByRole('button', { name: '刷新就绪状态', exact: true }).click();
    await expect(control).toHaveAttribute('aria-label', `coordinator：${label}`);
    await expect(control).toHaveText('coordinator');
    await expect(control).toHaveAttribute('title', `coordinator：${label}`);
    await expect(page.getByRole('button', { name: 'memory：已就绪' })).toBeVisible();
    await expect(page.getByRole('button', { name: '实时连接：已连接' })).toBeVisible();
    if (status === 'ready') await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    else await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  }
  gate = new Promise<void>(resolve => { releaseReadiness = resolve; });
  await page.getByRole('button', { name: '刷新就绪状态', exact: true }).click();
  await expect(page.getByRole('button', { name: 'coordinator：检查中' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'memory：检查中' })).toBeVisible();
  await expect(page.getByRole('button', { name: '实时连接：已连接' })).toBeVisible();
  failed = true;
  releaseReadiness!();
  gate = undefined;
  await expect(page.getByRole('button', { name: 'coordinator：失败' })).toBeVisible();
  await expect(page.getByRole('region', { name: '状态详情' })).toContainText('Synthetic readiness failure');
  failed = false;
  await page.getByRole('button', { name: '刷新就绪状态', exact: true }).click();
  await expect(page.getByRole('button', { name: 'coordinator：已就绪' })).toBeVisible();
  disconnected = true;
  await page.getByRole('button', { name: '实时连接：已连接' }).click();
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '实时连接：已断开' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'coordinator：已就绪' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'memory：已就绪' })).toBeVisible();
  disconnected = false;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '实时连接：已连接' })).toBeVisible();
  expect(fixture.posts).toEqual([]);
  clean(fixture);
});

test('connecting SSE uses an accessible loader without changing role readiness', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    stream: async () => { await gate; return false; },
  });
  await page.goto('/'); await enter(page);
  const connection = page.getByRole('button', { name: '实时连接：正在连接', exact: true });
  await expect(connection).toHaveText('');
  await expect(connection).toHaveAttribute('title', '实时连接：正在连接');
  await expect(connection.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(connection.locator('path').first()).toHaveAttribute('d', 'M12 2v4');
  await expect(page.getByRole('button', { name: 'coordinator：已就绪', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'memory：已就绪', exact: true })).toBeVisible();
  await connection.click();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: '实时连接：已连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeEnabled();
  expect(fixture.posts).toEqual([]);
  clean(fixture);
});

test('public Composer styles and control geometry match the native Chat reference', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  const measure = () => page.getByRole('textbox').evaluate(input => {
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const send = document.querySelector<HTMLButtonElement>('.ck-composer button[type="submit"]')
      ?? Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === '发送');
    const sendRect = send?.getBoundingClientRect();
    const card = document.querySelector('.chat-input-card')!;
    const cardStyle = getComputedStyle(card);
    const cardRect = card.getBoundingClientRect();
    return {
      className: input.className, fontFamily: style.fontFamily, fontSize: style.fontSize,
      lineHeight: style.lineHeight, border: style.border, borderRadius: style.borderRadius,
      padding: style.padding, background: style.backgroundColor, color: style.color,
      height: rect.height, width: rect.width, sendWidth: sendRect?.width, sendHeight: sendRect?.height,
      card: { width: cardRect.width, height: cardRect.height, border: cardStyle.border,
        borderRadius: cardStyle.borderRadius, padding: cardStyle.padding, background: cardStyle.backgroundColor },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '选择合成会话' }).click();
  await page.getByRole('textbox').fill('同样的一行文本');
  await expect(page.locator('.chat-input-area')).toHaveCount(1);
  await expect(page.locator('.chat-input-card')).toHaveCount(1);
  const chat = await measure();
  await enter(page);
  await expect(page.getByTestId('selected-session')).toHaveCount(0);
  await page.getByRole('textbox').fill('同样的一行文本');
  expect(await measure()).toEqual(chat);
  await expect(page.getByRole('textbox')).toBeInViewport();
  clean(fixture);
});

test('320px wrapping header and long status detail retain a visible Composer with touch and keyboard controls', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  const status = readiness();
  status.roles[1]!.status = 'invalid';
  status.roles[1]!.detail = '合成长详情'.repeat(100) + 'x'.repeat(200);
  status.canSend = false;
  fixture.setReadiness(status);
  await page.goto('/'); await enter(page);
  const control = page.getByRole('button', { name: 'memory：不可用', exact: true });
  if (info.project.name.startsWith('mobile')) await control.tap();
  else { await control.focus(); await page.keyboard.press('Enter'); }
  await expect(page.getByRole('region', { name: '状态详情' })).toBeVisible();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('textbox')).toBeInViewport({ ratio: 1 });
  const sizes = await page.locator('.ca-page').evaluate(element => ({
    scroll: element.scrollWidth, width: element.clientWidth,
    bottom: element.getBoundingClientRect().bottom, height: innerHeight,
    controls: Array.from(element.querySelectorAll('.ca-header button, .ca-header a')).map(control => {
      const rect = control.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }),
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.bottom).toBeLessThanOrEqual(sizes.height + 1);
  for (const control of sizes.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(321);
    expect(control.width).toBeGreaterThanOrEqual(40);
    expect(control.height).toBeGreaterThanOrEqual(40);
  }
  await page.getByRole('button', { name: '刷新就绪状态' }).focus();
  await page.keyboard.press('Escape');
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: '状态详情' })).toHaveCount(0);
  await expect(page.locator('dialog, :modal')).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  clean(fixture);
});
