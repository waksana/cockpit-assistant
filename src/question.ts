import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';

/** Compare native optional fields by their meaning, not by their JS property presence. */
export function questionIdentity(request: AskRequest | null | undefined) {
  return request ? {
    requestId: request.requestId,
    question: request.question,
    choices: request.choices ?? [],
    allowFreeform: request.allowFreeform !== false,
  } : null;
}
