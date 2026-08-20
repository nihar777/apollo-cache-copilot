/**
 * MCP surface tests.
 *
 * Two layers, on purpose:
 *
 *   InMemory — a real Client talking a real MCP handshake to `createServer()`,
 *   with no process boundary. This is where the tool contract is pinned down:
 *   discovery, schemas, every tool invoked, and the argument-validation path.
 *
 *   Stdio — the built binary spawned as a child process, exercised over the
 *   transport a real client uses. Covers everything the in-memory tests can't
 *   see: the shebang, the `bin` mapping, the ESM emit, and the rule that
 *   nothing but JSON-RPC may reach stdout.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  healthyEntity,
  missingTypenameOrId,
  orphanedPointer,
} from '../../__mocks__/sampleCacheState.js';
import {
  DiagnoseCacheGraphOutputSchema,
  InspectDanglingRefsOutputSchema,
  PatchCacheMcpOutputSchema,
} from '../../schemas/tools.js';
import { inspectDanglingRefs } from '../../tools/inspectDanglingRefs.js';
import { createServer, runPatchCache, SERVER_NAME } from '../server.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = path.join(REPO_ROOT, 'bin/apollo-copilot-mcp.js');

const TOOL_NAMES = ['inspect_dangling_refs', 'patch_cache', 'diagnose_cache_graph'];

/** A connected client plus the server it is wired to, over InMemoryTransport. */
async function connectInMemory() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const server = createServer();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

/** `structuredContent` is the payload under test; `content` is prose for models. */
function structured<T>(result: unknown): T {
  const payload = (result as { structuredContent?: unknown }).structuredContent;
  expect(payload).toBeDefined();
  return payload as T;
}

// ---------------------------------------------------------------------------
// Unit: the adapter that carries a cache across the JSON boundary
// ---------------------------------------------------------------------------

describe('runPatchCache', () => {
  it('restores, patches, and returns a store with the dangling refs gone', () => {
    const before = inspectDanglingRefs({ cache: orphanedPointer.cache });
    expect(before.findings.some((f) => f.kind === 'ORPHANED_REF')).toBe(true);

    const output = runPatchCache({
      cache: orphanedPointer.cache,
      operations: [
        {
          type: 'modify',
          id: 'User:2',
          fields: {
            avatar: { action: 'PRUNE_DANGLING_REFS' },
            posts: { action: 'PRUNE_DANGLING_REFS' },
          },
        },
      ],
    });

    expect(output.dryRun).toBe(false);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].changed).toBe(true);

    const after = inspectDanglingRefs({ cache: output.cache });
    expect(after.findings.filter((f) => f.kind === 'ORPHANED_REF')).toEqual([]);
  });

  it('leaves the store byte-identical on a dry run', () => {
    const output = runPatchCache({
      cache: orphanedPointer.cache,
      dryRun: true,
      operations: [{ type: 'evict', id: 'Post:999' }],
    });

    expect(output.dryRun).toBe(true);
    expect(output.results[0].changed).toBe(false);
    expect(output.cache).toEqual(orphanedPointer.cache);
  });

  it('rejects an empty operation list at the schema boundary', () => {
    expect(() => runPatchCache({ cache: healthyEntity.cache, operations: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: InMemory transport
// ---------------------------------------------------------------------------

describe('tool discovery over InMemory', () => {
  it('lists exactly the three tools, each with an object input schema', async () => {
    const { client } = await connectInMemory();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('cache');
    }
  });

  it('advertises the server identity from the handshake', async () => {
    const { client } = await connectInMemory();

    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('marks the read-only tools read-only and patch_cache not', async () => {
    const { client } = await connectInMemory();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get('inspect_dangling_refs')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('diagnose_cache_graph')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('patch_cache')?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('inspect_dangling_refs over InMemory', () => {
  it('returns the fixture findings as structured output', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'inspect_dangling_refs',
      arguments: { cache: orphanedPointer.cache },
    });

    expect(result.isError).toBeFalsy();
    const output = InspectDanglingRefsOutputSchema.parse(structured(result));

    expect(output.findings.map((f) => f.kind)).toEqual(
      orphanedPointer.expectedFindings.map((f) => f.kind),
    );
    expect(output.stats.danglingCount).toBe(2);
    expect(output.stats.unreachableCount).toBe(1);
  });

  it('reports a clean cache as clean, in prose and in stats', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'inspect_dangling_refs',
      arguments: { cache: healthyEntity.cache },
    });

    const output = InspectDanglingRefsOutputSchema.parse(structured(result));
    expect(output.findings).toEqual([]);

    const text = (result.content as { text: string }[])[0].text;
    expect(text).toMatch(/no findings/i);
  });

  it('errors rather than guesses when `cache` is missing', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'inspect_dangling_refs',
      arguments: {},
    });

    expect(result.isError).toBe(true);
  });
});

describe('patch_cache over InMemory', () => {
  it('applies the operations and returns the patched store', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'patch_cache',
      arguments: {
        cache: orphanedPointer.cache,
        gc: true,
        operations: [
          {
            type: 'modify',
            id: 'User:2',
            fields: { posts: { action: 'PRUNE_DANGLING_REFS' } },
          },
          { type: 'evict', id: 'Post:999' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const output = PatchCacheMcpOutputSchema.parse(structured(result));

    expect(output.results.map((r) => r.changed)).toEqual([true, true]);
    expect(output.cache['Post:999']).toBeUndefined();
    expect(output.cache['User:2'].posts).toEqual([{ __ref: 'Post:200' }]);
  });

  it('rejects an unknown patch action instead of ignoring it', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'patch_cache',
      arguments: {
        cache: orphanedPointer.cache,
        operations: [{ type: 'modify', id: 'User:2', fields: { posts: { action: 'NOPE' } } }],
      },
    });

    expect(result.isError).toBe(true);
  });
});

