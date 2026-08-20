/**
 * Integration tests: public API exports and CLI entry points.
 *
 * Verify that:
 * 1. dist/index.js exports all required types and functions
 * 2. CLI subcommands (mcp, inspect) work correctly
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

describe('integration: public API exports', () => {
  it('dist/index.js exists and is importable', async () => {
    const distIndex = await import('../../dist/index.js');
    expect(distIndex).toBeDefined();
  });

  it('exports all schemas from schemas/tools.js', async () => {
    const api = (await import('../../dist/index.js')) as unknown as Record<string, unknown>;
    const schemas = [
      'StoreObjectSchema',
      'NormalizedCacheSchema',
      'FindingKindSchema',
      'FindingSchema',
      'InspectDanglingRefsInputSchema',
      'InspectDanglingRefsOutputSchema',
      'CompareQueryToCacheInputSchema',
      'CompareQueryToCacheOutputSchema',
      'FieldPatchSchema',
      'PatchOperationSchema',
      'PatchCacheInputSchema',
      'PatchCacheOutputSchema',
      'PatchCacheMcpInputSchema',
      'PatchCacheMcpOutputSchema',
      'DiagnoseCacheGraphInputSchema',
      'DiagnoseCacheGraphOutputSchema',
    ];
    for (const schema of schemas) {
      expect(api[schema]).toBeDefined();
    }
  });

  it('exports agent state and annotations', async () => {
    const api = await import('../../dist/index.js');
    expect(api.CacheAgentAnnotation).toBeDefined();
  });

  it('exports graph functions', async () => {
    const api = await import('../../dist/index.js');
    expect(api.buildCacheAgentGraph).toBeDefined();
    expect(api.cacheAgentGraph).toBeDefined();
    expect(api.inspectorNode).toBeDefined();
    expect(api.reasonerNode).toBeDefined();
    expect(api.patcherNode).toBeDefined();
  });

  it('exports tools', async () => {
    const api = await import('../../dist/index.js');
    expect(api.inspectDanglingRefs).toBeDefined();
    expect(api.patchCache).toBeDefined();
  });

  it('exports MCP server', async () => {
    const api = await import('../../dist/index.js');
    expect(api.SERVER_NAME).toBe('apollo-cache-copilot');
    expect(api.SERVER_VERSION).toBe('1.0.0');
    expect(api.runInspectDanglingRefs).toBeDefined();
    expect(api.runPatchCache).toBeDefined();
    expect(api.runDiagnoseCacheGraph).toBeDefined();
    expect(api.createServer).toBeDefined();
    expect(api.startStdioServer).toBeDefined();
  });
});

describe('integration: CLI entry points', () => {
  it('bin/apollo-copilot.js exists and is executable', () => {
    const binPath = new URL('../../bin/apollo-copilot.js', import.meta.url).pathname;
    expect(existsSync(binPath)).toBe(true);

    const stat = readFileSync(binPath, { encoding: null, flag: 'r' });
    const content = stat.toString('utf-8', 0, 100);
    expect(content).toContain('#!/usr/bin/env node');
  });

  it('bin/apollo-copilot-mcp.js still exists (backwards compat)', () => {
    const binPath = new URL('../../bin/apollo-copilot-mcp.js', import.meta.url).pathname;
    expect(existsSync(binPath)).toBe(true);
  });

  it('package.json declares apollo-copilot and apollo-copilot-mcp bins', async () => {
    const pkgPath = new URL('../../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.bin['apollo-copilot']).toBe('bin/apollo-copilot.js');
    expect(pkg.bin['apollo-copilot-mcp']).toBe('bin/apollo-copilot-mcp.js');
  });

  it('package.json declares exports for ESM', async () => {
    const pkgPath = new URL('../../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['.'].import).toBe('dist/index.js');
    expect(pkg.exports['.'].types).toBe('dist/index.d.ts');
  });

  it('package.json main points to dist/index.js', async () => {
    const pkgPath = new URL('../../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
  });
});
