import type { ConversationRepository, NavigationSnapshot } from './conversations.ts';
import type { Conversation } from './types.ts';

// Preserve ordered IndexedDB writes without putting promises or timers in state.
export class ConversationPersistence {
  private queue: Promise<void> = Promise.resolve();
  private checkpoints = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Conversation>();
  constructor(private repository: ConversationRepository, private onError: () => void) {}
  private write(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch(this.onError);
  }
  save(conversation: Conversation, streaming = false) {
    if (streaming) {
      this.pending.set(conversation.id, conversation);
      if (!this.checkpoints.has(conversation.id)) this.checkpoints.set(conversation.id, setTimeout(() => this.checkpoint(conversation.id), 1000));
      return;
    }
    this.cancel(conversation.id);
    this.write(() => this.repository.save(conversation));
  }
  private checkpoint(id: string) {
    const conversation = this.pending.get(id);
    if (conversation) this.save(conversation);
  }
  private cancel(id: string) {
    clearTimeout(this.checkpoints.get(id));
    this.checkpoints.delete(id); this.pending.delete(id);
  }
  navigate(snapshot: NavigationSnapshot) { this.write(() => this.repository.navigate(snapshot)); }
  remove(ids: string[]) {
    for (const id of ids) this.cancel(id);
    if (ids.length) this.write(() => this.repository.remove(ids));
  }
  clear() {
    for (const id of this.checkpoints.keys()) this.cancel(id);
    this.write(() => this.repository.clear());
  }
  async flush() {
    for (const id of this.pending.keys()) this.checkpoint(id);
    await this.queue;
  }
}
