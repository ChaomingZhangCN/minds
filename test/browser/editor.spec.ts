import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
async function state(page: Page) { return page.evaluate(() => (window as unknown as { __MINDS_TEST__: { documentState: { text: string; version: number }; calls: { type: string }[] } }).__MINDS_TEST__); }
test.beforeEach(async ({ page }) => { await page.goto('/'); await expect(page.getByTestId('markdown-editor')).toBeVisible(); });
test('typing @writer does not remove text or invoke AI until explicitly selected', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+End'); await editor.press('Enter'); await editor.pressSequentially('@writer');
  await expect(page.locator('.mention-menu')).toBeVisible(); await expect.poll(async () => (await state(page)).documentState.text).toContain('@writer');
  expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
  await page.getByRole('button', { name: '@writer · 改写', exact: true }).click(); await expect(page.getByTestId('ai-card')).toBeVisible();
  expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
});
test('email and fenced literal @writer never open the mention menu', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+a'); await page.keyboard.insertText('user@example.com\n\n```text\n@writer\n```\n');
  await expect.poll(async () => (await state(page)).documentState.text).toContain('user@example.com');
  await editor.press('ArrowUp'); await editor.press('End'); await expect(page.locator('.mention-menu')).toHaveCount(0); expect((await state(page)).calls.filter(call => call.type === 'aiStart')).toHaveLength(0);
});
test('bound rewrite shows a diff and requires acceptance (mock AI)', async ({ page }) => {
  const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+a'); await page.getByRole('button', { name: '@ 改写', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI 问题或改写指令' }).fill('测试改写，不调用模型'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.proposal-diff')).toContainText('【模拟回答】'); expect((await state(page)).documentState.text).not.toContain('【模拟回答】');
  await page.getByRole('button', { name: '接受改写', exact: true }).click(); await expect.poll(async () => (await state(page)).documentState.text).toContain('【模拟回答】');
});
test('same-content saves produce separate mock history entries', async ({ page }) => {
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('.history-layout > ul > li')).toHaveCount(2);
});
test('uses true local Charts, Excalidraw and draw.io previews under CSP', async ({ page }) => {
  const outbound: string[] = []; page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:517')) outbound.push(request.url()); });
  await page.goto('/?diagrams'); await expect(page.locator('.chart-canvas canvas')).toBeVisible();
  await page.locator('.diagram-preview').filter({ hasText: 'drawing.excalidraw' }).scrollIntoViewIfNeeded(); await expect(page.getByAltText('excalidraw 预览')).toBeVisible();
  const drawio = page.locator('.diagram-preview').filter({ hasText: 'drawing.drawio' }); await drawio.scrollIntoViewIfNeeded(); await expect(page.getByAltText('drawio 预览')).toBeVisible();
  await drawio.getByRole('button', { name: '编辑图形', exact: true }).click(); await expect(page.frameLocator('iframe[title="draw.io editor"]').locator('.geDiagramContainer')).toBeVisible();
  await page.getByRole('button', { name: '导出 SVG', exact: true }).last().click(); await expect(page.getByRole('status')).toContainText('模拟 SVG 导出已接收');
  expect(outbound).toEqual([]);
  await page.screenshot({ path: 'test-results/minds-local-graphics.png', fullPage: true });
});
