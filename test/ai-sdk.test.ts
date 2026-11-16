import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkTransport } from '../src/providers/SdkTransport';
import type { AgentStreamEvent, AgentTransportRequest } from '../src/providers/transport';

const credential = 'offline-sdk-test-private-key';
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function request(provider: 'anthropic' | 'openai-compatible', refusalFallback = true): AgentTransportRequest {
  return {
    settings: { provider, baseUrl: provider === 'anthropic' ? 'https://approved.example.test' : 'https://approved.example.test/v1', model: provider === 'anthropic' ? 'claude-opus-5-5' : 'compatible-model', maxOutputTokens: 4096, maxContextCharacters: 64000, timeoutSeconds: 10, refusalFallback },
    credential, system: 'text-only test system', messages: [{ role: 'user', content: 'offline test input' }], signal: new AbortController().signal,
  };
}
async function collect(value: AgentTransportRequest): Promise<AgentStreamEvent[]> {
  const output: AgentStreamEvent[] = [];
  for await (const event of await sdkTransport(value)) output.push(event);
  return output;
}
function sse(events: unknown[], anthropic = false): Response {
  const text = events.map(event => {
    const name = anthropic ? `event: ${(event as { type: string }).type}\n` : '';
    return `${name}data: ${JSON.stringify(event)}\n\n`;
  }).join('') + (anthropic ? '' : 'data: [DONE]\n\n');
  const bytes = new TextEncoder().encode(text);
  // Split at byte boundaries, including multi-byte text: exercise the real SDK decoder.
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
    controller.close();
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function anthropicEvents(reason = 'end_turn', block: Record<string, unknown> = { type: 'text', text: 'initial ' }): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg_offline', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    ...(block.type === 'text' ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } }] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null, stop_details: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}
function openaiChunk(content: string | null, reason: string | null = null, extra: Record<string, unknown> = {}): unknown {
  return { id: 'chatcmpl_offline', object: 'chat.completion.chunk', created: 0, model: 'compatible-model', choices: [{ index: 0, delta: { content, ...extra }, finish_reason: reason }] };
}
function sent() {
  const [url, options] = fetchMock.mock.calls[0];
  const body = JSON.parse(String(options?.body));
  return { url, options, body, headers: new Headers(options?.headers) };
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unmocked network is forbidden in SDK tests'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('installed Anthropic SDK native streaming', () => {
  it.each([true, false])('uses official Messages parameters and native SSE with refusalFallback=%s', async fallback => {
    fetchMock.mockResolvedValue(sse(anthropicEvents(), true));
    expect(await collect(request('anthropic', fallback))).toEqual([{ type: 'text', text: 'initial ' }, { type: 'text', text: '世界' }, { type: 'stop', reason: 'complete' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, body, options, headers } = sent();
    expect(url).toBe('https://approved.example.test/v1/messages'); expect(options?.redirect).toBe('error');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4096, stream: true, system: 'text-only test system', messages: [{ role: 'user', content: 'offline test input' }] });
    expect(body.refusalFallback).toBeUndefined(); expect(body.refusal_fallback).toBeUndefined();
    expect(body.tools).toBeUndefined(); expect(body.mcp_servers).toBeUndefined();
    expect(body.fallbacks).toBe(fallback ? 'default' : undefined);
    expect(headers.get('anthropic-beta')).toBe(fallback ? 'server-side-fallback-2026-07-01' : null);
    expect(headers.get('anthropic-version')).toBe('2026-10-21');
    expect(headers.get('authorization')).toBe(`Bearer ${credential}`);
    expect(JSON.stringify(body)).not.toContain(credential);
  });

  it.each([
    ['max_tokens', 'max_tokens'], ['model_context_window_exceeded', 'context_limit'], ['refusal', 'refusal'], ['tool_use', 'unsupported'], ['pause_turn', 'unsupported'],
  ])('maps stop_reason %s without generating another request', async (native, normalized) => {
    fetchMock.mockResolvedValue(sse(anthropicEvents(native), true));
    expect((await collect(request('anthropic'))).at(-1)).toEqual({ type: 'stop', reason: normalized });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose thinking or fallback metadata, and never retries locally', async () => {
    const fixture = anthropicEvents();
    fixture.splice(1, 0,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'hidden', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'server-fallback-model' }, trigger: { type: 'refusal', category: null } } },
      { type: 'content_block_stop', index: 1 },
    );
    for (let i = 5; i < fixture.length; i++) {
      const event = fixture[i] as { index?: number };
      if (event.index !== undefined) event.index = 2;
    }
    fetchMock.mockResolvedValue(sse(fixture, true));
    const result = await collect(request('anthropic'));
    expect(result).toEqual([{ type: 'text', text: 'initial ' }, { type: 'text', text: '世界' }, { type: 'stop', reason: 'complete' }]);
    expect(JSON.stringify(result)).not.toContain('hidden'); expect(JSON.stringify(result)).not.toContain('server-fallback-model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects native tool content without executing it', async () => {
    fetchMock.mockResolvedValue(sse(anthropicEvents('tool_use', { type: 'tool_use', id: 'tool_offline', name: 'terminal', input: { command: 'never execute' } }), true));
    await expect(collect(request('anthropic'))).rejects.toThrow('未执行任何工具'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing message_stop even after text and stop_reason', async () => {
    fetchMock.mockResolvedValue(sse(anthropicEvents().slice(0, -1), true));
    await expect(collect(request('anthropic'))).rejects.toThrow('未正常完成');
  });
});

