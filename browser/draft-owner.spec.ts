import { expect, test, type Page } from '@playwright/test';
import { installFixture, json, publication } from './fixtures.ts';

async function open(page: Page) {
  if (!new URL(page.url()).pathname.startsWith('/modules/assistant/')) {
    await page.getByRole('button', { name: '全局菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '助手', exact: true }).click();
  }
  await expect(page.getByRole('region', { name: '对话记录', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.ca-page').getByTestId('synthetic-enhancers')).toBeVisible();
}
const editor = (page: Page) => page.locator('.ca-page')
  .getByRole('textbox', { name: '消息输入', exact: true });
const send = (page: Page) => page.locator('.ca-page').getByRole('button', { name: '发送', exact: true });
async function close(page: Page) {
  await page.getByRole('link', { name: '返回 Cockpit', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.ca-page')).toHaveCount(0);
}
async function pendingRecovery(page: Page) {
  await expect(page.getByText(/暂时无法确认发送状态/)).toBeVisible();
  await expect(page.getByRole('button', { name: '发送回执', exact: true })).toHaveCount(0);
}
function clean(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.consoleErrors).toEqual([]);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.posts.every(post => post.path === '/messages')).toBe(true);
  expect(fixture.posts.every(post => !Object.hasOwn(post.body, 'replyTo'))).toBe(true);
}

for (const selected of [false, true]) {
  test(`real shared Composer accepts attachment-only and captured speech (${selected ? 'background Chat' : 'homepage'})`, async ({ page }) => {
    const attachment = { type: 'file' as const, path: '/synthetic/history.txt', displayName: 'history.txt' };
    const fixture = await installFixture(page, {
      items: [publication(1, '', { attachments: [attachment], sessionId: null, speaker: 'user' })], hasOlder: false,
    });
    await page.goto('/?probes=1');
    if (selected) {
      await page.getByRole('button', { name: '选择合成会话' }).click();
      await page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入' }).fill('independent Chat draft');
      await expect(page.getByTestId('selected-session').getByTestId('synthetic-enhancers')).toHaveAttribute('data-native', 'true');
    }
    await open(page);
    await expect(page.getByTestId('selected-session')).toHaveCount(0);
    await expect(page.locator('.ca-page').getByTestId('synthetic-enhancers'))
      .toHaveAttribute('data-selected-session', '');
    await expect(page.locator('.ca-page').getByTestId('synthetic-enhancers')).toHaveAttribute('data-native', 'false');
    await expect(page.locator('[data-ca-item]').getByText('history.txt')).toBeVisible();
    const events = await page.evaluate(() => window.assistantProbe.events);
    expect(events.some(event => event.boundary === 'message'
      && JSON.stringify(event.identity) === JSON.stringify({ owner: 'assistant', id: 'message:message-1', kind: 'message', role: 'user' }))).toBe(true);
    expect(events.some(event => event.boundary === 'attachment'
      && JSON.stringify(event.attachment) === JSON.stringify(attachment))).toBe(true);
    expect(events.every(event => event.origin === undefined)).toBe(true);
    await page.locator('.ca-page').getByRole('button', { name: '合成文件探针' }).click();
    await expect(editor(page)).toHaveValue('');
    await expect(send(page)).toBeEnabled();
    await send(page).click();
    await expect(page.locator('.ca-page').getByTestId('synthetic-files')).toHaveText('');
    expect(fixture.posts[0]?.body).toMatchObject({ text: '', attachments: [
      { type: 'file', path: '/synthetic/fixture.txt', displayName: 'fixture.txt' },
    ] });
    await page.locator('.ca-page').getByRole('button', { name: '合成语音捕获' }).click();
    await page.locator('.ca-page').getByRole('button', { name: '合成语音发送' }).click();
    await expect(editor(page)).toHaveValue('');
    expect(fixture.posts).toHaveLength(2);
    expect(fixture.posts[1]?.body.text).toBe('合成语音文本');
    await close(page);
    if (selected) {
      await page.getByRole('button', { name: '选择合成会话' }).click();
      await expect(page.getByTestId('selected-session').getByRole('textbox', { name: '消息输入' })).toHaveValue('independent Chat draft');
    }
    expect(await page.evaluate(() => window.fixtureNativeSends)).toBe(0);
    clean(fixture);
  });
}

test('late receipt ACK only removes captured file/text, preserving concurrent edits across close/reopen', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, { items: [publication(1, 'old'), publication(2, 'new')], hasOlder: false,
    post: async (_post, route) => { await gate; await json(route, { accepted: true }); return true; },
  });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).fill('captured');
  await page.evaluate(() => window.assistantProbe.add('old.txt'));
  await send(page).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  await close(page);
  await page.evaluate(() => window.assistantProbe.add('new.txt'));
  await open(page);
  await editor(page).fill('new text');
  release();
  await expect(page.getByTestId('synthetic-files')).toHaveText('new.txt');
  await expect(editor(page)).toHaveValue('new text');
  await expect(page.getByRole('region', { name: '当前回复引用' })).toHaveCount(0);
  expect(fixture.posts[0]?.body).toMatchObject({ text: 'captured',
    attachments: [{ type: 'file', path: '/synthetic/old.txt', displayName: 'old.txt' }] });
  clean(fixture);
});

test('unknown input restores after page refresh and automatically settles without reposting', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    post: async (_post, route) => { await route.abort('failed'); return true; },
  });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).fill('uncertain');
  await page.evaluate(() => window.assistantProbe.add('persisted.txt'));
  await send(page).click();
  await pendingRecovery(page);
  const requestId = fixture.posts[0]?.body.requestId;
  await close(page); await open(page);
  await expect(send(page)).toBeDisabled();
  await page.reload(); await open(page);
  await pendingRecovery(page);
  await expect(editor(page)).toHaveValue('uncertain');
  await expect(page.getByTestId('synthetic-files')).toHaveText('persisted.txt');
  await expect(send(page)).toBeDisabled();
  await expect(editor(page)).toHaveValue('');
  await expect(page.getByTestId('synthetic-files')).toHaveText('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.some(request => request.path === `/inputs/${String(requestId)}`)).toBe(true);
  clean(fixture);
});

