import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, ids, request } from '../tests/fixtures.ts';
import { checkEmbeddedUi } from './check-embedded-ui.mjs';
const layout = [];
async function checkCompactCards(page) {
  const heights = await page.locator('.metric').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
  if (heights.some(height => height > 104)) throw new Error(`Metrics are not compact: ${heights}`);
  const parent = await page.locator('tr:has(.root-agent)').boundingBox();
  const toggle = await page.locator('.children-control').boundingBox();
  if (!parent || !toggle || Math.abs(toggle.y - parent.y - parent.height) > 1 || toggle.height > 32) throw new Error('Child toggle must be a small row directly below the main agent');
  layout.push({ width: page.viewportSize().width, metricHeights: heights, childToggleHeight: toggle.height });
}
async function checkSessionRows(page) {
  const row = page.locator('.session').first();
  if ((await row.boundingBox()).height > 40) throw new Error('Normal session rows must stay compact');
  const parts = await Promise.all(['.session-name', '.session-project', '.session-tokens', '.session-row > svg'].map(s => row.locator(s).boundingBox()));
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].x < parts[i - 1].x + parts[i - 1].width - 1 || Math.abs(parts[i].y + parts[i].height / 2 - parts[0].y - parts[0].height / 2) > 4) throw new Error('Session title, project, Token and arrow must appear on one line in that order');
  }
  layout.push({ width: page.viewportSize().width, sessionRowHeight: (await row.boundingBox()).height });
  if (await page.locator('.session-row').evaluateAll(nodes => nodes.some(n => n.scrollWidth > n.clientWidth))) throw new Error('Long session titles or project names must not displace Token values');
}
const source = await fixture();
const fixtureDb = new DatabaseSync(resolve(source.codexHome, 'state_5.sqlite'));
try { fixtureDb.prepare('UPDATE threads SET name=?,title=?,cwd=? WHERE id=?').run('用于核验窄面板显示的超长会话标题与项目名称', '用于核验窄面板显示的超长会话标题与项目名称', 'D:/fixtures/project-with-a-long-name', ids.legacy); }
finally { fixtureDb.close(); }
await appendFile(source.files.import, request(ids.import, 'billion-request', 'missing-model-context', 1750000000, 1700000000, 1000000));
const runDir = resolve('.cache', `ui-check-${Date.now()}`);
await mkdir(runDir, { recursive: true });
const child = spawn(process.execPath, [resolve('plugin/dist/server.mjs'), '--web'], { cwd: runDir, windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_HOME: source.codexHome, CTI_DATA_DIR: source.dataDir } });
let browser;
try {
  let state;
  for (let i = 0; i < 50; i++) { try { state = JSON.parse(await readFile(resolve(runDir, '.cache/preview.json'), 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!state) throw new Error('Local preview did not start');
  browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const page = await browserContext.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(state.url + '&thread_id=' + ids.main); await expect(page.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
  await expect(page.getByRole('button', { name: '本会话', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
  await expect(page.locator('.metric').nth(0)).toContainText('6.00M');
  await page.getByRole('switch', { name: '包含子代理' }).uncheck(); await expect(page.locator('.metric').nth(0)).toContainText('2.40M');
  await expect(page.locator('tbody tr:not(.children-control)')).toHaveCount(1);
  await page.getByRole('switch', { name: '包含子代理' }).check(); await expect(page.locator('tbody tr:not(.children-control)')).toHaveCount(1);
  await page.getByRole('button', { name: '展开子代理（3）' }).click(); await expect(page.locator('tbody tr:not(.children-control)')).toHaveCount(4);
  await page.getByRole('button', { name: '收起子代理（3）' }).click(); await expect(page.locator('tbody tr:not(.children-control)')).toHaveCount(1);
  await expect(page.locator('.metric').nth(0)).toContainText('6.00M');
  await page.getByRole('button', { name: '展开子代理（3）' }).click();
  await page.getByRole('tab', { name: '按模型' }).click(); await expect(page.locator('tbody tr:not(.children-control)')).toHaveCount(4);
  await page.getByRole('tab', { name: '代理明细' }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '收起子代理（3）' })).toHaveAttribute('aria-expanded', 'true');
  await checkCompactCards(page);
  await mkdir('docs/screenshots', { recursive: true }); await page.screenshot({ path: 'docs/screenshots/p1-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '全部会话', exact: true }).click();
  await expect(page.locator('.session').first()).toBeVisible();
  await checkSessionRows(page);
  await page.screenshot({ path: 'docs/screenshots/v026-list-1440.png', fullPage: true });
  await page.getByRole('button').filter({ hasText: '历史数据导入' }).click(); await expect(page.locator('.coverage')).toContainText('2 个子代理在本机未找到日志');
  await expect(page.locator('.coverage')).toContainText('1 次请求缺少可核对的模型上下文');
  await expect(page.locator('.metric').nth(0)).toContainText('1.75B');
  await expect(page.locator('.metric').nth(0).locator('strong')).toHaveAttribute('title', '1,750,740,000 Token');
  await expect(page.getByRole('button', { name: '展开子代理（2）' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('textbox', { name: '搜索会话' }).fill('no match'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByText('没有匹配的会话')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索会话' }).fill(''); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(state.url + '&thread_id=' + ids.import); await expect(other.getByRole('heading', { name: '历史数据导入' })).toBeVisible();
  await page.getByRole('button', { name: '本会话', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Token 插件开发' })).toBeVisible();
  await expect(other.getByRole('heading', { name: '历史数据导入' })).toBeVisible(); await other.close();
  for (const text of ['本机真实数据', '本地日志只读统计', '已自动关联当前会话', '有用量记录的请求', '上海时间']) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
  await expect(page.locator('.refresh-control time')).toContainText('GMT+8');
  const buttonBox = await page.getByRole('button', { name: '刷新', exact: true }).boundingBox();
  const timeBox = await page.locator('.updated-at').boundingBox();
  if (timeBox.y < buttonBox.y + buttonBox.height) throw new Error('Update time must be below refresh');
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('switch', { name: '包含子代理' })).toBeVisible();
    await checkCompactCards(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error(`Page overflows at width ${width}`);
    await page.screenshot({ path: `docs/screenshots/p1-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '全部会话', exact: true }).click();
    await expect(page.locator('.session').nth(1)).toBeAttached();
    await checkSessionRows(page);
    await expect(page.locator('.list')).toHaveCSS('flex-direction', 'column');
    const boxes = await page.locator('.session').evaluateAll(nodes => nodes.slice(0, 2).map(n => { const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,height:r.height}; }));
    if (boxes[0].x !== boxes[1].x || boxes[1].y < boxes[0].y + boxes[0].height) throw new Error('Sessions must stack vertically');
    if (await page.locator('.list').evaluate(n => n.scrollWidth > n.clientWidth)) throw new Error('Session list must not scroll horizontally');
    await page.getByRole('button').filter({ hasText: '历史数据导入' }).click();
    await page.locator('.coverage summary').click();
    await page.screenshot({ path: `docs/screenshots/v026-list-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '本会话', exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'docs/screenshots/p1-dark.png', fullPage: true });
  await checkEmbeddedUi(browser, errors);
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile('docs/screenshots/p1-ui-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), version: '0.2.7', passed: true, source: 'synthetic JSONL fixtures through the real index; embedded UI uses a simulated MCP host', sizes: [1440, 768, 375], layout, checks: ['compact session rows', 'title-project-Token-arrow order', 'long names without overflow', 'compact metric cards', 'child toggle below main agent', 'current binding', 'reload binding', 'parallel tab isolation', 'child scope', 'mixed models', 'refresh', 'incomplete coverage', 'search', 'empty state', 'responsive overflow', 'embedded explicit binding after browse/search', 'embedded auto refresh', 'unknown snapshot display', 'host binding priority', 'conflicting host IDs', 'compact transcript entry without polling', 'no resize notifications', 'private app data', 'host light/dark colors', 'removed explanatory copy', 'GMT+8 below refresh'], pageErrors: errors }, null, 2));
  console.log('UI checks passed: compact rows/cards, child toggle placement, scope, models, refresh, search, and three viewport sizes');
} finally { await browser?.close(); child.kill(); }
