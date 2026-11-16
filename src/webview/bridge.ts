import type { ClientMessage } from '../shared/protocol';
import type { ServerMessage } from '../shared/types';

declare global { interface Window { __MINDS_DEV_BRIDGE__?: { postMessage(message: ClientMessage): void; getState(): unknown; setState(value: unknown): void }; } }
declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void; getState(): unknown; setState(value: unknown): void };
const api = window.__MINDS_DEV_BRIDGE__ ?? acquireVsCodeApi();
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<(message: ServerMessage) => void>();
window.addEventListener('message', event => {
  // Vendor child frames cannot impersonate the VS Code host transport.
  if (event.source && event.source !== window) return;
  const message = event.data as ServerMessage;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'result') {
    const waiter = pending.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); message.ok ? waiter.resolve(message.data) : waiter.reject(new Error(message.error)); }
  }
  listeners.forEach(listener => listener(message));
});
export function subscribe(listener: (message: ServerMessage) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function post(message: ClientMessage): void { api.postMessage(message); }
type RequestMessage = ClientMessage extends infer T ? T extends ClientMessage ? Omit<T, 'id'> : never : never;
export function request<T = unknown>(message: RequestMessage, timeoutMs = 30000): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host 请求超时；文档操作请先检查当前版本再重试')); }, timeoutMs);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    api.postMessage({ ...message, id } as ClientMessage);
  });
}
export function persistedDraft(): { conflictDraft?: string } { return (api.getState() as { conflictDraft?: string } | undefined) ?? {}; }
export function persistDraft(conflictDraft?: string): void { api.setState({ conflictDraft }); }
