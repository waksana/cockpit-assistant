import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import type { ModuleResponse } from '@waksana/cockpit-module-sdk/backend';
import type { AssistantService } from './service.ts';
import { requireFact } from './errors.ts';
import type { Message } from './types.ts';

export function publicationStream(service: AssistantService, after: number, signal: AbortSignal,
  map?: (message: Message) => unknown): ModuleResponse {
  requireFact(Number.isSafeInteger(after) && after >= 0, 'PAGINATION', 'Event cursor must be a nonnegative integer', 400);
  const stream = Readable.from((async function* () {
    let cursor = after;
    let heartbeat = Date.now();
    while (!signal.aborted) {
      const page = service.db.messagePage('after', cursor, 20);
      for (const publication of page.items) {
        if (signal.aborted) return;
        yield `id: ${publication.revision}\nevent: publication\ndata: ${JSON.stringify(map ? map(publication) : publication)}\n\n`;
      }
      cursor = page.cursor ?? cursor;
      if (page.hasMore) continue;
      if (Date.now() - heartbeat >= 15_000) {
        yield ': keepalive\n\n';
        heartbeat = Date.now();
      }
      try {
        await setTimeout(500, undefined, { signal });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && signal.aborted) return;
        throw error;
      }
    }
  })(), { highWaterMark: 1 });
  return { status: 200, headers: {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  }, body: stream };
}