describe('installed OpenAI SDK compatible Chat streaming', () => {
  it('uses typed ChatCompletion streaming and streams multilingual text', async () => {
    fetchMock.mockResolvedValue(sse([openaiChunk('answer '), openaiChunk('世界'), openaiChunk(null, 'stop')]));
    expect(await collect(request('openai-compatible'))).toEqual([{ type: 'text', text: 'answer ' }, { type: 'text', text: '世界' }, { type: 'stop', reason: 'complete' }]);
    const { url, body, options, headers } = sent();
    expect(url).toBe('https://approved.example.test/v1/chat/completions'); expect(options?.redirect).toBe('error');
    expect(body).toMatchObject({ model: 'compatible-model', stream: true, max_tokens: 4096, n: 1, store: false, messages: [{ role: 'system', content: 'text-only test system' }, { role: 'user', content: 'offline test input' }] });
    expect(body.tools).toBeUndefined(); expect(body.functions).toBeUndefined(); expect(body.fallbacks).toBeUndefined();
    expect(headers.get('authorization')).toBe(`Bearer ${credential}`); expect(headers.get('anthropic-beta')).toBeNull();
    expect(JSON.stringify(body)).not.toContain(credential); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([['length', 'max_tokens'], ['content_filter', 'refusal'], ['tool_calls', 'unsupported'], ['function_call', 'unsupported']])('maps finish_reason %s', async (native, normalized) => {
    fetchMock.mockResolvedValue(sse([openaiChunk('partial'), openaiChunk(null, native)]));
    expect((await collect(request('openai-compatible'))).at(-1)).toEqual({ type: 'stop', reason: normalized });
  });

  it('rejects missing finish_reason', async () => {
    fetchMock.mockResolvedValue(sse([openaiChunk('partial')]));
    await expect(collect(request('openai-compatible'))).rejects.toThrow('未正常完成');
  });

  it.each([
    { tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'terminal', arguments: '{}' } }] },
    { function_call: { name: 'terminal', arguments: '{}' } },
    { audio: { data: 'unsupported' } },
  ])('rejects tools/functions/non-text deltas', async extra => {
    fetchMock.mockResolvedValue(sse([openaiChunk(null, null, extra)]));
    await expect(collect(request('openai-compatible'))).rejects.toThrow('不支持');
  });

  it('rejects refusal deltas without displaying their raw text', async () => {
    fetchMock.mockResolvedValue(sse([openaiChunk(null, null, { refusal: credential })]));
    await expect(collect(request('openai-compatible'))).rejects.toThrow('模型拒绝');
  });

  it('rejects text after the final finish marker', async () => {
    fetchMock.mockResolvedValue(sse([openaiChunk(null, 'stop'), openaiChunk('late')]));
    await expect(collect(request('openai-compatible'))).rejects.toThrow('未正常完成');
  });
});

describe('SDK transport boundary: no secret logging, raw errors, env fallback or redirects', () => {
  it.each(['anthropic', 'openai-compatible'] as const)('sanitizes %s HTTP body errors and never retries', async provider => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { type: 'api_error', message: `RAW_HTTP_BODY ${credential}` } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    try { await collect(request(provider)); throw new Error('expected error'); } catch (error) {
      expect(String(error)).toContain('AI 请求失败'); expect(String(error)).not.toContain('RAW_HTTP_BODY'); expect(String(error)).not.toContain(credential);
      expect((error as Error).cause).toBeUndefined(); expect((error as Error).stack).not.toContain(credential);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429])('returns safe categorical HTTP %s errors', async status => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: credential } }), { status, headers: { 'content-type': 'application/json' } }));
    await expect(collect(request('openai-compatible'))).rejects.toThrow(status === 429 ? '请求过多' : '拒绝认证或访问');
  });

  it.each(['anthropic', 'openai-compatible'] as const)('disables %s debug logging even with hostile logging environment', async provider => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug'); vi.stubEnv('OPENAI_LOG', 'debug');
    const logs = ['debug', 'info', 'warn', 'error', 'log'].map(level => vi.spyOn(console, level as 'log').mockImplementation(() => {}));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: credential } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    await expect(collect(request(provider))).rejects.toThrow('AI 请求失败');
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(['anthropic', 'openai-compatible'] as const)('pins %s key/endpoint and filters environment custom headers', async provider => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'environment-key'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'environment-auth');
    vi.stubEnv('OPENAI_API_KEY', 'environment-key'); vi.stubEnv('OPENAI_ADMIN_KEY', 'environment-admin');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.test'); vi.stubEnv('OPENAI_BASE_URL', 'https://evil.test');
    vi.stubEnv('OPENAI_ORG_ID', 'environment-org'); vi.stubEnv('OPENAI_PROJECT_ID', 'environment-project');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Environment-Key: environment-key\nanthropic-beta: unsafe-beta\nanthropic-version: unsafe-version');
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'X-Environment-Key: environment-key');
    fetchMock.mockResolvedValue(provider === 'anthropic' ? sse(anthropicEvents(), true) : sse([openaiChunk('answer', 'stop')]));
    await collect(request(provider, false));
    const { url, headers } = sent();
    expect(String(url)).toContain('approved.example.test'); expect(headers.get('authorization')).toBe(`Bearer ${credential}`);
    expect(headers.get('x-environment-key')).toBeNull(); expect(headers.get('openai-organization')).toBeNull(); expect(headers.get('openai-project')).toBeNull();
    expect(headers.get('anthropic-beta')).toBeNull(); expect([...headers.values()].join('')).not.toContain('environment');
  });

  it('refuses an environment Authorization override before any HTTP request', async () => {
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer environment-key');
    await expect(collect(request('openai-compatible'))).rejects.toThrow('AI 凭证');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects to another endpoint', async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options?.redirect).toBe('error');
      throw new TypeError(`redirect failure with ${credential}`);
    });
    await expect(collect(request('openai-compatible'))).rejects.toThrow('AI 请求失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
