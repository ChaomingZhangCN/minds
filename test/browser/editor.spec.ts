import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
async function state(page: Page) { return page.evaluate(() => (window as unknown as { __MINDS_TEST__: { documentState: { text: string; version: number }; calls: { type: string; prompt?: string; expectedText?: string; svg?: string }[] } }).__MINDS_TEST__); }
test.beforeEach(async ({ page }) => { await page.goto('/'); await expect(page.getByTestId('markdown-editor')).toBeVisible(); });
test('direct heading editing keeps styling and limited Markdown source edits', async ({ page }) => {
  const heading = page.locator('.rich-h1'); await expect(heading).toHaveText('minds 测试'); await heading.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' · 编辑');
  await expect(heading).toHaveText('minds 测试 · 编辑'); await expect.poll(async () => (await state(page)).documentState.text).toContain('# minds 测试 · 编辑'); await expect(page.locator('.minds-rendered,.modal-backdrop')).toHaveCount(0);
});
test('@ menu only fills a command; Mod+Enter opens a card without sending', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+End'); await editor.press('Enter'); await editor.pressSequentially('@writer');
  await expect(page.locator('.mention-menu')).toBeVisible(); await expect.poll(async () => (await state(page)).documentState.text).toContain('@writer'); expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
  await editor.press('Enter'); await expect(page.getByTestId('ai-card')).toHaveCount(0); await page.keyboard.insertText('测试精简'); await editor.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('ai-card')).toBeVisible(); await expect(page.getByRole('textbox', { name: 'AI 问题或改写指令' })).toHaveValue('测试精简'); expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
});
test('email and fenced literal @writer never open the mention menu', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+a'); await page.keyboard.insertText('user@example.com\n\n```text\n@writer\n```\n');
  await expect.poll(async () => (await state(page)).documentState.text).toContain('user@example.com'); await editor.press('ArrowUp'); await editor.press('End'); await expect(page.locator('.mention-menu')).toHaveCount(0); expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
});
test('floating toolbar wraps the selection and the bound rewrite requires acceptance (mock AI)', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+a'); await expect(page.getByRole('toolbar', { name: '选区格式与 AI' })).toBeVisible();
  await page.getByRole('toolbar', { name: '选区格式与 AI' }).getByRole('button', { name: 'AI 改写', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 问题或改写指令' }).fill('测试改写，不调用模型'); await page.getByRole('textbox', { name: 'AI 问题或改写指令' }).press('ControlOrMeta+Enter');
  await expect(page.locator('.proposal-diff')).toContainText('【模拟回答】'); expect((await state(page)).documentState.text).not.toContain('【模拟回答】');
  await page.getByRole('button', { name: '接受改写', exact: true }).click(); await expect.poll(async () => (await state(page)).documentState.text).toContain('【模拟回答】');
});
test('/ inserts a real Mermaid block after keyboard confirmation', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+End'); await editor.press('Enter'); await editor.pressSequentially('/mermaid'); await expect(page.locator('.slash-menu')).toBeVisible(); await editor.press('Enter');
  await expect(page.getByAltText('Mermaid 图形')).toBeVisible(); expect((await state(page)).calls.some(call => call.type === 'insertEmbed')).toBe(true);
});
test('same-content saves produce separate mock history entries', async ({ page }) => {
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '历史', exact: true }).click(); await expect(page.locator('.history-layout > ul > li')).toHaveCount(2);
});
test('wide chart respects dimensions and retains valid rendering beside invalid source', async ({ page }) => {
  await page.goto('/?diagrams'); const chart = page.locator('[data-embed-kind="charts"]'); await expect(chart.locator('.chart-canvas canvas')).toBeVisible();
  expect(await chart.locator('.chart-canvas').evaluate(node => node.getBoundingClientRect().height)).toBe(300); await expect(chart).toContainText('Stock Flink / FlexNext Native');
  await chart.getByRole('button', { name: '数据表', exact: true }).click(); await expect(chart.locator('tbody tr')).toHaveCount(21);
  await chart.getByRole('button', { name: '展开源码', exact: true }).click(); const original = await chart.getByRole('textbox', { name: 'Chart 源码', exact: true }).inputValue(); await chart.getByRole('textbox', { name: 'Chart 源码', exact: true }).fill('{invalid');
  await expect(chart.getByRole('alert').first()).toBeVisible(); await expect(chart.locator('.chart-canvas canvas')).toBeVisible(); await chart.getByRole('button', { name: '收起源码', exact: true }).click(); await chart.getByRole('button', { name: '展开源码', exact: true }).click(); await expect(chart.getByRole('textbox', { name: 'Chart 源码', exact: true })).toHaveValue('{invalid');
  await chart.getByRole('textbox', { name: 'Chart 源码', exact: true }).fill(original); await chart.getByRole('button', { name: '取消源码草稿', exact: true }).click(); await chart.getByRole('button', { name: '放大', exact: true }).click(); await expect(chart.getByRole('status', { name: '缩放比例' })).toHaveText('120%'); await chart.getByRole('button', { name: '复位', exact: true }).click();
  await page.screenshot({ path: 'test-results/minds-unified-chart.png', fullPage: true });
});
test('Mermaid retains its last SVG on invalid input and exports actual safe SVG', async ({ page }) => {
  await page.goto('/?diagrams'); const card = page.locator('[data-embed-kind="mermaid"]'); await card.scrollIntoViewIfNeeded(); await expect(card.getByAltText('Mermaid 图形')).toBeVisible();
  await card.getByRole('button', { name: '展开源码', exact: true }).click(); await card.getByRole('textbox', { name: 'Mermaid 源码', exact: true }).fill('not a valid diagram'); await expect(card.getByRole('alert')).toBeVisible(); await expect(card.getByAltText('Mermaid 图形')).toBeVisible();
  await card.getByRole('button', { name: '取消源码草稿', exact: true }).click(); await card.getByRole('button', { name: '导出 SVG', exact: true }).click(); await expect.poll(async () => (await state(page)).calls.filter(call => call.type === 'exportSvg').length).toBe(1);
  const svg = (await state(page)).calls.find(call => call.type === 'exportSvg')!.svg!; expect(svg).toContain('<svg'); expect(svg).not.toMatch(/<foreignObject|<script|https:\/\/evil/);
});
test('uses true local Excalidraw and draw.io inline engines under CSP without outbound requests', async ({ page }) => {
  const outbound: string[] = [], violations: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:517')) outbound.push(request.url()); }); page.on('console', message => { if (/violates.*Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.goto('/?diagrams'); await expect(page.locator('.chart-canvas canvas')).toBeVisible(); await expect(page.getByAltText('Mermaid 图形')).toBeVisible();
  const excal = page.locator('.diagram-preview').filter({ hasText: 'drawing.excalidraw' }); await excal.scrollIntoViewIfNeeded(); await expect(page.getByAltText('excalidraw 预览')).toBeVisible(); await excal.getByRole('button', { name: '编辑图形', exact: true }).click(); await expect(excal.locator('.excalidraw canvas').first()).toBeVisible(); await expect(page.locator('.modal-backdrop')).toHaveCount(0); await excal.getByRole('button', { name: '取消', exact: true }).click();
  const drawio = page.locator('.diagram-preview').filter({ hasText: 'drawing.drawio' }); await drawio.scrollIntoViewIfNeeded(); await expect(page.getByAltText('drawio 预览')).toBeVisible(); await drawio.getByRole('button', { name: '编辑图形', exact: true }).click(); await expect(page.frameLocator('iframe[title="draw.io editor"]').locator('.geDiagramContainer')).toBeVisible();
  await drawio.getByRole('button', { name: '导出 SVG', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '模拟 SVG 导出已接收' })).toBeVisible(); expect(outbound).toEqual([]); expect(violations).toEqual([]);
  await page.screenshot({ path: 'test-results/minds-local-graphics.png', fullPage: true });
});
