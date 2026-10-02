import { runNativeCheck } from './native-evidence-check.mjs';

// Keep the queued A/B and immediate C/D native regression checks on the public
// Host tools; Assistant is only a directory and source-pointer inbox.
await runNativeCheck('response');
