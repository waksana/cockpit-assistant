import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'node_modules/.cache/assistant-browser');
const digest = 'a'.repeat(64);
const assets = `/_modules/assets/assistant/${digest}`;
const files = new Map([
  ['/host.js', [join(output, 'host.js'), 'text/javascript']],
  ['/host.js.map', [join(output, 'host.js.map'), 'application/json']],
  ['/host.css', [join(output, 'host.css'), 'text/css']],
  [`/_modules/assets/synthetic-probe/${digest}/index.js`, [join(output, 'probe.js'), 'text/javascript']],
  [`${assets}/index.js`, [join(root, 'dist/web/index.js'), 'text/javascript']],
  [`${assets}/index.js.map`, [join(root, 'dist/web/index.js.map'), 'application/json']],
  [`${assets}/styles.css`, [join(root, 'dist/web/styles.css'), 'text/css']],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/_modules') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ modules: [{ id: 'assistant', name: 'Assistant', version: '0.1.0',
      digest, config: { protocolVersion: 4 }, styles: [`${assets}/styles.css`],
      apiBase: `/_modules/assistant/${digest}/api`, entry: `${assets}/index.js` },
      { id: 'synthetic-probe', name: 'Synthetic File/Speech probe', version: '0.1.0', digest,
        config: {}, styles: [], apiBase: `/_modules/synthetic-probe/${digest}/api`,
        entry: `/_modules/assets/synthetic-probe/${digest}/index.js` }], errors: [] }));
    return;
  }
  if (url.pathname === `/_modules/assistant/${digest}/api/timeline/stream`) {
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    response.write(': synthetic fixture connected\n\n');
    const heartbeat = setInterval(() => response.write(': synthetic heartbeat\n\n'), 10_000);
    response.on('close', () => clearInterval(heartbeat));
    return;
  }
  const file = files.get(url.pathname);
  if (file) {
    try { response.setHeader('content-type', file[1]); response.end(await readFile(file[0])); }
    catch { response.writeHead(404); response.end('Missing build output; run npm run build and node scripts/browser-build.mjs'); }
    return;
  }
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>Assistant synthetic host</title>
      <link rel="stylesheet" href="/host.css"><style>
        .fixture-header { display:flex; align-items:center; justify-content:space-between; padding:12px; }
        main { padding:24px; }
      </style></head><body><div id="root"></div><script type="module" src="/host.js"></script></body></html>`);
    return;
  }
  response.writeHead(404);
  response.end('No live API exists here; browser tests must intercept synthetic module requests');
});
const port = Number(process.env.ASSISTANT_BROWSER_PORT ?? '4179');
server.listen(port, '127.0.0.1', () => console.log(`Synthetic Assistant host listening at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
