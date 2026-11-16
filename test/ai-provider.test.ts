import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { createHash } from 'node:crypto';

const host = vi.hoisted(() => ({
  global: new Map<string, unknown>(),
  defaults: new Map<string, unknown>(),
  workspace: new Map<string, unknown>(),
  inspect: vi.fn(), mergedGet: vi.fn(), update: vi.fn(),
  pick: vi.fn(), input: vi.fn(), confirm: vi.fn(), remoteName: undefined as string | undefined,
}));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ inspect: host.inspect, get: host.mergedGet, update: host.update }) },
  window: { showQuickPick: host.pick, showInputBox: host.input, showWarningMessage: host.confirm },
  env: { get remoteName() { return host.remoteName; } },
  ConfigurationTarget: { Global: 1 },
}));
import { normalizeEndpoint, ProviderManager } from '../src/providers/ProviderManager';

function setup() {
  const secrets = new Map<string, string>();
  const approvals = new Map<string, unknown>();
  const secretGet = vi.fn(async (key: string) => secrets.get(key));
  const store = vi.fn(async (key: string, value: string) => { secrets.set(key, value); });
  const remove = vi.fn(async (key: string) => { secrets.delete(key); });
  const globalUpdate = vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) approvals.delete(key); else approvals.set(key, value);
  });
  const context = {
    secrets: { get: secretGet, store, delete: remove },
    globalState: { get: (key: string) => approvals.get(key), update: globalUpdate },
  } as unknown as vscode.ExtensionContext;
  return { manager: new ProviderManager(context), secrets, approvals, secretGet, store, remove, globalUpdate };
}

function dialog(provider: 'anthropic' | 'openai-compatible', url: string, key: string, model = provider === 'anthropic' ? 'claude-opus-5-5' : 'compatible-model') {
  host.pick.mockResolvedValueOnce({ provider });
  if (provider === 'anthropic') host.pick.mockResolvedValueOnce({ enabled: true });
  for (const value of [url, model, '8192', '64000', '120', key]) host.input.mockResolvedValueOnce(value);
  host.confirm.mockResolvedValueOnce('确认并配置');
}

