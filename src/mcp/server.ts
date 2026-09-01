/**
 * The stdio MCP server — the copilot's only remote surface.
 *
 * Four tools, each a thin adapter over work that already exists: the Day 2
 * inspector, query/cache comparator, Day 2 patcher, and the Day 3 graph. The
 * adapters do exactly two things the in-process functions can't: they carry the cache snapshot
 * across the JSON boundary (a stdio server has no live `InMemoryCache`), and
 * they render results as both text and `structuredContent`, so a model reads
 * the summary while a program reads the data.
 *
 * Every tool declares its Zod schema on both sides, so a malformed payload is
 * rejected by the SDK before a handler runs, and a handler that drifts from its
 * contract fails loudly here rather than silently downstream.
 */

import type { NormalizedCacheObject } from '@apollo/client';
// Explicit `/index.js`: Apollo 3.x ships no `exports` map, so the bare
// `@apollo/client/cache` specifier is a directory import — which real Node ESM
// rejects even though bundlers resolve it. Only the stdio binary notices.
import { InMemoryCache } from '@apollo/client/cache/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { cacheAgentGraph } from '../agent/graph.js';
import {
  CompareQueryToCacheInputSchema,
  CompareQueryToCacheOutputSchema,
  DiagnoseCacheGraphInputSchema,
  DiagnoseCacheGraphOutputSchema,
  InspectDanglingRefsInputSchema,
  InspectDanglingRefsOutputSchema,
  PatchCacheMcpInputSchema,
  PatchCacheMcpOutputSchema,
  type CompareQueryToCacheOutput,
  type DiagnoseCacheGraphOutput,
  type Finding,
  type InspectDanglingRefsOutput,
  type PatchCacheMcpOutput,
} from '../schemas/tools.js';
import { compareQueryToCache } from '../tools/compareQueryToCache.js';
import { inspectDanglingRefs } from '../tools/inspectDanglingRefs.js';
import { patchCache } from '../tools/patchCache.js';

export const SERVER_NAME = 'apollo-cache-copilot';
export const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/**
 * Pair a human-readable line with the machine-readable payload.
 *
 * MCP clients that don't understand `structuredContent` still get the JSON in
 * `content`, so the tool degrades to something usable rather than to nothing.
 */
function result<T>(summary: string, structured: T) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: JSON.stringify(structured, null, 2) },
    ],
    structuredContent: structured as Record<string, unknown>,
  };
}

function findingsSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings: every ref resolves and every object is keyable.';

  const counts = new Map<Finding['kind'], number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);

  const parts = [...counts].map(([kind, n]) => `${n} ${kind}`);
  return `${findings.length} finding(s): ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Tool bodies — exported so tests can hit them without a transport
// ---------------------------------------------------------------------------

export function runInspectDanglingRefs(args: unknown): InspectDanglingRefsOutput {
  return inspectDanglingRefs(args);
}

export function runCompareQueryToCache(args: unknown): CompareQueryToCacheOutput {
  return compareQueryToCache(args);
}

/**
 * Restore -> patch -> re-extract.
 *
 * The throwaway `InMemoryCache` is what makes the Day 2 patcher usable over a
 * transport: `cache.modify` needs a real cache to give the modifier its
 * `canRead` / `isReference` helpers, and only Apollo can supply those.
 */
export function runPatchCache(args: unknown): PatchCacheMcpOutput {
  const parsed = PatchCacheMcpInputSchema.parse(args);

  const cache = new InMemoryCache();
  // Zod guarantees "object of objects" but not Apollo's recursive `StoreValue`,
  // which no schema expresses without a lot of noise for no runtime gain. The
  // cast is the seam between the two; the parse above is what actually guards.
  cache.restore(parsed.cache as NormalizedCacheObject);

  // `patchCache` re-parses and ignores the extra `cache` key.
  const output = patchCache(cache, parsed);

  return { ...output, cache: cache.extract() as PatchCacheMcpOutput['cache'] };
}

export async function runDiagnoseCacheGraph(args: unknown): Promise<DiagnoseCacheGraphOutput> {
  const { cache } = DiagnoseCacheGraphInputSchema.parse(args);
  const state = await cacheAgentGraph.invoke({ cacheState: cache as NormalizedCacheObject });

  return {
    findings: state.findings,
    proposedPatches: state.proposedPatches,
    narration: state.messages.map((m) => String(m.content)),
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'inspect_dangling_refs',
    {
      title: 'Inspect dangling refs',
      description:
        'Audit a serialized Apollo InMemoryCache (cache.extract() output) for dangling __refs, ' +
        'unreachable entities, and objects Apollo could not normalize. Read-only.',
      inputSchema: InspectDanglingRefsInputSchema.shape,
      outputSchema: InspectDanglingRefsOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const output = runInspectDanglingRefs(args);
      return result(findingsSummary(output.findings), output);
    },
  );

  server.registerTool(
    'compare_query_to_cache',
    {
      title: 'Compare query to cache',
      description:
        'Run an Apollo query read against a serialized cache and report whether it is complete, ' +
        'which fields were satisfied, and which paths were missing/dangling/not-normalized.',
      inputSchema: CompareQueryToCacheInputSchema.shape,
      outputSchema: CompareQueryToCacheOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const output = runCompareQueryToCache(args);
      const summary = output.complete
        ? `Cache fully satisfies the query (${output.satisfiedFields.length} field path(s) satisfied).`
        : `Cache miss: ${output.misses.length} missing field path(s), ${output.satisfiedFields.length} satisfied.`;
      return result(summary, output);
    },
  );

  server.registerTool(
    'patch_cache',
    {
      title: 'Patch cache',
      description:
        'Apply declarative repairs (modify / evict, optional gc) to a serialized cache and return ' +
        'the patched store. Set dryRun to validate the operations without changing anything.',
      inputSchema: PatchCacheMcpInputSchema.shape,
      outputSchema: PatchCacheMcpOutputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (args) => {
      const output = runPatchCache(args);
      const changed = output.results.filter((r) => r.changed).length;
      const failed = output.results.filter((r) => r.error !== undefined).length;

      const summary = output.dryRun
        ? `Dry run: ${output.results.length} operation(s) validated, cache untouched.`
        : `${changed}/${output.results.length} operation(s) changed the cache` +
          (failed ? `, ${failed} failed` : '') +
          (output.collected.length ? `; gc collected ${output.collected.length}` : '') +
          '.';

      return result(summary, output);
    },
  );

  server.registerTool(
    'diagnose_cache_graph',
    {
      title: 'Diagnose cache graph',
      description:
        'Run the full inspect -> reason -> plan graph over a serialized cache. Returns findings, ' +
        'the proposed patch operations (feed them to patch_cache), and per-step narration. ' +
        'Plans only; never mutates.',
      inputSchema: DiagnoseCacheGraphInputSchema.shape,
      outputSchema: DiagnoseCacheGraphOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const output = await runDiagnoseCacheGraph(args);
      const summary =
        `${findingsSummary(output.findings)} ` +
        `${output.proposedPatches.length} patch operation(s) proposed.`;

      return result(summary, output);
    },
  );

  return server;
}

/** Wire the server to stdio. The binary in `bin/` is a one-line call to this. */
export async function startStdioServer(): Promise<McpServer> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}
