import { expect } from '@playwright/test';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, ids, line, request } from '../tests/fixtures.ts';
import { UsageService } from '../src/service.ts';
import { panelResult } from '../src/tool-result.ts';

// Exercise the actual bundled iframe and MCP Apps transport with a controlled host.
export async function checkEmbeddedUi(browser, errors, capture) {
  await using source = await fixture();
  await writeFile(source.files.fork, line('session_meta', { id: ids.fork, forked_from_id: ids.main })
    + line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const service = new UsageService(source);
  const calls = [];
  let meta;
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.exposeFunction('queryEmbeddedFixture', async input => { calls.push(input); return panelResult(await service.query(input, meta, true)); });
    const initial = panelResult(await service.query({ sessionId: ids.main }, undefined, true));
    const html = await readFile('plugin/dist/dashboard.html', 'utf8');
    await page.goto('about:blank');
    await page.evaluate(({ initial, html }) => {
      window.hostMessages = [];
      window.addEventListener('message', async event => {
        const message = event.data;
        window.hostMessages.push(message?.method);
        if (message?.method === 'ui/initialize') {
          event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: message.params.protocolVersion, hostInfo: { name: 'regression-host', version: '1' },
            hostCapabilities: {}, hostContext: { theme: 'light', displayMode: 'fullscreen', styles: { variables: { '--color-background-primary': '#ffffff', '--color-text-primary': '#202020', '--color-background-secondary': '#f9f9f9' } } },
          } }, '*');
        } else if (message?.method === 'ui/notifications/initialized') {
          event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: initial }, '*');
        } else if (message?.method === 'tools/call') {
          if (message.params.name !== 'get_dashboard_view') throw new Error('UI must use its app-only data tool');
          const result = await window.queryEmbeddedFixture(message.params.arguments);
          event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
        } else if (message?.method === 'ui/request-display-mode') {
          event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: { mode: 'fullscreen' } }, '*');
          event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } }, '*');
        }
      });
      const iframe = document.createElement('iframe');
      iframe.style = 'width:1300px;height:940px'; iframe.srcdoc = html; document.body.append(iframe);
    }, { initial, html });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
    // Wait for the bridge to finish connecting, not just its initial notification.
    await expect.poll(() => calls.length, { timeout: 10000 }).toBeGreaterThan(0);
    await frame.getByRole('checkbox', { name: '自动刷新' }).uncheck();
    await frame.getByRole('button', { name: '全部会话', exact: true }).click();
    await expect(frame.locator('.session-name').first()).toHaveText('Token 插件开发');
    const beforeOrder = await frame.locator('.session-name').allTextContents();
    const catalog = new DatabaseSync(join(source.codexHome, 'state_5.sqlite'));
    try { catalog.prepare('UPDATE threads SET updated_at=999 WHERE id=?').run(ids.import); } finally { catalog.close(); }
    await appendFile(source.files.main, request(ids.main, 'live-update', 'turn-b', 100, 80, 10));
    const beforePoll = calls.length;
    await frame.getByRole('checkbox', { name: '自动刷新' }).check();
    await expect.poll(() => calls.length, { timeout: 10000 }).toBeGreaterThan(beforePoll);
    await expect(frame.locator('.session').filter({ hasText: 'Token 插件开发' }).locator('.session-tokens')).toHaveAttribute('title', '6,200,110 Token');
    await frame.getByRole('checkbox', { name: '自动刷新' }).uncheck();
    expect(await frame.locator('.session-name').allTextContents()).toEqual(beforeOrder);
    await expect(frame.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
    const lock = new DatabaseSync(join(source.dataDir, 'usage-v1.sqlite'));
    try {
      lock.prepare("UPDATE lease SET owner='other-panel',until_ms=?").run(Date.now() + 60_000);
      await frame.getByRole('button', { name: '刷新', exact: true }).click();
      await expect(frame.getByRole('status')).toHaveText('仍在索引，完成后可再次刷新。', { timeout: 10_000 });
      expect(await frame.locator('.session-name').allTextContents()).toEqual(beforeOrder);
      await capture(frame.locator('.app'), 'refresh-pending.png');
    } finally { lock.exec("UPDATE lease SET owner=NULL,until_ms=0 WHERE owner='other-panel'"); lock.close(); }
    await frame.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(frame.locator('.session-name').first()).toHaveText('历史数据导入');
    await expect(frame.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
    await frame.getByRole('button', { name: '本会话', exact: true }).click();
    await frame.getByRole('button', { name: '全部会话', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
    await frame.getByRole('button').filter({ hasText: '历史数据导入' }).click();
    await expect(frame.getByRole('heading', { name: '历史数据导入' })).toBeVisible();
    await frame.getByRole('textbox', { name: '搜索会话' }).fill('no match');
    await frame.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(frame.getByText('没有匹配的会话')).toBeVisible();
    await frame.getByRole('button', { name: '本会话', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
    await expect(frame.locator('.metric').nth(0)).toContainText('6.00M');
    await frame.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(frame.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    if (calls.at(-1).sessionId !== ids.main) throw new Error('Explicit current-thread binding was lost');
    await frame.getByRole('switch', { name: '包含子代理' }).uncheck();
    await expect(frame.locator('.metric').nth(0)).toContainText('2.40M');
    await frame.getByRole('switch', { name: '包含子代理' }).check();
    await expect(frame.locator('tbody tr:not(.children-control)')).toHaveCount(1);
    await frame.getByRole('button', { name: '展开子代理（3）' }).click();
    await expect(frame.locator('tbody tr:not(.children-control)')).toHaveCount(4);

    await frame.getByRole('button', { name: '全部会话', exact: true }).click();
    const fork = frame.getByRole('button').filter({ hasText: '继承历史的分叉' });
    await expect(fork.locator('.session-tokens')).toHaveText('—');
    await fork.click();
    await expect(frame.getByRole('heading', { name: '继承历史的分叉' })).toBeVisible();
    await expect(frame.locator('.summary > strong')).toHaveText('—');
    await expect(frame.locator('.cache-track')).toHaveCount(0);
    await expect(frame.locator('.metric').nth(0).locator('strong')).toHaveText('—');
    await expect(frame.locator('.metric').nth(1).locator('strong')).toHaveText('—');
    await expect(frame.locator('.cache-legend b')).toHaveText(['—', '—', '—']);
    await expect(frame.locator('tbody .warning-badge')).toHaveText('用量未知');
    await frame.locator('.coverage summary').click();
    await expect(frame.locator('.coverage')).toContainText('无法确认本线程用量');
    await capture(frame.locator('.app'), 'p1-unknown-snapshot.png');

    // Host colors must win even when switching from light to dark at runtime.
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {
      theme: 'dark', styles: { variables: { '--color-background-primary': '#181818', '--color-text-primary': '#efefef', '--color-background-secondary': '#202020' } },
    } }, '*'));
    await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
    await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(239, 239, 239)');
    await capture(frame.locator('.app'), 'p1-host-dark.png');

    // History mounts stay compact and never publish viewport-dependent resize events.
    await frame.getByRole('checkbox', { name: '自动刷新' }).check();
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline' } }, '*'));
    await expect(frame.getByRole('button', { name: '打开 Token 用量' })).toBeVisible();
    await expect(frame.locator('.app')).toHaveCount(0);
    const inlineCalls = calls.length;
    await page.waitForTimeout(5500);
    if (calls.length !== inlineCalls) throw new Error('History entry kept polling');
    await frame.getByRole('button', { name: '打开 Token 用量' }).click();
    await expect(frame.locator('.app')).toBeVisible();
    await frame.getByRole('checkbox', { name: '自动刷新' }).uncheck();
    if ((await page.evaluate(() => window.hostMessages)).includes('ui/notifications/size-changed')) throw new Error('Fullscreen panel emitted resize notifications');

    // A new host ID always outranks the saved explicit fallback; conflicts stay unbound.
    meta = { threadId: ids.import };
    await frame.getByRole('button', { name: '本会话', exact: true }).click();
    await expect(frame.getByRole('heading', { name: '历史数据导入' })).toBeVisible();
    meta = { threadId: ids.main, 'x-codex-turn-metadata': { thread_id: ids.import } };
    await frame.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(frame.locator('h2')).toHaveCount(0);
    await expect(frame.getByText('会话标识冲突，请重新打开面板。')).toBeVisible();
  } finally { try { await page.close(); } finally { await service.close(); } }
}
