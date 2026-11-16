// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrawioFrame } from '../src/webview/components/DrawioFrame';
let root: Root | undefined, parent: HTMLDivElement;
beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; parent?.remove(); });
const xml = '<mxfile><diagram id="a"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
const url = 'http://127.0.0.1:5174/drawio/index.html';
async function mount(onSave: (xml: string) => Promise<void>, onCancel = vi.fn<() => void | Promise<void>>()) {
  parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent); const onDraft = vi.fn(), onExport = vi.fn();
  await act(async () => root!.render(<DrawioFrame url={url} xml={xml} onSave={onSave} onDraft={onDraft} onCancel={onCancel} onExport={onExport} />));
  const frame = parent.querySelector('iframe')!;
  const send = async (message: object) => { await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'http://127.0.0.1:5174', data: JSON.stringify(message) }))); };
  await send({ event: 'init' }); await send({ event: 'load' }); return { frame, send, onDraft, onCancel };
}
describe('real iframe transport, mocked Host save (not a browser draw.io canvas)', () => {
  it('restores readiness if Host session close fails and allows cancellation retry', async () => {
    const onCancel = vi.fn().mockRejectedValueOnce(new Error('close failed')).mockResolvedValue(undefined), onSave = vi.fn().mockResolvedValue(undefined);
    const { frame, send } = await mount(onSave, onCancel);
    await send({ event: 'exit' }); expect(parent.querySelector('iframe')).toBe(frame); expect(parent.querySelector('[role="alert"]')?.textContent).toContain('close failed');
    expect((parent.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    await send({ event: 'exit' }); expect(onCancel).toHaveBeenCalledTimes(2); await send({ event: 'save', xml }); expect(onSave).not.toHaveBeenCalled();
  });
  it('does not revive an unmounted frame when an asynchronous Host save finishes', async () => {
    let resolve!: () => void; const onSave = vi.fn(() => new Promise<void>(done => { resolve = done; })); const { send } = await mount(onSave);
    await send({ event: 'save', xml }); await act(async () => root!.unmount()); root = undefined;
    await act(async () => resolve()); await send({ event: 'save', xml }); expect(onSave).toHaveBeenCalledTimes(1); expect(parent.querySelector('iframe')).toBeNull();
  });
  it('waits for Host save, rejects duplicate saves and cancellation during commit', async () => {
    let resolve!: () => void; const onSave = vi.fn(() => new Promise<void>(done => { resolve = done; })); const { send, onCancel } = await mount(onSave);
    await send({ event: 'save', xml }); await send({ event: 'save', xml }); await send({ event: 'exit' }); expect(onSave).toHaveBeenCalledTimes(1); expect(onCancel).not.toHaveBeenCalled();
    expect((parent.querySelector('button') as HTMLButtonElement).disabled).toBe(true); await act(async () => resolve()); await send({ event: 'save', xml }); expect(onSave).toHaveBeenCalledTimes(1);
  });
  it('preserves the iframe and draft on Host failure, then permits a successful retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('resource changed')).mockResolvedValue(undefined); const { frame, send, onDraft } = await mount(onSave);
    await send({ event: 'autosave', xml }); expect(onDraft).toHaveBeenCalledWith(xml);
    await send({ event: 'save', xml }); expect(parent.querySelector('iframe')).toBe(frame); expect(parent.querySelector('[role="alert"]')?.textContent).toContain('resource changed'); expect((parent.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    await send({ event: 'save', xml }); expect(onSave).toHaveBeenCalledTimes(2);
  });
});