test('field ACK failure retains its file and reconciliation retries ACK, never transport', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await page.goto('/?probes=1'); await open(page);
  await page.evaluate(() => { window.assistantProbe.add('retain.txt'); window.assistantProbe.failAck = true; });
  await send(page).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.assistantProbe.snapshot().unconfirmed)).toBe(true);
  await expect(page.getByTestId('synthetic-files')).toHaveText('retain.txt');
  await page.evaluate(() => { window.assistantProbe.failAck = false; });
  await expect(page.getByTestId('synthetic-files')).toHaveText('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.consoleErrors.length).toBeGreaterThan(0);
  expect(fixture.consoleErrors.every(error => error.includes('Synthetic file ACK failure'))).toBe(true);
});

test('historical flat unknown transaction is reconciled by GET with its frozen input, never replayed', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    post: async (_post, route) => { await route.abort('failed'); return true; },
  });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).fill('历史未确认输入');
  await page.evaluate(() => window.assistantProbe.add('legacy.txt'));
  await send(page).click();
  await pendingRecovery(page);
  const requestId = String(fixture.posts[0]!.body.requestId);
  await close(page);
  await page.evaluate(() => window.stopFixture());
  const changed = await page.evaluate(requestId => {
    let changed = 0;
    for (const key of Object.keys(sessionStorage)) {
      const raw = sessionStorage.getItem(key)!;
      let root: Record<string, unknown>;
      try { root = JSON.parse(raw); } catch { continue; }
      for (const value of Object.values(root)) {
        if (!value || typeof value !== 'object' || !('transaction' in value)) continue;
        const transaction = (value as { transaction?: { request?: { version?: number; payload?: Record<string, unknown> } } }).transaction;
        if (transaction?.request?.payload?.requestId !== requestId) continue;
        transaction.request.version = 1;
        sessionStorage.setItem(key, JSON.stringify(root));
        changed++;
      }
    }
    return changed;
  }, requestId);
  expect(changed).toBe(1);
  await page.reload(); await open(page);
  await pendingRecovery(page);
  await expect(send(page)).toBeDisabled();
  await expect(editor(page)).toHaveValue('');
  await expect(page.getByTestId('synthetic-files')).toHaveText('');
  await expect(page.getByText(/暂时无法确认发送状态/)).toHaveCount(0);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.requests.filter(request => request.path === `/inputs/${requestId}`).length).toBeGreaterThan(0);
  clean(fixture);
});

