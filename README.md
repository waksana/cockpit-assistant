# Cockpit Assistant

Assistant is a trusted, backend-only Cockpit module for durable topic-based
conversation across explicitly enrolled native sessions. It does not require
Task, replace native history, or install a frontend.

The coordinator classifies inputs and reception outputs; the program validates,
persists, sends, and publishes them. A separate memory role extracts versioned,
source-bound memory on topic changes. Neither internal role is a receptionist.

## Development

Use Linux and Node.js 24. Authenticate to GitHub Packages with a token authorized
to read `@waksana/cockpit-module-sdk`, supplied as `NODE_AUTH_TOKEN`; never put a
token in a repository file.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run pack:check
```

Dependencies and the public SDK are pinned exactly. The backend is bundled into
one ESM entry; the host does not install dependencies. Native SQLite and standard
Node modules are provided by Node.js. Tests use temporary databases and synthetic
native adapters, not production sessions.

See [architecture and reliability](docs/architecture.md) and the role protocols
in [coordinator](roles/coordinator.md) and [memory](roles/memory.md).

This repository does not automatically publish, install, deploy, or restart
anything. Its CI is independent of Cockpit's other products' release pipelines.
The initial backend implementation is tracked in
[issue #1](https://github.com/waksana/cockpit-assistant/issues/1).
