import { vi } from 'vitest';
import type { ConversationRepository, NavigationSnapshot } from '../src/conversations.ts';
import type { Conversation } from '../src/types.ts';

export function memoryRepository(initial: Conversation[] = []): ConversationRepository & { saved: Map<string, Conversation>; navigation?: NavigationSnapshot } {
  const repository = {
    saved: new Map(initial.map(conversation => [conversation.id, structuredClone(conversation)])),
    navigation: undefined as NavigationSnapshot | undefined,
    load: vi.fn(async () => ({ conversations: [...repository.saved.values()], navigation: repository.navigation, imported: true })),
    save: vi.fn(async (conversation: Conversation) => { repository.saved.set(conversation.id, structuredClone(conversation)); }),
    remove: vi.fn(async (ids: string[]) => { for (const id of ids) repository.saved.delete(id); }),
    navigate: vi.fn(async (navigation: NavigationSnapshot) => { repository.navigation = structuredClone(navigation); }),
    import: vi.fn(async (conversations: Conversation[]) => { for (const conversation of conversations) repository.saved.set(conversation.id, structuredClone(conversation)); }),
    clear: vi.fn(async () => { repository.saved.clear(); }),
  };
  return repository;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
