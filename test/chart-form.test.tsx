// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// Form lifecycle only; real ECharts SSR is covered separately in charts.test.ts.
vi.mock('echarts/core', async importOriginal => ({ ...await importOriginal<object>(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })) }));
import { ChartBlock } from '../src/webview/components/ChartBlock';
import { sampleChart } from '../src/shared/embeds';
import { graphDrafts, removeGraphDraft } from '../src/webview/drafts';
let root: Root | undefined, parent: HTMLDivElement;
beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; parent?.remove(); for (const draft of graphDrafts()) removeGraphDraft(draft.id); });
const button = (name: string) => [...parent.querySelectorAll('button')].find(node => node.textContent === name)!;
async function input(textarea: HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function mount() {
  parent = document.createElement('div'); document.body.append(parent); root = createRoot(parent); const onChange = vi.fn();
  await act(async () => root!.render(<ChartBlock spec={sampleChart} onChange={onChange} />)); await act(async () => button('编辑图表').click()); return { onChange };
}
describe('Chart form preserves incomplete and conflicting drafts', () => {
  it('retains invalid data verbatim, keeps the last valid chart and blocks confirmation', async () => {
    const { onChange } = await mount(), textarea = parent.querySelector('textarea')!;
    const previous = parent.querySelector('.chart-canvas')?.getAttribute('aria-label');
    await input(textarea, '[{"month":"unfinished'); expect(textarea.value).toBe('[{"month":"unfinished');
    expect(parent.querySelector('.chart-canvas')?.getAttribute('aria-label')).toBe(previous);
    expect((button('JSON') as HTMLButtonElement).disabled).toBe(true); expect((button('确认替换图表') as HTMLButtonElement).disabled).toBe(true);
    expect((button('编辑图表') as HTMLButtonElement).disabled).toBe(true); expect(onChange).not.toHaveBeenCalled();
    expect(graphDrafts().some(draft => draft.content.includes('[{"month":"unfinished'))).toBe(true);
    await input(textarea, JSON.stringify(sampleChart.data)); expect((button('确认替换图表') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => button('确认替换图表').click()); expect(onChange).toHaveBeenCalledWith(sampleChart); expect(graphDrafts()).toHaveLength(0);
  });
  it('keeps primitive and malformed JSON drafts editable without crashing the form', async () => {
    await mount(); await act(async () => button('JSON').click());
    for (const value of ['7', '"not a spec"', '[]', '{invalid']) {
      await input(parent.querySelector('textarea')!, value); await act(async () => button('表单').click());
      expect(parent.querySelector('textarea')?.value).toBe(value); expect((button('确认替换图表') as HTMLButtonElement).disabled).toBe(true);
      expect(parent.querySelector('.chart-canvas')).not.toBeNull();
    }
  });
  it('preserves a valid local draft and rejects confirmation after external changes', async () => {
    const { onChange } = await mount(); await input(parent.querySelector('textarea')!, JSON.stringify(sampleChart.data));
    await act(async () => root!.render(<ChartBlock spec={{ ...sampleChart, title: 'external' }} onChange={onChange} />));
    expect((button('确认替换图表') as HTMLButtonElement).disabled).toBe(true); await act(async () => button('确认替换图表').click()); expect(onChange).not.toHaveBeenCalled();
    expect(graphDrafts()).toHaveLength(1);
  });
});
