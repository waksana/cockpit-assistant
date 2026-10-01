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
} as const;
