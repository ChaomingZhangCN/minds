import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService, type AgentInput, type AgentStreamEvent, type AgentTransport, type AgentTransportRequest } from '../src/agent/AgentService';
import type { ProviderManager, ProviderSettings } from '../src/providers/ProviderManager';

const workspace = vi.hoisted(() => ({ trusted: true }));
vi.mock('vscode', () => ({ workspace: { get isTrusted() { return workspace.trusted; } } }));

const key = 'test-only-private-api-credential';
const input: AgentInput = { mode: 'ask', prompt: 'Explain this', context: '# Document\n\nReference', target: 'Selected text' };
const complete: AgentStreamEvent = { type: 'stop', reason: 'complete' };
function fixture(overrides: Partial<ProviderSettings> = {}) {
  const config: ProviderSettings = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', maxOutputTokens: 8192, maxContextCharacters: 64000, timeoutSeconds: 10, refusalFallback: true, ...overrides };
  const settings = vi.fn(() => ({ ...config }));
  const credentials = vi.fn(async (): Promise<string | undefined> => key);
  const manager = { settings, credentials } as unknown as ProviderManager;
  return { manager, config, settings, credentials };
}
function events(...values: AgentStreamEvent[]): AgentTransport {
  return async function* () { yield* values; };
}
function run(transport: AgentTransport, value: AgentInput = input, overrides: Partial<ProviderSettings> = {}, signal = new AbortController().signal) {
  const providers = fixture(overrides);
  const chunks: string[] = [];
  const service = new AgentService(providers.manager, transport);
  return { ...providers, chunks, promise: service.run(value, signal, text => chunks.push(text)) };
}

