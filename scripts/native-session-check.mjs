import { runNativeCheck } from './native-evidence-check.mjs';

// Ordinary session creation and original-ID cold resume are Host operations.
await runNativeCheck('session');
