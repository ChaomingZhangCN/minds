import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ProviderStatus } from '../shared/types';
import { AIError } from './errors';

export interface ProviderSettings {
  provider: 'none' | 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  maxContextCharacters: number;
  timeoutSeconds: number;
  refusalFallback: boolean;
}

const defaults = {
  provider: 'none', baseUrl: '', model: '', maxOutputTokens: 8192,
  maxContextCharacters: 64000, timeoutSeconds: 120, refusalFallback: true,
} as const;
const endpoints = { anthropic: 'https://api.anthropic.com', 'openai-compatible': 'https://api.openai.com/v1' };

export function normalizeEndpoint(value: string): string {
  try {
    if (!value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new AIError('endpoint');
    const url = new URL(value);
    const host = url.hostname;
    const loopback = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        !url.hostname || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      throw new AIError('endpoint');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new AIError('endpoint');
  }
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new AIError('configuration');
  return value;
}

function validCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function identity(settings: ProviderSettings): string {
  return createHash('sha256').update(JSON.stringify([settings.provider, settings.baseUrl])).digest('hex');
}

function executionHost(): string {
  return vscode.env.remoteName ? `Remote Extension Host (${vscode.env.remoteName})` : 'Local Extension Host';
}

export class ProviderManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  settings(): ProviderSettings {
    const config = vscode.workspace.getConfiguration('minds.ai');
    // Never use get(): workspace/folder/language overrides are not an authority for AI.
    const read = (key: keyof typeof defaults): unknown => {
      const inspected = config.inspect<unknown>(key);
      return inspected?.globalValue ?? inspected?.defaultValue ?? defaults[key];
    };
    const provider = read('provider');
    if (provider !== 'none' && provider !== 'openai-compatible' && provider !== 'anthropic') throw new AIError('configuration');
    const rawUrl = read('baseUrl');
    const rawModel = read('model');
    const refusalFallback = read('refusalFallback');
    if (typeof rawUrl !== 'string' || typeof rawModel !== 'string' || typeof refusalFallback !== 'boolean') throw new AIError('configuration');
    const model = rawModel.trim() || (provider === 'anthropic' ? 'claude-opus-5-5' : '');
    if (model.length > 256 || /[\s\u0000-\u001f\u007f]/.test(model)) throw new AIError('configuration');
    return {
      provider, baseUrl: provider === 'none' ? '' : normalizeEndpoint(rawUrl || endpoints[provider]), model,
      maxOutputTokens: integer(read('maxOutputTokens'), 256, 64000),
      maxContextCharacters: integer(read('maxContextCharacters'), 1000, 500000),
      timeoutSeconds: integer(read('timeoutSeconds'), 10, 600), refusalFallback,
    };
  }

  private async credentialFor(settings: ProviderSettings): Promise<string | undefined> {
    if (settings.provider === 'none' || this.context.globalState.get<boolean>(`minds.ai.approved.${identity(settings)}`) !== true) return undefined;
    try {
      const key = await this.context.secrets.get(`minds.ai.credential.${identity(settings)}`);
      return validCredential(key) ? key : undefined;
    } catch {
      throw new AIError('credential');
    }
  }

  credentials(): Promise<string | undefined> {
    return this.credentialFor(this.settings());
  }

  async status(): Promise<ProviderStatus> {
    const settings = this.settings();
    const key = await this.credentialFor(settings);
    return {
      provider: settings.provider, model: settings.model,
      configured: settings.provider !== 'none' && !!settings.model && !!key,
      executionHost: executionHost(), refusalFallback: settings.provider === 'anthropic' && settings.refusalFallback,
    };
  }

  async configure(): Promise<void> {
    const choice = await vscode.window.showQuickPick([
      { label: 'Anthropic', provider: 'anthropic' as const },
      { label: 'OpenAI-compatible', provider: 'openai-compatible' as const },
      { label: '关闭 AI', provider: 'none' as const },
    ], { title: 'minds: 配置 AI（仅用户全局设置）', ignoreFocusOut: true });
    if (!choice) return;
    const config = vscode.workspace.getConfiguration('minds.ai');
    if (choice.provider === 'none') {
      try { await config.update('provider', 'none', vscode.ConfigurationTarget.Global); }
      catch { throw new AIError('storage'); }
      return;
    }
    let current: ProviderSettings | undefined;
    try { current = this.settings(); } catch { /* The dialog can repair invalid user settings. */ }
    const sameProvider = current && current.provider === choice.provider ? current : undefined;
    const rawUrl = await vscode.window.showInputBox({
      title: 'AI 服务地址', value: sameProvider ? sameProvider.baseUrl : endpoints[choice.provider], ignoreFocusOut: true,
      prompt: '只允许 HTTPS 或 loopback HTTP；此地址将接收文档、目标文本、提示和对话历史。',
      validateInput: value => { try { normalizeEndpoint(value); return undefined; } catch { return new AIError('endpoint').message; } },
    });
    if (rawUrl === undefined) return;
    const baseUrl = normalizeEndpoint(rawUrl);
    const model = await vscode.window.showInputBox({
      title: '模型 ID', value: sameProvider ? sameProvider.model : choice.provider === 'anthropic' ? 'claude-opus-5-5' : '',
      ignoreFocusOut: true, prompt: 'OpenAI-compatible 请填写服务实际支持的模型 ID。',
      validateInput: value => !value.trim() || value.trim().length > 256 || /[\s\u0000-\u001f\u007f]/.test(value.trim()) ? '请填写有效的模型 ID' : undefined,
    });
    if (model === undefined) return;
    if (!model.trim() || model.trim().length > 256 || /[\s\u0000-\u001f\u007f]/.test(model.trim())) throw new AIError('configuration');
    const numberInput = async (title: string, value: number, min: number, max: number): Promise<number | undefined> => {
      const text = await vscode.window.showInputBox({ title, value: String(value), ignoreFocusOut: true,
        validateInput: text => /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max ? undefined : `请输入 ${min}–${max} 的整数`,
      });
      if (text === undefined) return undefined;
      if (!/^\d+$/.test(text)) throw new AIError('configuration');
      return integer(Number(text), min, max);
    };
    const maxOutputTokens = await numberInput('最大输出 tokens', current?.maxOutputTokens ?? defaults.maxOutputTokens, 256, 64000);
    if (maxOutputTokens === undefined) return;
    const maxContextCharacters = await numberInput('总上下文字符预算（含系统提示和历史；超限直接拒绝）', current?.maxContextCharacters ?? defaults.maxContextCharacters, 1000, 500000);
    if (maxContextCharacters === undefined) return;
    const timeoutSeconds = await numberInput('总请求超时（秒）', current?.timeoutSeconds ?? defaults.timeoutSeconds, 10, 600);
    if (timeoutSeconds === undefined) return;
    let refusalFallback = current?.refusalFallback ?? defaults.refusalFallback;
    if (choice.provider === 'anthropic') {
      const fallback = await vscode.window.showQuickPick([
        { label: '启用服务端默认拒绝回退', enabled: true },
        { label: '关闭拒绝回退', enabled: false },
      ], { title: 'Anthropic 拒绝回退（可能由服务端在同一 Provider 内使用其他模型；客户端不重试）', ignoreFocusOut: true });
      if (!fallback) return;
      refusalFallback = fallback.enabled;
    }
    const settings: ProviderSettings = { provider: choice.provider, baseUrl, model: model.trim(), maxOutputTokens, maxContextCharacters, timeoutSeconds, refusalFallback };
    const confirmed = await vscode.window.showWarningMessage(
      `确认将 AI 输入（提示、文档、目标文本、对话历史）发送到 ${baseUrl}？模型：${settings.model}。请求从 ${executionHost()} 发出。凭证只存 SecretStorage；设置只写用户全局配置。${settings.provider === 'anthropic' && refusalFallback ? '已启用 Anthropic 服务端默认拒绝回退。' : ''}`,
      { modal: true }, '确认并配置',
    );
    if (confirmed !== '确认并配置') return;
    const existing = await this.credentialFor(settings);
    const entered = await vscode.window.showInputBox({
      title: 'AI API 凭证', password: true, ignoreFocusOut: true,
      prompt: existing ? '留空保留此 Provider 和地址已存的凭证。凭证不会发送给 Webview 或写入日志。' : '凭证仅存于 Extension Host 的 SecretStorage，不使用环境变量。',
      validateInput: value => value === '' && existing ? undefined : validCredential(value) ? undefined : '请输入有效凭证（不能含空白或控制字符）',
    });
    if (entered === undefined) return;
    const key = entered || existing;
    if (!validCredential(key)) throw new AIError('credential');
    const id = identity(settings);
    try {
      // Write provider last. A partially failed configuration cannot activate a new provider.
      await this.context.secrets.store(`minds.ai.credential.${id}`, key);
      for (const name of ['baseUrl', 'model', 'maxOutputTokens', 'maxContextCharacters', 'timeoutSeconds', 'refusalFallback'] as const) {
        await config.update(name, settings[name], vscode.ConfigurationTarget.Global);
      }
      await this.context.globalState.update(`minds.ai.approved.${id}`, true);
      await config.update('provider', settings.provider, vscode.ConfigurationTarget.Global);
    } catch {
      throw new AIError('storage');
    }
  }

  async clearCredential(): Promise<void> {
    const settings = this.settings();
    if (settings.provider === 'none') return;
    const id = identity(settings);
    try {
      await this.context.globalState.update(`minds.ai.approved.${id}`, undefined);
      await this.context.secrets.delete(`minds.ai.credential.${id}`);
    } catch {
      throw new AIError('credential');
    }
  }
}