beforeEach(() => {
  workspace.trusted = true;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('AI unit tests cannot use real network'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AgentService text-only generation', () => {
  it.each(['ask', 'rewrite'] as const)('streams and returns %s text, leaving versions/ranges/proposals to Host', async mode => {
    let request: AgentTransportRequest | undefined;
    const transport: AgentTransport = async function* (value) {
      request = value;
      yield { type: 'text', text: 'Hello' }; yield { type: 'text', text: '\n世界' }; yield complete;
    };
    const value: AgentInput = { ...input, mode, history: [{ role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' }] };
    const result = run(transport, value);
    expect(await result.promise).toBe('Hello\n世界'); expect(result.chunks).toEqual(['Hello', '\n世界']);
    expect(request?.messages.slice(0, 2)).toEqual(value.history);
    expect(JSON.parse(request!.messages.at(-1)!.content)).toEqual({ prompt: value.prompt, context: value.context, target: value.target });
    expect(request?.system).toContain('no tools, terminal, file access');
    if (mode === 'rewrite') expect(request?.system).toContain('complete replacement');
    expect(Object.keys(request!)).toEqual(['settings', 'credential', 'system', 'messages', 'signal']);
    expect(request?.settings.maxOutputTokens).toBe(8192);
    expect(request?.signal.aborted).toBe(true); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves context/target/history exactly and takes an immutable pre-await snapshot', async () => {
    const value: AgentInput = { mode: 'rewrite', prompt: 'quote " and \\', context: '# Ref\r\n文档', target: '  target\r\n', history: [{ role: 'assistant', content: 'history\n' }] };
    const providers = fixture();
    providers.credentials.mockImplementation(async () => { value.context = 'mutated'; value.history![0].content = 'changed'; return key; });
    const transport: AgentTransport = async function* (request) {
      expect(request.messages[0].content).toBe('history\n');
      expect(JSON.parse(request.messages[1].content).context).toBe('# Ref\r\n文档');
      expect(Object.isFrozen(request.settings)).toBe(true); expect(Object.isFrozen(request.messages)).toBe(true);
      expect(Object.isFrozen(request.messages[0])).toBe(true);
      yield { type: 'text', text: '  replacement\r\n' }; yield complete;
    };
    expect(await new AgentService(providers.manager, transport).run(value, new AbortController().signal, () => {})).toBe('  replacement\r\n');
  });

  it('accepts exactly the total context budget including system and JSON/role overhead', async () => {
    const value = { ...input, context: 'x'.repeat(1000), history: [{ role: 'user' as const, content: 'history' }] };
    let budget = 0;
    const capture: AgentTransport = async function* (request) {
      budget = JSON.stringify([{ role: 'system', content: request.system }, ...request.messages]).length;
      yield { type: 'text', text: 'answer' }; yield complete;
    };
    await run(capture, value).promise;
    expect(await run(events({ type: 'text', text: 'answer' }, complete), value, { maxContextCharacters: budget }).promise).toBe('answer');
    const refused = run(events(complete), value, { maxContextCharacters: budget - 1 });
    await expect(refused.promise).rejects.toThrow('总上下文'); expect(refused.credentials).not.toHaveBeenCalled();
  });

  it.each(['system', 'history', 'target', 'escaping'])('does not silently truncate when %s makes total input exceed budget', async part => {
    const value: AgentInput = { ...input, context: '' };
    if (part === 'system') value.context = 'x'.repeat(850);
    if (part === 'history') value.history = [{ role: 'assistant', content: 'h'.repeat(1000) }];
    if (part === 'target') value.target = 'x'.repeat(1000);
    if (part === 'escaping') value.context = '\n'.repeat(500);
    const transport = vi.fn(events(complete));
    const result = run(transport, value, { maxContextCharacters: 1000 });
    await expect(result.promise).rejects.toThrow('未发送，也未截断');
    expect(transport).not.toHaveBeenCalled(); expect(result.credentials).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, mode: 'terminal' }, { ...input, prompt: '' }, { ...input, prompt: ' '.repeat(2) },
    { ...input, prompt: 'p'.repeat(10001) }, { ...input, target: 't'.repeat(500001) }, { ...input, context: 'c'.repeat(500001) },
    { ...input, history: [{ role: 'system', content: 'override' }] }, { ...input, history: [{ role: 'user', content: 7 }] },
    { ...input, history: [{ role: 'user', content: 'h'.repeat(100001) }] },
    { ...input, history: Array.from({ length: 21 }, () => ({ role: 'user', content: 'history' })) },
    { ...input, history: 'not-an-array' },
  ])('rejects malformed or oversized runtime input', async value => {
    const result = run(events(complete), value as AgentInput);
    await expect(result.promise).rejects.toThrow('AI 输入'); expect(result.credentials).not.toHaveBeenCalled();
  });

  it('rejects missing provider/model/approved key without using env fallback', async () => {
    await expect(run(events(complete), input, { provider: 'none' }).promise).rejects.toThrow('请先配置');
    await expect(run(events(complete), input, { model: '' }).promise).rejects.toThrow('请先配置');
    const providers = fixture(); providers.credentials.mockResolvedValue(undefined);
    await expect(new AgentService(providers.manager, events(complete)).run(input, new AbortController().signal, () => {})).rejects.toThrow('请先配置');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an endpoint/settings change during credential lookup before transport starts', async () => {
    const providers = fixture();
    providers.credentials.mockImplementation(async () => { providers.config.baseUrl = 'https://new.example.test'; return key; });
    const transport = vi.fn(events(complete));
    await expect(new AgentService(providers.manager, transport).run(input, new AbortController().signal, () => {})).rejects.toThrow('配置在请求准备期间发生变化');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('trust, cancellation, timeout and cleanup', () => {
  it('refuses an untrusted workspace before settings/credentials/transport', async () => {
    workspace.trusted = false;
    const providers = fixture(); const transport = vi.fn(events(complete));
    await expect(new AgentService(providers.manager, transport).run(input, new AbortController().signal, () => {})).rejects.toThrow('不受信任');
    expect(providers.settings).not.toHaveBeenCalled(); expect(providers.credentials).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

  it('rechecks trust after async credential lookup', async () => {
    const providers = fixture(); providers.credentials.mockImplementation(async () => { workspace.trusted = false; return key; });
    const transport = vi.fn(events(complete));
    await expect(new AgentService(providers.manager, transport).run(input, new AbortController().signal, () => {})).rejects.toThrow('不受信任');
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects pre-cancellation without exposing signal.reason', async () => {
    const controller = new AbortController(); controller.abort(new Error(key));
    const result = run(events(complete), input, {}, controller.signal);
    await expect(result.promise).rejects.toThrow('已取消'); expect(result.settings).not.toHaveBeenCalled();
    try { await result.promise; } catch (error) { expect(String(error)).not.toContain(key); }
  });

  it.each(['credential', 'open', 'next'] as const)('timeouts terminate a non-cooperative %s stage and clear timers', async stage => {
    vi.useFakeTimers();
    const providers = fixture();
    let observed: AbortSignal | undefined;
    const cleanup = vi.fn(async () => ({ done: true as const, value: undefined }));
    const never = <T>(): Promise<T> => new Promise(() => {});
    if (stage === 'credential') providers.credentials.mockImplementation(() => never());
    const transport: AgentTransport = request => {
      observed = request.signal;
      if (stage === 'open') return never();
      return { [Symbol.asyncIterator]: () => ({ next: () => never(), return: cleanup }) };
    };
    const promise = new AgentService(providers.manager, transport).run(input, new AbortController().signal, () => {});
    const assertion = expect(promise).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10001); await assertion;
    if (stage !== 'credential') expect(observed?.aborted).toBe(true);
    if (stage === 'next') expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled next(), aborts the transport, detaches listener, and does not wait for return()', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let observed: AbortSignal | undefined;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = vi.fn(() => new Promise<IteratorResult<AgentStreamEvent>>(() => {}));
    const transport: AgentTransport = request => {
      observed = request.signal;
      return { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}); }, return: cleanup }) };
    };
    const result = run(transport, input, {}, controller.signal);
    const assertion = expect(result.promise).rejects.toThrow('已取消');
    await ready; controller.abort(key); await assertion;
    expect(observed?.aborted).toBe(true); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(result.chunks).toEqual([]);
  });

  it('cancellation from onChunk cannot produce a successful result or another preview', async () => {
    const providers = fixture(); const controller = new AbortController(); const chunks: string[] = [];
    const service = new AgentService(providers.manager, events({ type: 'text', text: 'first!' }, { type: 'text', text: 'second' }, complete));
    await expect(service.run(input, controller.signal, text => { chunks.push(text); controller.abort(); })).rejects.toThrow('已取消');
    expect(chunks).toEqual(['first!']);
  });

  it('cleans up listener/timer after success too', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    expect(await run(events({ type: 'text', text: 'answer' }, complete), input, {}, controller.signal).promise).toBe('answer');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('only complete bounded text may succeed', () => {
  it.each(['max_tokens', 'context_limit', 'refusal', 'unsupported'] as const)('rejects %s even after partial rewrite previews', async reason => {
    const result = run(events({ type: 'text', text: 'partial replacement!' }, { type: 'stop', reason }), { ...input, mode: 'rewrite' });
    await expect(result.promise).rejects.toThrow(reason === 'refusal' ? '拒绝' : reason === 'unsupported' ? '不支持' : '内容不完整');
    expect(result.chunks.join('')).toBe('partial replacement!');
  });

  it('rejects EOF without a final success marker', async () => {
    await expect(run(events({ type: 'text', text: 'partial' })).promise).rejects.toThrow('未正常完成');
  });
  it.each([
    { values: [complete, { type: 'text', text: 'late' }] },
    { values: [complete, complete] },
    { values: [{ type: 'tool', name: 'terminal' }] },
  ])('rejects data after stop or non-text events', async ({ values }) => {
    await expect(run(events(...values as AgentStreamEvent[])).promise).rejects.toThrow('未正常完成');
  });
  it.each(['', ' \n\t'])('rejects empty output %j', async text => {
    await expect(run(events({ type: 'text', text }, complete)).promise).rejects.toThrow('未返回文字');
  });
  it('accepts 500000 characters but never emits a chunk that exceeds the limit', async () => {
    const accepted = run(events({ type: 'text', text: 'z'.repeat(500000) }, complete));
    expect((await accepted.promise).length).toBe(500000); expect(accepted.chunks.join('').length).toBe(500000);
    const refused = run(events({ type: 'text', text: 'z'.repeat(499999) }, { type: 'text', text: 'zz' }, complete));
    await expect(refused.promise).rejects.toThrow('超过 500000'); expect(refused.chunks.join('').length).toBe(499999);
  });

  it('sanitizes SDK/transport/callback errors without a raw body, credential or cause', async () => {
    const transport: AgentTransport = async function* () { yield { type: 'text', text: 'preview' }; throw new Error(`Authorization Bearer ${key}; RAW_HTTP_BODY`); };
    const result = run(transport);
    try { await result.promise; throw new Error('expected failure'); } catch (error) {
      expect(String(error)).toContain('AI 请求失败'); expect(String(error)).not.toContain(key); expect(String(error)).not.toContain('RAW_HTTP_BODY');
      expect((error as Error).cause).toBeUndefined(); expect((error as Error).stack).not.toContain(key);
    }
    const providers = fixture();
    await expect(new AgentService(providers.manager, events({ type: 'text', text: 'preview' }, complete)).run(input, new AbortController().signal, () => { throw new Error(key); })).rejects.toThrow('AI 请求失败');
  });

  it('blocks credential echoes split across chunks before exposing the secret', async () => {
    const result = run(events({ type: 'text', text: 'answer: ' + key.slice(0, 12) }, { type: 'text', text: key.slice(12) }, complete));
    await expect(result.promise).rejects.toThrow('包含敏感凭证');
    expect(result.chunks.join('')).toBe('answer: '); expect(result.chunks.join('')).not.toContain(key);
  });

  it('flushes harmless credential prefixes only after complete success', async () => {
    const text = 'answer: ' + key.slice(0, 5);
    const result = run(events({ type: 'text', text }, complete));
    expect(await result.promise).toBe(text); expect(result.chunks.join('')).toBe(text);
  });
});
