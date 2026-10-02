import { runNativeCheck } from './native-evidence-check.mjs';

// Ordinary session creation and original-ID cold resume are Host operations.
// --restart opts into a separate complete-Host-process consumer fixture.
// The default retains the original cold-session regression coverage.
await runNativeCheck(process.argv.includes('--restart') ? 'restart' : 'session');
