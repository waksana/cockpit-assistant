// Fingerprints of the independently pinned published SQL in scripts/fixtures.
// Only the offline upgrade entry imports these retired layouts.
export const legacySchemas = {
  3: {
    fingerprint: 'ea79ddddd12c989befb682a573c102a951c7e625aacf18e926a377c6c8edb931',
    tables: ['messages', 'topic_messages', 'topics'],
  },
  4: {
    fingerprint: '63da8429ad79f83289d652607271765a2683f5ca52a6f00553263b2224a12352',
    tables: ['foreground_inputs', 'inbox', 'messages', 'tool_actions', 'topic_messages', 'topics', 'workers'],
  },
  5: {
    fingerprint: '6700e3162601bea22cecb2d924ca7426b48fd6cb863390a631c8594b4aac510f',
    tables: ['deliveries', 'mailbox', 'seen', 'topics'],
  },
} as const;
