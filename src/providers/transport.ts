import type { ProviderSettings } from './ProviderManager';

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'stop'; reason: 'complete' | 'max_tokens' | 'context_limit' | 'refusal' | 'unsupported' };

export interface AgentTransportRequest {
  readonly settings: Readonly<ProviderSettings>;
  readonly credential: string;
  readonly system: string;
  readonly messages: ReadonlyArray<Readonly<{ role: 'user' | 'assistant'; content: string }>>;
  readonly signal: AbortSignal;
}

// Injection is exclusively an Extension Host/unit-test API, not a Webview protocol field.
export type AgentTransport = (request: AgentTransportRequest) =>
  AsyncIterable<AgentStreamEvent> | Promise<AsyncIterable<AgentStreamEvent>>;
