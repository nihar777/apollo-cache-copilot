#!/usr/bin/env node
/**
 * CLI entry point for apollo-cache-copilot.
 *
 * Subcommands:
 *   apollo-copilot [mcp]              Start the Stdio MCP server (default if no args)
 *   apollo-copilot inspect FILE       Read a JSON cache snapshot and print diagnostics
 *   apollo-copilot install-cursor     Write this server into Cursor's mcp.json
 *   apollo-copilot install-claude     Write this server into Claude Desktop's config
 *
 * All logic lives in dist/; this file only dispatches and handles errors.
 */

import fs from 'fs';
import os from 'os';
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

const SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', '-p', 'apollo-cache-copilot@latest', 'apollo-copilot-mcp'],
};

/**
 * Merge the apollo-cache-copilot server into a client's mcpServers config file,
 * creating the file/dir if needed. Never touches other servers already there.
 */
function registerMcpServer(file, restartHint) {
  const dir = path.dirname(file);

  let config = { mcpServers: {} };
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      console.error(`[apollo-copilot] ${file} has invalid JSON, refusing to overwrite: ${err.message}`);
      process.exit(1);
    }
    if (!config.mcpServers) config.mcpServers = {};
  }

  config.mcpServers['apollo-cache-copilot'] = SERVER_ENTRY;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`[apollo-copilot] registered MCP server → ${file}`);
  console.log(restartHint);
}

function installCursor(scopeArg) {
  const project = scopeArg === '--project';
  const dir = project ? path.join(process.cwd(), '.cursor') : path.join(os.homedir(), '.cursor');
  registerMcpServer(path.join(dir, 'mcp.json'), 'Restart Cursor (or reload window) to pick it up.');
}

function claudeDesktopConfigPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
}

function installClaude() {
  registerMcpServer(claudeDesktopConfigPath(), 'Restart Claude Desktop to pick it up.');
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
  } else if (cmd === 'install-cursor') {
    installCursor(arg);
  } else if (cmd === 'install-claude') {
    installClaude();
  } else {
    console.error(`[apollo-copilot] unknown command: ${cmd}`);
    console.error('Usage:');
    console.error('  apollo-copilot [mcp]              Start MCP server (default)');
    console.error('  apollo-copilot inspect FILE       Diagnose a cache snapshot');
    console.error('  apollo-copilot install-cursor     Register with Cursor (add --project for repo-local)');
    console.error('  apollo-copilot install-claude     Register with Claude Desktop');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[apollo-copilot] unexpected error:', err);
  process.exit(1);
});
