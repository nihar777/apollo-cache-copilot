#!/usr/bin/env node
/**
 * CLI entry point for apollo-cache-copilot.
 *
 * Subcommands:
 *   apollo-copilot [mcp]          Start the Stdio MCP server (default if no args)
 *   apollo-copilot inspect FILE   Read a JSON cache snapshot and print diagnostics
 *
 * All logic lives in dist/; this file only dispatches and handles errors.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startStdioServer, runInspectDanglingRefs, Tracer, formatTraceSummary } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [_node, _script, command, arg] = process.argv;
const cmd = command?.toLowerCase();

/**
 * Parse a JSON file into a cache snapshot.
 * Exits with code 2 on parse error (following Unix convention for bad input).
 */
async function readCacheSnapshot(filePath) {
  try {
    const fullPath = path.resolve(filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[apollo-copilot] JSON parse error in ${filePath}:`, err.message);
    } else if (err.code === 'ENOENT') {
      console.error(`[apollo-copilot] file not found: ${filePath}`);
    } else if (err.code === 'EACCES') {
      console.error(`[apollo-copilot] permission denied: ${filePath}`);
    } else {
      console.error(`[apollo-copilot] failed to read ${filePath}:`, err.message);
    }
    process.exit(2);
  }
}

/**
 * Format and print diagnostic results.
 */
function printDiagnostic(result) {
  const { findings, stats } = result;

  console.log('\n━━ Cache Diagnostic ━━\n');

  // Stats header
  console.log(`Entities: ${stats.entityCount} | Refs: ${stats.refCount} | ` +
              `Dangling: ${stats.danglingCount} | Unreachable: ${stats.unreachableCount} | ` +
              `Identity risk: ${stats.identityRiskCount}\n`);

  if (findings.length === 0) {
    console.log('✓ Cache is clean: no findings.\n');
    return;
  }

  // Group findings by kind
  const byKind = {};
  for (const f of findings) {
    if (!byKind[f.kind]) byKind[f.kind] = [];
    byKind[f.kind].push(f);
  }

  // Print each kind
  const kinds = ['ORPHANED_REF', 'DANGLING_REF', 'UNREACHABLE_ENTITY', 'MISSING_TYPENAME', 'MISSING_ID', 'UNSCOPED_IDENTITY_FIELD'];
  for (const kind of kinds) {
    if (!byKind[kind]) continue;

    const group = byKind[kind];
    const icon = {
      'ORPHANED_REF': '⚠',
      'DANGLING_REF': '⚠',
      'UNREACHABLE_ENTITY': '🗑',
      'MISSING_TYPENAME': '❌',
      'MISSING_ID': '❌',
      'UNSCOPED_IDENTITY_FIELD': '🔓',
    }[kind] || '?';

    console.log(`${icon}  ${kind} (${group.length})`);
    for (const f of group) {
      console.log(`   • ${f.path}${f.danglingRef ? ` → ${f.danglingRef}` : ''}`);
      if (f.message) console.log(`     ${f.message}`);
    }
    console.log();
  }
}

/**
 * Main entry point.
 */
async function main() {
  if (!cmd || cmd === 'mcp') {
    // Default: start MCP server
    try {
      await startStdioServer();
    } catch (err) {
      console.error('[apollo-copilot] failed to start MCP server:', err.message);
      process.exit(1);
    }
  } else if (cmd === 'inspect') {
    // Inspect subcommand
    if (!arg) {
      console.error('[apollo-copilot] inspect requires a file path');
      console.error('Usage: apollo-copilot inspect <cache-snapshot.json>');
      process.exit(2);
    }

    try {
      const cache = await readCacheSnapshot(arg);
      const tracer = new Tracer();
      const result = tracer.measure(
        'inspectDanglingRefs',
        () => runInspectDanglingRefs({ cache, includeIdentityRisk: true }),
        { entityCount: (r) => r.findings.length },
      );
      printDiagnostic(result);
      console.log(formatTraceSummary(tracer.export()));
      console.log();
    } catch (err) {
      console.error('[apollo-copilot] inspect failed:', err.message);
      process.exit(1);
    }
  } else {
    console.error(`[apollo-copilot] unknown command: ${cmd}`);
    console.error('Usage:');
    console.error('  apollo-copilot [mcp]          Start MCP server (default)');
    console.error('  apollo-copilot inspect FILE   Diagnose a cache snapshot');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[apollo-copilot] unexpected error:', err);
  process.exit(1);
});
