import { isAbsolute } from 'node:path';
import { inspect, migrate } from '../src/migration.ts';

const [phase, root, ...extra] = process.argv.slice(2);
if (!['preflight', 'apply'].includes(phase) || !root || !isAbsolute(root) || extra.length) {
  throw new Error('Usage: migrate.js <preflight|apply> <absolute-module-data-root>');
}
console.log(JSON.stringify(phase === 'preflight' ? inspect(root) : migrate(root)));