test('legacy selected reply business state migrates without attaching an anchor to new input', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).fill('旧版已选回复下保留的草稿');
  await close(page);
  await page.evaluate(() => window.stopFixture());
  const legacyReply = publication(1, '旧版被选中的问题', {
    type: 'question',
    question: { state: 'pending', stateVersion: 1, choices: ['旧选项'], allowFreeform: false },
  });
  const changed = await page.evaluate(reply => {
    let changed = 0;
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith('cockpit:module-draft:')) continue;
      const root = JSON.parse(sessionStorage.getItem(key)!);
      const schemas = root.__cockpitDraft?.schemas ?? {};
      for (const [namespace, encoded] of Object.entries(schemas)) {
        if (typeof encoded !== 'string') continue;
        const value = JSON.parse(encoded);
        if (value.version !== 2 || !Array.isArray(value.submissions)) continue;
        schemas[namespace] = JSON.stringify({ version: 1, actionRevision: value.actionRevision,
          reply, submissions: value.submissions });
        changed++;
      }
      sessionStorage.setItem(key, JSON.stringify(root));
    }
    return changed;
  }, legacyReply);
  expect(changed).toBe(1);
  await page.reload(); await open(page);
  await expect(editor(page)).toHaveValue('旧版已选回复下保留的草稿');
  await expect(editor(page)).toBeEditable();
  await expect(page.getByRole('region', { name: '当前回复引用' })).toHaveCount(0);
  await expect(page.getByText('legacy-selected-anchor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送选项' })).toHaveCount(0);
  await editor(page).fill('与旧问题无关的普通新输入');
  await send(page).click();
  await expect(editor(page)).toHaveValue('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]?.body.text).toBe('与旧问题无关的普通新输入');
  expect(fixture.posts[0]?.body).not.toHaveProperty('replyTo');
  const saved = await page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('cockpit:module-draft:'))
    .flatMap(key => Object.values(JSON.parse(sessionStorage.getItem(key)!).__cockpitDraft?.schemas ?? {}))
    .filter((value): value is string => typeof value === 'string')
    .map(value => JSON.parse(value))
    .find(value => Array.isArray(value.submissions)));
  expect(saved.version).toBe(2);
  expect(saved).not.toHaveProperty('reply');
  clean(fixture);
});

test('restored unknown ACK preserves newly edited text and attachment identities', async ({ page }) => {
  const fixture = await installFixture(page, { items: [publication(1, 'original'), publication(2, 'new reply')], hasOlder: false,
    post: async (_post, route) => { await route.abort('failed'); return true; },
  });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).fill('original text');
  await page.evaluate(() => window.assistantProbe.add('original.txt'));
  await send(page).click();
  await pendingRecovery(page);
  await page.reload(); await open(page);
  await editor(page).fill('edited after restoration');
  await page.evaluate(() => window.assistantProbe.add('new.txt'));
  const newItem = await page.evaluate(() => window.assistantProbe.snapshot().items.at(-1));
  await expect(page.getByTestId('synthetic-files')).toHaveText('new.txt');
  await expect(editor(page)).toHaveValue('edited after restoration');
  expect(await page.evaluate(() => window.assistantProbe.snapshot().items)).toEqual([newItem]);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: 'original text',
    attachments: [{ type: 'file', path: '/synthetic/original.txt', displayName: 'original.txt' }] });
  clean(fixture);
});

test('pending receipt lookup survives reload; all native descriptor shapes are captured immutably', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const fixture = await installFixture(page, { items: [], hasOlder: false,
    read: async (url, route) => {
      if (!url.pathname.includes('/inputs/') || !first) return false;
      first = false;
      await gate;
      await route.abort('failed');
      return true;
    },
  });
  await page.goto('/?probes=1'); await open(page);
  const attachments = await page.evaluate(() => {
    const descriptors = [
      { type: 'directory' as const, path: '/synthetic/tree', displayName: 'tree' },
      { type: 'selection' as const, filePath: '/synthetic/source.ts', displayName: 'selection',
        selection: { start: { line: 0, character: 1 }, end: { line: 2, character: 3 } }, text: 'selected bytes' },
      { type: 'blob' as const, data: 'aGVsbG8=', mimeType: 'text/plain', displayName: 'blob' },
    ];
    for (const descriptor of descriptors) window.assistantProbe.addDescriptor(descriptor);
    const saved = structuredClone(descriptors);
    descriptors[0]!.displayName = 'mutated caller object';
    return saved;
  });
  await send(page).click();
  await expect.poll(() => fixture.requests.filter(request => request.path.startsWith('/inputs/')).length).toBe(1);
  expect(fixture.posts[0]?.body.attachments).toEqual(attachments);
  await page.reload();
  release();
  await open(page);
  await pendingRecovery(page);
  await expect(page.getByTestId('synthetic-files')).toHaveText('tree, selection, blob');
  await expect(send(page)).toBeDisabled();
  await expect(page.getByTestId('synthetic-files')).toHaveText('');
  expect(fixture.posts).toHaveLength(1);
  clean(fixture);
});

