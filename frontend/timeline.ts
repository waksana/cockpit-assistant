import type { TimelineItem } from '../src/ui-types.ts';

export function isConversationItem(item: TimelineItem): boolean {
  return item.speaker !== 'system'
    && (item.type === 'message' || item.type === 'question' || item.type === 'clarification');
}

/** Publications remain the cursor authority; this is only their conversation projection. */
export function conversationItems(items: TimelineItem[]): TimelineItem[] {
  const revisions = new Map<string, NonNullable<TimelineItem['revision']>>();
  const questions = new Map<string, TimelineItem['question']>();
  for (const item of items) {
    if (!item.messageId) continue;
    if (item.revision && item.revision.version >= (revisions.get(item.messageId)?.version ?? 0)) {
      revisions.set(item.messageId, item.revision);
    }
    if (item.question && (item.question.stateVersion ?? 0) >= (questions.get(item.messageId)?.stateVersion ?? 0)) {
      questions.set(item.messageId, item.question);
    }
  }
  const visible: TimelineItem[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    if (!isConversationItem(item)) continue;
    let current = item;
    if (item.messageId && item.type !== 'clarification') {
      const revision = revisions.get(item.messageId);
      const publishedVersion = item.sources.find(source => source.messageId === item.messageId)?.version;
      current = { ...item, question: questions.get(item.messageId) ?? item.question,
        ...(revision && publishedVersion !== undefined && revision.version > publishedVersion
          ? { text: revision.text, attachments: revision.attachments } : {}) };
      const position = positions.get(item.messageId);
      if (position !== undefined) {
        const first = visible[position]!;
        visible[position] = { ...current, id: first.id, sequence: first.sequence, createdAt: first.createdAt };
        continue;
      }
      positions.set(item.messageId, visible.length);
    }
    visible.push(current);
  }
  return visible;
}
