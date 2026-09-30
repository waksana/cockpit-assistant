import type { TimelineItem } from '../src/ui-types.ts';

export function isConversationItem(item: TimelineItem): boolean {
  return item.speaker !== 'system'
    && (item.type === 'message' || item.type === 'question' || item.type === 'clarification');
}

/** Publications remain the cursor authority; this is only their conversation projection. */
export function conversationItems(items: TimelineItem[]): TimelineItem[] {
  const revisions = new Map<string, NonNullable<TimelineItem['revision']>>();
  const questions = new Map<string, TimelineItem['question']>();
  const topics = new Map<string, {
    topicId: string | null; topicTitle: string | null; topicColor: string | null;
    topicAssignmentVersion: number; sequence: number;
  }>();
  for (const item of items) {
    if (!item.messageId) continue;
    if (item.type === 'message' || item.type === 'question' || item.type === 'attribution') {
      const version = item.topicAssignmentVersion
        ?? item.sources.find(source => source.messageId === item.messageId)?.assignmentVersion ?? 0;
      const previous = topics.get(item.messageId);
      if (!previous || version > previous.topicAssignmentVersion
        || (version === previous.topicAssignmentVersion && item.sequence >= previous.sequence)) {
        topics.set(item.messageId, { topicId: item.topicId, topicTitle: item.topicTitle, topicColor: item.topicColor,
          topicAssignmentVersion: version, sequence: item.sequence });
      }
    }
    if (item.revision && item.revision.version >= (revisions.get(item.messageId)?.version ?? 0)) {
      revisions.set(item.messageId, item.revision);
    }
    if (item.question && (item.question.stateVersion ?? 0) >= (questions.get(item.messageId)?.stateVersion ?? 0)) {
      questions.set(item.messageId, item.question);
    }
  }
  const visible: TimelineItem[] = [];
  const positions = new Map<string, number>();
  const publications = new Set<string>();
  for (const item of items) {
    if (!isConversationItem(item) || publications.has(item.id)) continue;
    publications.add(item.id);
    let current = item.speaker === 'user'
      ? { ...item, topicId: null, topicTitle: null, topicColor: null } : item;
    if (item.messageId && item.type !== 'clarification') {
      const revision = revisions.get(item.messageId);
      const topic = topics.get(item.messageId);
      current = { ...current, question: questions.get(item.messageId) ?? item.question,
        ...(item.speaker === 'assistant' && topic ? {
          topicId: topic.topicId, topicTitle: topic.topicTitle, topicColor: topic.topicColor,
          topicAssignmentVersion: topic.topicAssignmentVersion,
        } : {}),
        ...(revision
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
