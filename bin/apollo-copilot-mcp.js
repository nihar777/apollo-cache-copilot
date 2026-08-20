#!/usr/bin/env node
/**
 * Executable entry point for the MCP server.
 *
 * Kept as hand-written JS outside `src` so the shebang and the `bin` mapping
 * point at a stable path that `tsc` never rewrites. All logic lives in
 * `dist/mcp/server.js`; this file only starts it and reports a failure.
 *
 * Nothing may write to stdout except the transport — stdout IS the protocol
 * channel — so diagnostics go to stderr.
 */

import { startStdioServer } from '../dist/mcp/server.js';

startStdioServer().catch((err) => {
  console.error('[apollo-cache-copilot] failed to start:', err);
  process.exit(1);
});
