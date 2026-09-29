import { expect, test, type Page } from '@playwright/test';
import { installFixture } from './fixtures.ts';
import { fixtureImage, realModules } from './real-modules.ts';

async function enter(page: Page) {
  await page.getByRole('button', { name: '全局菜单' }).click();
  await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  await expect(page.getByRole('region', { name: '对话记录' })).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: '添加文件', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '开始语音输入', exact: true })).toHaveCount(1);
}

test('genuine File rolling17 upload, paste, drop, preview and attachment-only ACK use the public owner', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  const plugins = await realModules(page);
  await page.goto('/');
  await page.getByRole('button', { name: '选择合成会话' }).click();
  await expect(page.getByRole('button', { name: '添加文件', exact: true })).toBeVisible();
  await enter(page);
  await expect(page.getByTestId('selected-session')).toHaveCount(0);
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await (await picker).setFiles(fixtureImage);
  await expect(page.getByRole('button', { name: '查看 synthetic.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看 synthetic.png', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const kind of ['paste', 'drop'] as const) {
    await page.getByRole('textbox').evaluate((editor, { kind, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], `${kind}.png`, { type: 'image/png' }));
      editor.dispatchEvent(kind === 'paste'
        ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
        : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { kind, bytes: [...fixtureImage.buffer] });
    await expect(page.getByRole('button', { name: `查看 ${kind}.png`, exact: true })).toBeVisible();
  }
  expect(plugins.uploads.map(value => value.name)).toEqual(['synthetic.png', 'paste.png', 'drop.png']);
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: '', attachments: [
    { type: 'file', displayName: 'synthetic.png' }, { type: 'file', displayName: 'paste.png' }, { type: 'file', displayName: 'drop.png' },
  ] });
  await expect(page.getByRole('region', { name: '文件附件' })).toHaveCount(0);
  expect(plugins.assets.some(path => path.endsWith('/cockpit-file/' + plugins.releases[0]!.digest + '/dist/web/index.js'))).toBe(true);
  expect(await page.evaluate(() => window.fixtureNativeSends)).toBe(0);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
});

test('genuine Speech rolling2 microphone and F8 capture only the foreground owner; route departure cancels', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  const plugins = await realModules(page);
  await page.goto('/');
  await page.getByRole('button', { name: '选择合成会话' }).click();
  await page.getByRole('textbox').fill('independent native draft');
  await enter(page);
  await page.getByRole('button', { name: '开始语音输入' }).click();
  await expect(page.getByRole('button', { name: '停止录音并收取剩余文字' })).toBeVisible();
  await page.getByRole('button', { name: '停止录音并收取剩余文字' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('真实 Speech 插件的合成语音');
  expect(fixture.posts).toHaveLength(0);
  await page.getByRole('textbox').fill('');
  await page.getByRole('heading', { name: '助手', exact: true }).click();
  await page.keyboard.down('F8');
  await expect(page.getByRole('button', { name: '停止录音并收取剩余文字' })).toBeVisible();
  await page.keyboard.up('F8');
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body.text).toBe('真实 Speech 插件的合成语音');
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('button', { name: '开始语音输入' }).click();
  await expect(page.getByRole('button', { name: '停止录音并收取剩余文字' })).toBeVisible();
  await page.getByRole('link', { name: '返回 Cockpit' }).click();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fixtureAudio.stopped)).toBe(3);
  await enter(page);
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('');
  // Interrupted capture may offer recovery, but cannot write/send into a new mount.
  await expect(page.getByRole('textbox', { name: '识别结果（未发送）' })).toHaveValue('真实 Speech 插件的合成语音');
  expect(fixture.posts).toHaveLength(1);
  expect(plugins.speechSessions.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.fixtureAudio.frames)).toContain('input_audio_buffer.commit');
  expect(await page.evaluate(() => window.fixtureNativeSends)).toBe(0);
  await page.getByRole('link', { name: '返回 Cockpit' }).click();
  await page.getByRole('button', { name: '选择合成会话' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('independent native draft');
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
});

test('genuine Speech hold gesture captures synthetic audio through real pointer/touch input', async ({ page }, info) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await realModules(page);
  await page.goto('/'); await enter(page);
  const hold = page.locator('.cockpit-speech-hold');
  await expect(hold).toBeVisible();
  const rect = (await hold.boundingBox())!;
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const cdp = info.project.name.startsWith('mobile') ? await page.context().newCDPSession(page) : undefined;
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
  else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  await expect(page.getByRole('button', { name: '停止录音并收取剩余文字' })).toBeVisible();
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body.text).toBe('真实 Speech 插件的合成语音');
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  await expect(page.getByRole('textbox', { name: '消息输入', exact: true })).toHaveValue('');
  expect(await page.evaluate(() => window.fixtureAudio.starts)).toBe(1);
  expect(await page.evaluate(() => window.fixtureAudio.stopped)).toBe(1);
  expect(await page.evaluate(() => window.fixtureNativeSends)).toBe(0);
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
  await cdp?.detach();
});