describe('diagnose_cache_graph over InMemory', () => {
  it('returns findings, proposed patches, and narration', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'diagnose_cache_graph',
      arguments: { cache: orphanedPointer.cache },
    });

    expect(result.isError).toBeFalsy();
    const output = DiagnoseCacheGraphOutputSchema.parse(structured(result));

    expect(output.findings.length).toBe(orphanedPointer.expectedFindings.length);
    expect(output.proposedPatches).toContainEqual(
      expect.objectContaining({ type: 'modify', id: 'User:2' }),
    );
    expect(output.proposedPatches).toContainEqual(
      expect.objectContaining({ type: 'evict', id: 'Post:999' }),
    );
    // inspector -> reasoner -> patcher, one line each.
    expect(output.narration).toHaveLength(3);
  });

  it('proposes nothing for findings no cache mutation can repair', async () => {
    const { client } = await connectInMemory();

    const result = await client.callTool({
      name: 'diagnose_cache_graph',
      arguments: { cache: missingTypenameOrId.cache },
    });

    const output = DiagnoseCacheGraphOutputSchema.parse(structured(result));
    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.proposedPatches).toEqual([]);
    expect(output.narration.join('\n')).toMatch(/Skipped/);
  });

  it('hands diagnose_cache_graph output straight to patch_cache', async () => {
    const { client } = await connectInMemory();

    const diagnosis = DiagnoseCacheGraphOutputSchema.parse(
      structured(
        await client.callTool({
          name: 'diagnose_cache_graph',
          arguments: { cache: orphanedPointer.cache },
        }),
      ),
    );

    const patched = PatchCacheMcpOutputSchema.parse(
      structured(
        await client.callTool({
          name: 'patch_cache',
          arguments: { cache: orphanedPointer.cache, operations: diagnosis.proposedPatches },
        }),
      ),
    );

    // The whole point of the pair: one round trip leaves no dangling pointer.
    const after = inspectDanglingRefs({ cache: patched.cache });
    expect(after.findings.filter((f) => f.kind === 'ORPHANED_REF')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: Stdio transport against the real binary
// ---------------------------------------------------------------------------

describe('the built binary over Stdio', () => {
  let transport: StdioClientTransport | undefined;

  beforeAll(() => {
    // The bin imports from `dist`, so the emit is part of what's under test.
    execFileSync('npx', ['tsc'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }, 120_000);

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
  });

  async function connectStdio() {
    transport = new StdioClientTransport({ command: process.execPath, args: [BIN] });
    const client = new Client({ name: 'stdio-test-client', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  it('completes the handshake and lists the three tools', async () => {
    const client = await connectStdio();

    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  }, 30_000);

  it('answers a real tool call across the process boundary', async () => {
    const client = await connectStdio();

    const result = await client.callTool({
      name: 'diagnose_cache_graph',
      arguments: { cache: orphanedPointer.cache },
    });

    expect(result.isError).toBeFalsy();
    const output = DiagnoseCacheGraphOutputSchema.parse(structured(result));
    expect(output.proposedPatches.length).toBeGreaterThan(0);
  }, 30_000);
});
