const messages = {
  configuration: 'AI 用户配置无效，请重新配置 Provider',
  endpoint: 'AI 地址只允许 HTTPS 或 loopback HTTP，且不能包含凭证、查询参数或片段',
  credential: 'AI 凭证无效或不可用，请重新配置 Provider',
  storage: '无法保存 AI 用户配置或凭证，请重新配置 Provider',
  disabled: '请先配置 AI Provider、模型和凭证，并确认发送地址',
  changed: 'AI 配置在请求准备期间发生变化，请重新运行',
  untrusted: '不受信任的工作区禁止运行 AI',
  input: 'AI 输入无效或超过输入限制',
  context: 'AI 总上下文（含系统提示、历史、文档和目标文本）超过预算；未发送，也未截断',
  cancelled: 'AI 请求已取消；未生成可应用的修改建议',
  timeout: 'AI 请求超时；未生成可应用的修改建议',
  output: 'AI 输出超过 500000 字符限制；未生成可应用的修改建议',
  truncated: '模型输出达到 token 或上下文限制，内容不完整；请调整预算后重新生成',
  refusal: '模型拒绝了请求；未生成可应用的修改建议',
  incomplete: 'AI 流未正常完成；未生成可应用的修改建议',
  unsupported: 'AI 返回了不支持的非文本内容或结束状态；未执行任何工具',
  empty: '模型未返回文字内容',
  sensitiveOutput: 'AI 输出包含敏感凭证，已拒绝展示或应用',
  authentication: 'AI 服务拒绝认证或访问，请检查当前 Provider 的凭证',
  rateLimit: 'AI 服务请求过多，请稍后重试',
  request: 'AI 请求失败，请检查 Provider 配置和网络；未生成可应用的修改建议',
} as const;

// Only fixed messages leave the Extension Host: never attach SDK errors/bodies as causes.
export class AIError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'AIError';
  }
}

export function safeAIError(error: unknown): AIError {
  // The official SDK wraps fetch failures in APIConnectionError. Recover only
  // our fixed-message errors, never its body/message or an arbitrary cause.
  for (let depth = 0; depth < 4; depth++) {
    if (error instanceof AIError) return error;
    if (!error || typeof error !== 'object') break;
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  }
  return new AIError('request');
}
