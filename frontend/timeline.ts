import type { TimelineItem } from '../src/ui-types.ts';

export function isConversationItem(item: TimelineItem): boolean {
  return item.speaker !== 'system'
    && (item.type === 'message' || item.type === 'question');
}

/** Full message snapshots replace older revisions without changing display order. */
export function mergeSnapshots(items: TimelineItem[]): TimelineItem[] {
  const messages = new Map<string, TimelineItem>();
  for (const item of items) {
    const previous = messages.get(item.id);
    if (previous && previous.sequence !== item.sequence) throw new Error('消息显示顺序发生变化');
    if (!previous || (item.snapshotRevision ?? 0) > (previous.snapshotRevision ?? 0)) messages.set(item.id, item);
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

export function conversationItems(items: TimelineItem[]): TimelineItem[] {
  return mergeSnapshots(items).filter(isConversationItem).map(item => item.speaker === 'user'
    ? { ...item, topicId: null, topicTitle: null } : item);
}
