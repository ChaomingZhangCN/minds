export type EmbedKind = 'charts' | 'mermaid' | 'excalidraw' | 'drawio';
export type AgentMode = 'ask' | 'rewrite';
export interface TextChange { from: number; to: number; insert: string; expectedText: string }
export interface DocumentState {
  uri: string; fileName: string; text: string; version: number; dirty: boolean;
  eol: '\n' | '\r\n'; resourceUrls: Record<string, string>; resourceStamp?: string; originOpId?: string;
}
export interface ProviderStatus {
  provider: 'none' | 'openai-compatible' | 'anthropic'; model: string;
  configured: boolean; executionHost: string; refusalFallback: boolean;
}
export interface ClientContext {
  document: DocumentState; provider: ProviderStatus; trusted: boolean;
  drawioUrl: string; excalidrawAssetUrl: string;
}
export interface EmbedDocument {
  sessionId: string; kind: 'drawio' | 'excalidraw'; src: string; content: string; hash: string;
}
export interface Proposal {
  id: string; mode: AgentMode; from: number; to: number; baseVersion: number;
  original: string; replacement: string; prompt: string; createdAt: number;
}
export interface HistoryEntry {
  id: string; documentId: string; savedAt: number; contentHash: string;
  resourceCount: number; head: boolean; reason: string;
}
export interface SnapshotPreview {
  entry: HistoryEntry; markdown: string;
  resources: { path: string; hash: string; kind: string; size: number }[];
  warnings: string[];
}
export interface MaintenanceReport {
  dryRun: boolean; expiredSnapshots: number; collectibleBlobs: number;
  collectibleBytes: number; deletedBlobs: number; warnings: string[];
}
export type ServerMessage =
  | { type: 'init'; context: ClientContext }
  | { type: 'document'; document: DocumentState }
  | { type: 'provider'; provider: ProviderStatus; trusted: boolean }
  | { type: 'result'; id: string; ok: true; data?: unknown }
  | { type: 'result'; id: string; ok: false; error: string; document?: DocumentState }
  | { type: 'aiChunk'; requestId: string; text: string }
  | { type: 'aiDone'; requestId: string; text: string; proposal?: Proposal }
  | { type: 'aiError'; requestId: string; error: string }
  | { type: 'notice'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'openHistory' };
