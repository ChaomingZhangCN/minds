import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { MessageCreateParamsBase as BetaMessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions';
import { AIError, safeAIError } from './errors';
import type { AgentStreamEvent, AgentTransport, AgentTransportRequest } from './transport';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Block redirects and SDK custom-header env injection. Only the approved API operation
// and its official text/auth headers can leave the Extension Host.
function approvedFetch(request: AgentTransportRequest): typeof globalThis.fetch {
  const anthropic = request.settings.provider === 'anthropic';
  const expected = request.settings.baseUrl + (anthropic ? '/v1/messages' : '/chat/completions');
  const allowedHeaders = new Set(['authorization', 'content-type', 'accept',
    ...(anthropic ? ['anthropic-version', 'anthropic-beta'] : [])]);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== expected || init?.method !== 'POST') throw new AIError('endpoint');
    const source = new Headers(init.headers);
    if (source.get('authorization') !== `Bearer ${request.credential}`) throw new AIError('credential');
    const headers = new Headers();
    source.forEach((value, name) => { if (allowedHeaders.has(name)) headers.set(name, value); });
    // Keep the beta opt-in tied to user settings, not ANTHROPIC_CUSTOM_HEADERS.
    if (anthropic) {
      headers.set('anthropic-version', '2026-10-21'); // SDK 1.8.0's native API version.
      if (request.settings.refusalFallback) headers.set('anthropic-beta', 'server-side-fallback-2026-07-01');
      else headers.delete('anthropic-beta');
    }
    return globalThis.fetch(input, { ...init, headers, redirect: 'error' });
  };
}

function stopReason(reason: string | null): Extract<AgentStreamEvent, { type: 'stop' }>['reason'] {
  if (reason === 'end_turn' || reason === 'stop') return 'complete';
  if (reason === 'max_tokens' || reason === 'length') return 'max_tokens';
  if (reason === 'model_context_window_exceeded') return 'context_limit';
  if (reason === 'refusal' || reason === 'content_filter') return 'refusal';
  return 'unsupported';
}

async function* anthropicStream(request: AgentTransportRequest): AsyncGenerator<AgentStreamEvent> {
  const client = new Anthropic({
    apiKey: request.credential, baseURL: request.settings.baseUrl,
    webhookKey: null, timeout: request.settings.timeoutSeconds * 1000, maxRetries: 0,
    logLevel: 'off', logger: silentLogger, openTelemetry: false,
    fetchOptions: { redirect: 'error' }, fetch: approvedFetch(request),
  });
  const body: MessageCreateParamsBase = {
    model: request.settings.model, max_tokens: request.settings.maxOutputTokens,
    system: request.system, messages: request.messages.map(message => ({ ...message })),
  };
  // SDK 1.8.0 exposes fallbacks only on beta Messages, not stable Messages.
  const fallbackBody: BetaMessageCreateParamsBase = {
    ...body, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'],
  };
  const options = { signal: request.signal, timeout: request.settings.timeoutSeconds * 1000, maxRetries: 0 };
  const stream = request.settings.refusalFallback ? client.beta.messages.stream(fallbackBody, options) : client.messages.stream(body, options);
  let stopped = false;
  try {
    for await (const event of stream) {
      if (event.type === 'message_stop') stopped = true;
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'text') {
          if (block.text) yield { type: 'text', text: block.text };
        } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking' && block.type !== 'fallback') {
          throw new AIError('unsupported');
        }
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    if (!stopped) throw new AIError('incomplete');
    const final = await stream.finalMessage();
    yield { type: 'stop', reason: stopReason(final.stop_reason) };
  } finally {
    stream.abort();
  }
}

async function* openaiStream(request: AgentTransportRequest): AsyncGenerator<AgentStreamEvent> {
  const client = new OpenAI({
    apiKey: request.credential, baseURL: request.settings.baseUrl,
    adminAPIKey: null, organization: null, project: null, webhookSecret: null,
    timeout: request.settings.timeoutSeconds * 1000, maxRetries: 0,
    logLevel: 'off', logger: silentLogger, fetchOptions: { redirect: 'error' }, fetch: approvedFetch(request),
  });
  const body: ChatCompletionCreateParamsStreaming = {
    model: request.settings.model, stream: true, n: 1, store: false,
    // Official, though deprecated: widely supported by OpenAI-compatible Chat APIs.
    max_tokens: request.settings.maxOutputTokens,
    messages: [{ role: 'system', content: request.system }, ...request.messages.map(message => ({ ...message }))],
  };
  const stream = await client.chat.completions.create(body, {
    signal: request.signal, timeout: request.settings.timeoutSeconds * 1000, maxRetries: 0,
  });
  let reason: string | null = null;
  try {
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        if (choice.index !== 0 || reason !== null) throw new AIError('incomplete');
        if (choice.delta.tool_calls?.length || choice.delta.function_call || choice.delta.audio) throw new AIError('unsupported');
        if (choice.delta.refusal) throw new AIError('refusal');
        if (choice.delta.content) yield { type: 'text', text: choice.delta.content };
        if (choice.finish_reason !== null) reason = choice.finish_reason;
      }
    }
    if (reason === null) throw new AIError('incomplete');
    yield { type: 'stop', reason: stopReason(reason) };
  } finally {
    stream.controller.abort();
  }
}

export const sdkTransport: AgentTransport = async function* (request) {
  try {
    if (request.settings.provider === 'anthropic') yield* anthropicStream(request);
    else if (request.settings.provider === 'openai-compatible') yield* openaiStream(request);
    else throw new AIError('disabled');
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403) throw new AIError('authentication');
      if (error.status === 429) throw new AIError('rateLimit');
    }
    throw safeAIError(error);
  }
};
