// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GraphViewport } from '../src/webview/components/GraphViewport';
let root: Root | undefined, parent: HTMLDivElement;
beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; parent?.remove(); });
async function mount() { parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent); await act(async () => root!.render(<GraphViewport><div>Graph</div></GraphViewport>)); return parent.querySelector('.graph-pan-area')!; }
const output = () => parent.querySelector('output')?.textContent;
describe('graph viewport controls with synthetic geometry, not browser layout', () => {
  it('prevents browser zoom only for modified wheel gestures and updates graph scale', async () => {
    const area = await mount(); const normal = new WheelEvent('wheel', { deltaY: -100, cancelable: true }); await act(async () => area.dispatchEvent(normal)); expect(normal.defaultPrevented).toBe(false); expect(output()).toBe('100%');
    const modified = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true }); await act(async () => area.dispatchEvent(modified)); expect(modified.defaultPrevented).toBe(true); expect(output()).toBe('110%');
  });
  it('clamps zoom and resets without modifying content', async () => {
    const area = await mount(); for (let i = 0; i < 20; i++) await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))); expect(output()).toBe('400%');
    for (let i = 0; i < 40; i++) await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))); expect(output()).toBe('25%');
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))); expect(output()).toBe('100%'); expect(parent.querySelector('.graph-transform')?.textContent).toBe('Graph');
  });
  it('computes fit from measured content dimensions rather than merely resetting scale', async () => {
    const area = await mount(), content = parent.querySelector('.graph-transform')!;
    Object.defineProperty(area, 'clientWidth', { value: 500 }); Object.defineProperty(content, 'scrollWidth', { value: 1000 }); Object.defineProperty(content, 'scrollHeight', { value: 400 });
    await act(async () => [...parent.querySelectorAll('button')].find(button => button.textContent === '适应视口')!.click()); expect(output()).toBe('50%');
  });
});
