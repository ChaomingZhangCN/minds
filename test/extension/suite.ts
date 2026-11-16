import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DocumentSession } from '../../src/editor/DocumentSession';
import { normalizeText, smallestChange } from '../../src/shared/text';
async function eventually(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.ok(check(), '原生文档状态未在 5 秒内满足断言'); }
export async function run(): Promise<void> {
  const root = process.env.MINDS_TEST_ROOT!;
  const directory = await fs.mkdtemp(path.join(root, 'examples', '.native-test-'));
  const file = path.join(directory, 'native.md');
  const settings = vscode.workspace.getConfiguration('minds'); const oldEnabled = settings.inspect('history.enabled')?.globalValue;
  await settings.update('history.enabled', false, vscode.ConfigurationTarget.Global);
  try {
    await fs.writeFile(file, '# 标题\r\n\r\n你好😀 world\r\n');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file)); await vscode.window.showTextDocument(document);
    const origins: (string | undefined)[] = []; const session = new DocumentSession(document, origin => origins.push(origin));
    const old = normalizeText(document.getText()), next = old.replace('world', '世界');
    await session.apply('native-change', document.version, smallestChange(old, next));
    assert.equal(document.getText(), '# 标题\r\n\r\n你好😀 世界\r\n'); assert.ok(origins.includes('native-change'));
    await vscode.commands.executeCommand('undo'); await eventually(() => normalizeText(document.getText()) === old);
    await vscode.commands.executeCommand('redo'); await eventually(() => normalizeText(document.getText()) === next);
    await assert.rejects(session.apply('stale', document.version - 1, smallestChange(next, 'bad')), /版本/);
    const extension = vscode.extensions.getExtension('minds-local.minds'); assert.ok(extension); await extension.activate();
    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'minds.markdown');
    const beforeCustom = normalizeText(document.getText()), afterCustom = beforeCustom + '\n原生 custom editor 撤销测试。\n';
    await session.apply('custom-native-change', document.version, smallestChange(beforeCustom, afterCustom));
    await vscode.commands.executeCommand('undo'); await eventually(() => normalizeText(document.getText()) === beforeCustom);
    await vscode.commands.executeCommand('redo'); await eventually(() => normalizeText(document.getText()) === afterCustom);
    assert.ok(await document.save()); assert.equal(await fs.readFile(file, 'utf8'), document.getText());
    session.dispose(); console.log('PASS: 真实 TextDocument、CRLF/Unicode、WorkspaceEdit、源码与 Custom Editor 原生 undo/redo、保存。中文 IME 和多面板输入仍需手动验收。');
  } finally {
    await settings.update('history.enabled', oldEnabled, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await fs.rm(directory, { recursive: true, force: true });
  }
}