test('schema generation revocation denies old scope and rehydrates persisted items', async ({ page }) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await page.goto('/?probes=1'); await open(page);
  await page.evaluate(() => window.assistantProbe.add('generation.txt'));
  await close(page);
  const revoked = await page.evaluate(async () => {
    const stale = window.assistantProbe.revokedUpdate!;
    await window.restartFixture();
    try { stale(); return false; } catch { return true; }
  });
  expect(revoked).toBe(true);
  await open(page);
  await expect(page.getByTestId('synthetic-files')).toHaveText('generation.txt');
  await send(page).click();
  await expect(page.getByTestId('synthetic-files')).toHaveText('');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.seenUnexpected).toEqual([]);
  expect(fixture.consoleErrors.every(error => error.includes('Draft schema generation has stopped'))).toBe(true);
});

test('captured speech consent is invalidated by closing, even after reopening', async ({ page }) => {
  const fixture = await installFixture(page, { items: [publication(1, 'reply target')], hasOlder: false });
  await page.goto('/?probes=1'); await open(page);
  await page.getByRole('button', { name: '合成语音捕获' }).click();
  await close(page); await open(page);
  expect(await page.evaluate(() => window.assistantProbe.sendCaptured())).toMatchObject({ status: 'blocked' });
  expect(fixture.posts).toHaveLength(0);
  clean(fixture);
});

test('choice-only historical asks do not bind the owner or forbid ordinary text and attachments', async ({ page }) => {
  const fixture = await installFixture(page, { hasOlder: false, items: [publication(1, 'choose', {
    type: 'question', question: { state: 'pending', stateVersion: 1, allowFreeform: false, choices: ['yes', 'no'] },
  })] });
  await page.goto('/?probes=1'); await open(page);
  await page.evaluate(() => window.assistantProbe.add('not-an-answer.txt'));
  await expect(page.getByRole('button', { name: '合成文件探针' })).toBeEnabled();
  await expect(editor(page)).toHaveCount(1);
  await page.evaluate(() => window.assistantProbe.edit('freeform'));
  await expect(send(page)).toBeEnabled();
  await expect(page.getByRole('listitem')).toHaveText(['yes', 'no']);
  await expect(page.getByRole('button', { name: 'yes', exact: true })).toHaveCount(0);
  await editor(page).fill('yes');
  await page.evaluate(() => window.assistantProbe.capture());
  await expect(editor(page)).toHaveValue('yes');
  await page.evaluate(() => window.assistantProbe.sendCaptured());
  await expect.poll(() => fixture.posts.length).toBe(1);
  expect(fixture.posts[0]?.body).toMatchObject({ text: 'yes', attachments: [
    { type: 'file', path: '/synthetic/not-an-answer.txt', displayName: 'not-an-answer.txt' },
  ] });
  clean(fixture);
});

test('real Composer preserves IME composition and focus on the routed page', async ({ page }, info) => {
  const fixture = await installFixture(page, { items: [], hasOlder: false });
  await page.goto('/?probes=1'); await open(page);
  await editor(page).focus();
  await editor(page).fill('组合输入');
  await editor(page).dispatchEvent('compositionstart', { data: '' });
  await editor(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect(fixture.posts).toHaveLength(0);
  await editor(page).dispatchEvent('compositionend', { data: '组合输入' });
  await expect(editor(page)).toBeFocused();
  await editor(page).press('Enter');
  if (info.project.name.startsWith('mobile')) {
    expect(fixture.posts).toHaveLength(0);
    await expect(editor(page)).toHaveValue('组合输入\n');
    await send(page).click();
  }
  await expect(editor(page)).toHaveValue('');
  expect(fixture.posts).toHaveLength(1);
  await close(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  clean(fixture);
});