beforeEach(() => {
  vi.resetAllMocks();
  host.global.clear(); host.defaults.clear(); host.workspace.clear(); host.remoteName = undefined;
  for (const [key, value] of Object.entries({ provider: 'none', baseUrl: '', model: '', maxOutputTokens: 8192, maxContextCharacters: 64000, timeoutSeconds: 120, refusalFallback: true })) host.defaults.set(key, value);
  host.inspect.mockImplementation((key: string) => ({
    globalValue: host.global.get(key), defaultValue: host.defaults.get(key),
    workspaceValue: host.workspace.get(key), workspaceFolderValue: host.workspace.get(key),
    globalLanguageValue: host.workspace.get(key),
  }));
  host.mergedGet.mockImplementation(() => { throw new Error('Merged workspace configuration must never be read'); });
  host.update.mockImplementation(async (key: string, value: unknown, target: number) => {
    expect(target).toBe(1); host.global.set(key, value);
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No real network in AI tests'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('ProviderManager user-only configuration', () => {
  it('ignores workspace, folder and language overrides for every setting', () => {
    host.global.set('provider', 'anthropic');
    for (const [key, value] of Object.entries({ provider: 'openai-compatible', baseUrl: 'http://evil.test', model: 'evil-model', maxOutputTokens: 999999, maxContextCharacters: 9999999, timeoutSeconds: 1, refusalFallback: false })) host.workspace.set(key, value);
    expect(setup().manager.settings()).toEqual({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', maxOutputTokens: 8192, maxContextCharacters: 64000, timeoutSeconds: 120, refusalFallback: true });
    expect(host.mergedGet).not.toHaveBeenCalled();
  });

  it('reads valid user values rather than defaults', () => {
    for (const [key, value] of Object.entries({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model', maxOutputTokens: 256, maxContextCharacters: 1000, timeoutSeconds: 10, refusalFallback: false })) host.global.set(key, value);
    expect(setup().manager.settings()).toEqual({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model', maxOutputTokens: 256, maxContextCharacters: 1000, timeoutSeconds: 10, refusalFallback: false });
  });

  it.each([
    ['provider', 'evil'], ['baseUrl', 123], ['model', 'model\nsecret'], ['refusalFallback', 'true'],
    ['maxOutputTokens', 255], ['maxOutputTokens', 64001], ['maxOutputTokens', 500.5],
    ['maxContextCharacters', 999], ['maxContextCharacters', 500001], ['timeoutSeconds', 9], ['timeoutSeconds', 601], ['timeoutSeconds', NaN],
  ])('rejects invalid user value for %s', (key, value) => {
    host.global.set(key, value);
    expect(() => setup().manager.settings()).toThrow('AI 用户配置无效');
  });

  it('does not take credentials or endpoint from environment variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'environment-key'); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.test');
    host.global.set('provider', 'anthropic');
    const { manager, secretGet } = setup();
    expect(manager.settings().baseUrl).toBe('https://api.anthropic.com');
    expect(await manager.credentials()).toBeUndefined();
    expect(await manager.status()).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', configured: false, executionHost: 'Local Extension Host', refusalFallback: true });
    expect(secretGet).not.toHaveBeenCalled();
  });
});

describe('endpoint policy', () => {
  it.each(['https://api.example.test/v1', 'http://localhost:8000/v1', 'http://127.0.0.1:1234', 'http://127.22.0.1', 'http://[::1]:8000'])('allows %s', url => {
    expect(normalizeEndpoint(url)).toBe(url);
  });
  it.each(['http://evil.test', 'http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'http://0.0.0.0:8000', 'http://192.168.1.1', 'http://[::]:8000', 'file:///tmp/model', 'ftp://api.example.test', 'https://user:secret@api.example.test', 'https://api.example.test?key=secret', 'https://api.example.test#secret', 'https://api.example.test?', 'https://api.example.test#', 'https://api.example.test\n', 'https://api.example.test\\evil', 'not-a-url'])('rejects %s without echoing it', url => {
    expect(() => normalizeEndpoint(url)).toThrow('AI 地址只允许');
    try { normalizeEndpoint(url); } catch (error) { expect(String(error)).not.toContain(url); }
  });
  it('canonicalizes host case and trailing slash for credential isolation', () => {
    expect(normalizeEndpoint('HTTPS://API.EXAMPLE.TEST:443/v1///')).toBe('https://api.example.test/v1');
  });
});

describe('interactive configuration and isolated SecretStorage', () => {
  it('confirms the endpoint before password input and writes only Global settings', async () => {
    const { manager, store } = setup();
    dialog('anthropic', 'https://api.example.test', 'private-api-key');
    await manager.configure();
    expect(host.input.mock.calls.at(-1)?.[0]).toMatchObject({ password: true, ignoreFocusOut: true });
    expect(host.confirm.mock.calls[0][0]).toContain('https://api.example.test');
    expect(host.confirm.mock.calls[0][0]).toContain('文档');
    expect(host.confirm.mock.invocationCallOrder[0]).toBeLessThan(host.input.mock.invocationCallOrder.at(-1)!);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).not.toContain('private-api-key');
    expect(store.mock.calls[0][0]).not.toContain('api.example.test');
    expect(host.update).toHaveBeenCalledTimes(7);
    expect(host.update.mock.calls.at(-1)?.slice(0, 2)).toEqual(['provider', 'anthropic']);
    expect(await manager.credentials()).toBe('private-api-key');
    expect(JSON.stringify(await manager.status())).not.toContain('private-api-key');
    expect(JSON.stringify(host.update.mock.calls)).not.toContain('private-api-key');
    expect(JSON.stringify(host.confirm.mock.calls)).not.toContain('private-api-key');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('requires approval even when a matching secret already exists', async () => {
    host.global.set('provider', 'anthropic');
    const { manager, secrets } = setup();
    const id = createHash('sha256').update(JSON.stringify(['anthropic', 'https://api.anthropic.com'])).digest('hex');
    secrets.set(`minds.ai.credential.${id}`, 'preexisting-key');
    expect(await manager.credentials()).toBeUndefined();
    expect((await manager.status()).configured).toBe(false);
  });

  it('isolates by provider and full endpoint, and clearing affects only the active pair', async () => {
    const { manager, secrets } = setup();
    dialog('anthropic', 'https://api.example.test/v1', 'anthropic-private-key'); await manager.configure();
    host.global.set('baseUrl', 'https://api.example.test/v2');
    expect(await manager.credentials()).toBeUndefined();
    dialog('anthropic', 'https://api.example.test/v2', 'second-private-key'); await manager.configure();
    dialog('openai-compatible', 'https://api.example.test/v2', 'openai-private-key'); await manager.configure();
    expect(secrets.size).toBe(3);
    await manager.clearCredential();
    expect(secrets.size).toBe(2); expect(await manager.credentials()).toBeUndefined();
    host.global.set('provider', 'anthropic');
    expect(await manager.credentials()).toBe('second-private-key');
    host.global.set('baseUrl', 'https://api.example.test/v1/');
    expect(await manager.credentials()).toBe('anthropic-private-key');
  });

  it('preserves a credential on blank input only for the confirmed same pair', async () => {
    const { manager, secrets } = setup();
    dialog('anthropic', 'https://api.example.test', 'old-private-key'); await manager.configure();
    dialog('anthropic', 'https://api.example.test/', ''); await manager.configure();
    expect(secrets.size).toBe(1); expect(await manager.credentials()).toBe('old-private-key');
    dialog('anthropic', 'https://other.example.test', '');
    await expect(manager.configure()).rejects.toThrow('AI 凭证');
    expect(secrets.size).toBe(1);
  });

  it('does not store a key or write settings when confirmation is denied', async () => {
    const { manager, store, globalUpdate } = setup();
    dialog('anthropic', 'https://api.example.test', 'secret'); host.confirm.mockReset().mockResolvedValue(undefined);
    await manager.configure();
    expect(host.input).toHaveBeenCalledTimes(5); expect(store).not.toHaveBeenCalled();
    expect(globalUpdate).not.toHaveBeenCalled(); expect(host.update).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5])('cancel at input %s leaves state unchanged', async index => {
    const { manager, store } = setup();
    host.pick.mockResolvedValue({ provider: 'anthropic', enabled: true });
    const values = ['https://api.example.test', 'claude-opus-5-5', '8192', '64000', '120', 'private-key'];
    for (let i = 0; i < values.length; i++) host.input.mockResolvedValueOnce(i === index ? undefined : values[i]);
    host.confirm.mockResolvedValue('确认并配置');
    await manager.configure();
    expect(store).not.toHaveBeenCalled(); expect(host.update).not.toHaveBeenCalled();
  });

  it('can disable AI without deleting another provider credential', async () => {
    const { manager, secrets } = setup();
    dialog('anthropic', 'https://api.example.test', 'private-key'); await manager.configure();
    host.pick.mockResolvedValueOnce({ provider: 'none' }); await manager.configure();
    expect(manager.settings().provider).toBe('none'); expect(await manager.credentials()).toBeUndefined();
    expect((await manager.status()).refusalFallback).toBe(false); expect(secrets.size).toBe(1);
    await manager.clearCredential(); expect(secrets.size).toBe(1);
  });

  it('identifies Remote Extension Host and does not claim OpenAI refusal fallback', async () => {
    const { manager } = setup();
    dialog('openai-compatible', 'https://api.example.test/v1', 'private-key'); await manager.configure();
    host.remoteName = 'ssh-remote';
    expect(await manager.status()).toMatchObject({ configured: true, executionHost: 'Remote Extension Host (ssh-remote)', refusalFallback: false });
  });

  it('sanitizes SecretStorage and configuration write errors', async () => {
    const { manager, store } = setup();
    dialog('anthropic', 'https://api.example.test', 'private-key');
    store.mockRejectedValue(new Error('private-key raw backend body'));
    await expect(manager.configure()).rejects.toThrow('无法保存 AI');
    try { dialog('anthropic', 'https://api.example.test', 'private-key'); await manager.configure(); }
    catch (error) { expect(String(error)).not.toContain('private-key'); }
  });
});
