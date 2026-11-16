import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';
import { ProviderManager } from './providers/ProviderManager';
import { HistoryService, safeError } from './storageIntegration';

export function activate(context: vscode.ExtensionContext) {
  const providers = new ProviderManager(context);
  const history = new HistoryService(context, message => { void vscode.window.showWarningMessage(`minds：${message}`); });
  const editor = new MarkdownEditorProvider(context, providers, history);
  context.subscriptions.push(history, editor,
    vscode.window.registerCustomEditorProvider(MarkdownEditorProvider.viewType, editor, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('minds.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) { void vscode.window.showInformationMessage('先打开一个 Markdown 文件'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, MarkdownEditorProvider.viewType);
    }),
    vscode.commands.registerCommand('minds.configureProvider', () => providers.configure()),
    vscode.commands.registerCommand('minds.clearCredential', () => providers.clearCredential()),
    vscode.commands.registerCommand('minds.history', () => editor.openHistory()),
    vscode.commands.registerCommand('minds.maintenance', async () => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('历史维护需要受信任的工作区'); return; }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      try {
        const store = await history.store(folder); const preview = await store.maintain({ dryRun: true });
        const choice = await vscode.window.showInformationMessage(`minds 维护预览：过期/降采样 ${preview.expiredSnapshots} 个快照，可回收 ${preview.collectibleBlobs} 个私有 Blob（${preview.collectibleBytes} bytes）。${preview.warnings.join(' ')}`, { modal: true }, '执行整理');
        if (choice === '执行整理') { const result = await store.maintain({ dryRun: false }); void vscode.window.showInformationMessage(`minds：移除 ${result.expiredSnapshots} 个快照，回收 ${result.deletedBlobs} 个私有 Blob。`); }
      } catch (error) { void vscode.window.showWarningMessage(`minds：${safeError(error)}`); }
    }),
  );
  return { editor, providers, history };
}
export function deactivate() {}
