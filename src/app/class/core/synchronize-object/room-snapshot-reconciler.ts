import { ChatTabList } from '../../chat-tab-list';
import { ObjectContext } from './game-object';
import { ObjectNode } from './object-node';
import { ObjectStore } from './object-store';

const CHAT_TAB_LIST_ALIAS = 'chat-tab-list';
const CHAT_TAB_ALIAS = 'chat-tab';

/**
 * Treats the received chat-tab snapshot as authoritative.
 *
 * Every client creates MainTab/SubTab during bootstrap. When the room owner
 * has already replaced those tabs, a merge-only snapshot leaves the local
 * bootstrap tabs behind. Remove only those local tabs that are absent from
 * the snapshot, without broadcasting deletes or creating tombstones.
 */
export function reconcileChatTabsFromSnapshot(contexts: ObjectContext[]): void {
  if (!Array.isArray(contexts)) return;

  const hasChatTabList = contexts.some(context => context?.aliasName === CHAT_TAB_LIST_ALIAS);
  if (!hasChatTabList) return;

  const incomingTabIdentifiers = new Set(
    contexts
      .filter(context => context?.aliasName === CHAT_TAB_ALIAS && !!context.identifier)
      .map(context => context.identifier)
  );

  const chatTabList = ObjectStore.instance.get<ChatTabList>('ChatTabList');
  if (!chatTabList) return;

  for (const chatTab of chatTabList.chatTabs) {
    if (!incomingTabIdentifiers.has(chatTab.identifier)) removeTreeLocally(chatTab);
  }
}

function removeTreeLocally(node: ObjectNode): void {
  for (const child of node.children) removeTreeLocally(child);
  ObjectStore.instance.remove(node);
}
