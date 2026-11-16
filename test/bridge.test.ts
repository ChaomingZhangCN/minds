// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientContext, ServerMessage } from '../src/shared/types';

// VS Code forwards Host messages from its wrapper into a same-origin content iframe.
let container: HTMLDivElement, wrapper: Window, content: Window, vendor: Window, sibling: Window;
const transport = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
const acquire = vi.fn(() => transport);
const context: ClientContext = {
  document: { uri: 'file:///test.md', fileName: 'test.md', text: '# title', version: 1, dirty: false, eol: '\n', resourceUrls: {} },
  provider: { provider: 'none', model: '', configured: false, executionHost: 'mock Host', refusalFallback: false },
  trusted: true, drawioUrl: '', excalidrawAssetUrl: '',
};

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container);
  const frames = [document.createElement('iframe'), document.createElement('iframe')]; container.append(...frames);
  content = frames[0].contentWindow!; sibling = frames[1].contentWindow!; wrapper = content.parent;
  const frame = content.document.createElement('iframe'); content.document.body.append(frame); vendor = frame.contentWindow!;
  vi.stubGlobal('window', content);
  vi.stubGlobal('acquireVsCodeApi', acquire);
});
afterEach(() => { container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function load(dev = false) {
  if (dev) content.__MINDS_DEV_BRIDGE__ = transport;
  return import('../src/webview/bridge');
}
function send(message: ServerMessage, source: Window | null = wrapper, origin = wrapper.origin) {
  content.dispatchEvent(new MessageEvent('message', { data: message, source, origin }));
}

describe('VS Code Host bridge', () => {
  it('receives init forwarded by the direct parent wrapper', async () => {
    const bridge = await load(), listener = vi.fn(); bridge.subscribe(listener);
    expect(content.parent === wrapper).toBe(true); expect(content.parent === content).toBe(false);
    send({ type: 'init', context });
    expect(listener).toHaveBeenCalledWith({ type: 'init', context });
    expect(acquire).toHaveBeenCalledOnce();
  });
  it('receives document updates through the same parent transport', async () => {
    const bridge = await load(), listener = vi.fn(); bridge.subscribe(listener);
    const message: ServerMessage = { type: 'document', document: { ...context.document, version: 2, text: '# changed' } };
    send(message); expect(listener).toHaveBeenCalledWith(message);
  });
  it.each(['self', 'vendor', 'sibling', 'null'] as const)('rejects forged init from %s even at the same origin', async source => {
    const bridge = await load(), listener = vi.fn(); bridge.subscribe(listener);
    send({ type: 'init', context }, { self: content, vendor, sibling, null: null }[source]);
    expect(listener).not.toHaveBeenCalled();
  });
  it.each(['https://evil.test', 'null', ''])('rejects parent messages with origin %s', async origin => {
    const bridge = await load(), listener = vi.fn(); bridge.subscribe(listener);
    send({ type: 'init', context }, wrapper, origin); expect(listener).not.toHaveBeenCalled();
  });
  it('does not let a vendor frame settle a pending Host request', async () => {
    const bridge = await load(), listener = vi.fn(); bridge.subscribe(listener);
    const result = bridge.request({ type: 'historyList' });
    const { id } = transport.postMessage.mock.calls[0][0];
    send({ type: 'result', id, ok: true, data: 'forged' }, vendor);
    expect(listener).not.toHaveBeenCalled();
    send({ type: 'result', id, ok: true, data: ['actual Host'] });
    await expect(result).resolves.toEqual(['actual Host']);
  });
  it('rejects a request on an authorized Host error', async () => {
    const bridge = await load(), result = bridge.request({ type: 'historyList' });
    const { id } = transport.postMessage.mock.calls[0][0];
    send({ type: 'result', id, ok: false, error: 'Host failure' });
    await expect(result).rejects.toThrow('Host failure');
  });
  it('keeps self-window transport only for the explicitly injected development bridge', async () => {
    const bridge = await load(true), listener = vi.fn(); bridge.subscribe(listener);
    send({ type: 'init', context }, content); expect(listener).toHaveBeenCalledOnce();
    listener.mockClear();
    send({ type: 'init', context }, vendor); send({ type: 'init', context }, wrapper);
    expect(listener).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
  });
});
