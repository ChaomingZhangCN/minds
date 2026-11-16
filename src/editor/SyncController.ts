import { smallestChange } from '../shared/text';
import type { DocumentState, TextChange } from '../shared/types';

export interface EditRequest { id: string; baseVersion: number; change: TextChange }
interface Pending { id: string; text: string }
export class SyncController {
  private confirmed: Pick<DocumentState, 'text' | 'version'>;
  private pending?: Pending;
  private counter = 0;
  private readonly prefix = Math.random().toString(36).slice(2);
  private idleWaiters: (() => void)[] = [];
  draft: string;
  conflictDraft?: string;
  blocked = false;
  constructor(initial: Pick<DocumentState, 'text' | 'version'>, private readonly send: (request: EditRequest) => void) {
    this.confirmed = initial; this.draft = initial.text;
  }
  get version(): number { return this.confirmed.version; }
  get busy(): boolean { return !!this.pending; }
  local(text: string): void {
    this.draft = text;
    if (!this.blocked) this.flush();
  }
  flush(): void {
    if (this.blocked || this.pending || this.draft === this.confirmed.text) { this.notifyIdle(); return; }
    const id = `edit-${this.prefix}-${++this.counter}`;
    this.pending = { id, text: this.draft };
    this.send({ id, baseVersion: this.confirmed.version, change: smallestChange(this.confirmed.text, this.draft) });
  }
  receive(state: Pick<DocumentState, 'text' | 'version'> & { originOpId?: string }): boolean {
    if (state.version < this.confirmed.version) return false;
    if (this.pending && state.originOpId === this.pending.id && state.text === this.pending.text) {
      this.confirmed = state; this.pending = undefined; this.flush(); return false;
    }
    if (state.text === this.confirmed.text) {
      this.confirmed = state; return false;
    }
    if (state.text === this.draft && !this.blocked) {
      this.confirmed = state; this.pending = undefined; this.flush(); return false;
    }
    if (this.draft !== this.confirmed.text) {
      this.conflictDraft = this.draft; this.blocked = true;
    }
    this.pending = undefined; this.confirmed = state; this.draft = state.text; this.notifyIdle();
    return true;
  }
  reject(id: string, state: Pick<DocumentState, 'text' | 'version'>): boolean {
    if (this.pending?.id !== id) return false;
    this.conflictDraft = this.draft; this.blocked = true; this.pending = undefined;
    this.confirmed = state; this.draft = state.text; this.notifyIdle(); return true;
  }
  resume(): void { this.blocked = false; this.flush(); }
  discardConflict(): void { this.conflictDraft = undefined; this.resume(); }
  whenIdle(): Promise<void> {
    if (this.blocked) return Promise.reject(new Error('请先处理未提交草稿'));
    this.flush();
    if (!this.pending) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('等待文档同步超时；请保留草稿后重试')), 15000);
      this.idleWaiters.push(() => { clearTimeout(timeout); this.blocked ? reject(new Error('文档发生冲突')) : resolve(); });
    });
  }
  private notifyIdle(): void {
    if (!this.pending && (this.blocked || this.draft === this.confirmed.text)) this.idleWaiters.splice(0).forEach(resolve => resolve());
  }
}
