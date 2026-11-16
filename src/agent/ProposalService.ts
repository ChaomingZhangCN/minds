import { randomUUID } from 'node:crypto';
import type { Proposal } from '../shared/types';
import { chartSchema, findEmbedBlocks, parseJson } from '../shared/embeds';

export class ProposalService {
  private proposals = new Map<string, Proposal>();
  create(input: Omit<Proposal, 'id' | 'createdAt'>): Proposal {
    if (!input.replacement.trim()) throw new Error('模型未返回可应用的内容');
    if (input.replacement.length > 500000) throw new Error('模型输出超过修改限制');
    if ((input.replacement.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 !== 0) throw new Error('输出代码围栏不完整，不允许应用');
    for (const block of findEmbedBlocks(input.replacement)) if (block.kind === 'charts') {
      if (!chartSchema.safeParse(parseJson(block.content)).success) throw new Error('模型返回的 Charts 配置无效');
    }
    const proposal: Proposal = { ...input, id: randomUUID(), createdAt: Date.now() };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }
  validate(id: string, text: string, version: number): Proposal {
    const value = this.proposals.get(id);
    if (!value) throw new Error('修改建议不存在或已处理');
    if (value.baseVersion !== version || value.to > text.length || text.slice(value.from, value.to) !== value.original) {
      throw new Error('文档在生成后已变化；请基于新选区重新生成');
    }
    return value;
  }
  remove(id: string): void { this.proposals.delete(id); }
  clear(): void { this.proposals.clear(); }
}
