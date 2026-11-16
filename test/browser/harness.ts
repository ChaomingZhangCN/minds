import { applyNormalizedChange } from '../../src/shared/text';
import { sampleChart, sampleMermaid } from '../../src/shared/embeds';
import wideChart from '../fixtures/wide-chart.json';
import type { ClientMessage } from '../../src/shared/protocol';
import type { ClientContext, DocumentState, EmbedDocument, HistoryEntry, Proposal, ServerMessage } from '../../src/shared/types';

const diagrams = new URLSearchParams(location.search).has('diagrams');
const text = diagrams ? '# 图形验收\n\n**可直接编辑的正文**，图形与源码在同一块中。\n\n- [ ] 验收任务\n\n```chart\n' + JSON.stringify(wideChart, null, 2) + '\n```\n\n```mermaid\n' + sampleMermaid + '```\n\n```excalidraw\n{"src":"drawing.excalidraw"}\n```\n\n```drawio\n{"src":"drawing.drawio"}\n```\n\n结束。\n' : '# minds 测试\n\n需要改写的正文段落。\n\n结束。\n';
const documentState: DocumentState = { uri: 'file:///mock/document.md', fileName: 'document.md', text, version: 1, dirty: false, eol: '\n', resourceUrls: {}, resourceStamp: '1' };
const context: ClientContext = { document: documentState, provider: { provider: 'anthropic', model: 'mock-only-no-network', configured: true, executionHost: '模拟 Host（无付费调用）', refusalFallback: false }, trusted: true, drawioUrl: 'http://127.0.0.1:5174/drawio/index.html', excalidrawAssetUrl: `${location.origin}/excalidraw/` };
const calls: ClientMessage[] = [], past: string[] = [], future: string[] = [], snapshots: { entry: HistoryEntry; markdown: string }[] = [];
const resources = new Map<string, string>([
  ['drawing.excalidraw', JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'shape-1', type: 'rectangle', x: 10, y: 10, width: 200, height: 100, strokeColor: '#1b1b1f', backgroundColor: '#ffffff' }], appState: { viewBackgroundColor: '#ffffff' }, files: {} })],
  ['drawing.drawio', '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="本地真实 draw.io" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="200" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'],
]);
const embeds = new Map<string, EmbedDocument>(), proposals = new Map<string, Proposal>();
let persisted: unknown;
function send(message: ServerMessage) { window.postMessage(message, location.origin); }
function updated(next: string, originOpId?: string) { past.push(documentState.text); future.length = 0; documentState.text = next; documentState.version++; documentState.dirty = true; send({ type: 'document', document: { ...documentState, originOpId } }); }
function ok(id: string, data?: unknown) { send({ type: 'result', id, ok: true, data }); }
const mock = {
  postMessage(message: ClientMessage) {
    calls.push(message);
    setTimeout(() => {
      try {
        switch (message.type) {
          case 'ready': send({ type: 'init', context }); break;
          case 'edit':
            if (message.baseVersion !== documentState.version) throw new Error('模拟文档版本已变化');
            updated(applyNormalizedChange(documentState.text, message.change, '\n'), message.id); break;
          case 'save': {
            documentState.dirty = false;
            const entry: HistoryEntry = { id: crypto.randomUUID(), documentId: 'mock-document', savedAt: Date.now(), contentHash: 'mock-not-a-real-hash', resourceCount: 0, reason: 'save', head: true };
            snapshots.forEach(snapshot => snapshot.entry.head = false); snapshots.unshift({ entry, markdown: documentState.text }); send({ type: 'document', document: { ...documentState } }); break;
          }
          case 'undo': if (past.length) { future.push(documentState.text); documentState.text = past.pop()!; documentState.version++; send({ type: 'document', document: { ...documentState } }); } break;
          case 'redo': if (future.length) { past.push(documentState.text); documentState.text = future.pop()!; documentState.version++; send({ type: 'document', document: { ...documentState } }); } break;
          case 'aiStart': {
            const replacement = '【模拟回答】这是由测试 Host 生成的文字，没有模型或网络调用。';
            send({ type: 'aiChunk', requestId: message.id, text: replacement });
            const proposal = message.mode === 'rewrite' ? { id: crypto.randomUUID(), mode: message.mode, from: message.from, to: message.to, baseVersion: message.baseVersion, original: message.expectedText, replacement, prompt: message.prompt, createdAt: Date.now() } satisfies Proposal : undefined;
            if (proposal) proposals.set(proposal.id, proposal);
            send({ type: 'aiDone', requestId: message.id, text: replacement, proposal }); break;
          }
          case 'proposalAccept': { const proposal = proposals.get(message.proposalId)!; if (proposal.baseVersion !== documentState.version) throw new Error('提案过期'); updated(documentState.text.slice(0, proposal.from) + proposal.replacement + documentState.text.slice(proposal.to)); break; }
          case 'historyList': ok(message.id, snapshots.map(snapshot => snapshot.entry)); return;
          case 'historyPreview': { const snapshot = snapshots.find(item => item.entry.id === message.snapshotId)!; ok(message.id, { ...snapshot, resources: [], warnings: [] }); return; }
          case 'insertEmbed': {
            if (message.baseVersion !== documentState.version) throw new Error('插入版本已变化');
            const src = `${crypto.randomUUID()}.${message.kind}`;
            if (message.kind === 'drawio' || message.kind === 'excalidraw') resources.set(src, resources.get(`drawing.${message.kind}`)!);
            const content = message.kind === 'mermaid' ? sampleMermaid : JSON.stringify(message.kind === 'charts' ? sampleChart : { src }, null, 2) + '\n';
            updated(documentState.text.slice(0, message.from) + `\n\n\`\`\`${message.kind}\n${content}\`\`\`\n` + documentState.text.slice(message.to)); break;
          }
          case 'readEmbed': { const content = resources.get(message.src); if (!content) throw new Error('模拟资源不存在'); const embed: EmbedDocument = { sessionId: crypto.randomUUID(), kind: message.kind, src: message.src, content, hash: 'mock-resource-hash' }; embeds.set(embed.sessionId, embed); ok(message.id, embed); return; }
          case 'saveEmbed': { const embed = embeds.get(message.sessionId)!; resources.set(embed.src, message.content); documentState.resourceStamp = crypto.randomUUID(); send({ type: 'document', document: { ...documentState } }); break; }
          case 'closeEmbed': embeds.delete(message.sessionId); break;
          case 'maintenance': ok(message.id, { dryRun: message.dryRun, expiredSnapshots: 0, collectibleBlobs: 0, collectibleBytes: 0, deletedBlobs: 0, warnings: ['模拟维护，未删除任何文件。'] }); return;
          case 'exportSvg': send({ type: 'notice', level: 'info', message: '模拟 SVG 导出已接收，未写文件。' }); break;
          case 'historyRestore': throw new Error('模拟页不执行真实恢复；请在 VS Code 验收。');
          case 'configureProvider': throw new Error('模拟页没有凭证；请在 VS Code 配置。');
        }
        ok(message.id);
      } catch (error) { send({ type: 'result', id: message.id, ok: false, error: (error as Error).message, document: { ...documentState } }); }
    }, 25);
  },
  getState() { return persisted; }, setState(value: unknown) { persisted = value; },
};
Object.assign(window, { __MINDS_DEV_BRIDGE__: mock, __MINDS_TEST__: { calls, documentState, resources, external(text: string) { updated(text); } } });
const moduleUrl = '/webview/app.js';
void import(moduleUrl);
