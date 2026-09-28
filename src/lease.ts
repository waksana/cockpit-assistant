import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { realpath, mkdir } from 'node:fs/promises';
import { requireFact } from './errors.ts';

export async function acquireLease(dataRoot: string): Promise<() => void> {
  requireFact(process.platform === 'linux', 'PLATFORM', 'Assistant durable writer fencing requires Linux');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(dataRoot);
  const hash = createHash('sha256').update(root).digest('hex');
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\0cockpit-assistant-${hash}`, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  return () => server.close();
}
