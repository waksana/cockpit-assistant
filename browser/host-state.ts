// The only replaced host import: no session, native configuration, or live API.
const state = Object.freeze({
  sessions: Object.freeze([]),
  snapshotReady: true,
  connState: 'open',
  canSendDraft: () => { throw new Error('Native draft submission is outside this synthetic fixture'); },
  sendDraft: () => { throw new Error('Native draft submission is outside this synthetic fixture'); },
});
export const useCockpit = {
  getState: () => state,
  subscribe: (_listener: () => void) => () => {},
};
