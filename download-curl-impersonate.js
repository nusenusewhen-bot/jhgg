#!/usr/bin/env node
// No-op: curl-impersonate binary is optional.
// The app falls back to system curl automatically.
console.log('[postinstall] curl-impersonate download skipped — using system curl fallback');
process.exit(0);
