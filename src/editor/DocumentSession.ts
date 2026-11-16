import * as vscode from 'vscode';
import { applyNormalizedChange, normalizedOffsetToRaw } from '../shared/text';
import type { TextChange } from '../shared/types';

export class DocumentSession implements vscode.Disposable {
  private tail: Promise<unknown> = Promise.resolve();
  private active?: { id: string; result: string };
  private readonly listener: vscode.Disposable;
  constructor(readonly document: vscode.TextDocument, readonly changed: (originOpId?: string) => void) {
    this.listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      const origin = this.active?.result === document.getText() ? this.active.id : undefined;
      changed(origin);
    });
  }
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined); return result;
  }
  async apply(id: string, baseVersion: number, change: TextChange): Promise<void> {
    return this.enqueue(async () => {
      if (this.document.isClosed || this.document.version !== baseVersion) throw new Error('文档版本已变化，保留草稿后重试');
      const raw = this.document.getText();
      const eol = this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const expected = applyNormalizedChange(raw, change, eol);
      const edit = new vscode.WorkspaceEdit();
      const range = new vscode.Range(this.document.positionAt(normalizedOffsetToRaw(raw, change.from)), this.document.positionAt(normalizedOffsetToRaw(raw, change.to)));
      edit.replace(this.document.uri, range, change.insert.replace(/\r\n/g, '\n').replace(/\n/g, eol));
      this.active = { id, result: expected };
      try {
        // VS Code does not expose atomic expectedVersion for WorkspaceEdit.
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied || this.document.getText() !== expected) throw new Error('原生提交失败或发生并发修改；请检查保留草稿');
      } finally { this.active = undefined; }
    });
  }
  dispose(): void { this.listener.dispose(); }
}
