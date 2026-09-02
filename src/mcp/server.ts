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
import { assertHumanApproved, guardToolInput, redactSecrets, wrapUntrusted } from '../security/guardrails.js';
import { compareQueryToCache } from '../tools/compareQueryToCache.js';
import { inspectDanglingRefs } from '../tools/inspectDanglingRefs.js';
import { patchCache } from '../tools/patchCache.js';
import { Tracer, withTracer } from '../telemetry/tracer.js';

export const SERVER_NAME = 'apollo-cache-copilot';
// Duplicated from package.json — importing it would break `rootDir: src`.
// `integration.test.ts` asserts the two agree, so a bump that misses one fails.
export const SERVER_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/**
 * Pair a human-readable line with the machine-readable payload.
 *
 * MCP clients that don't understand `structuredContent` still get the JSON in
 * `content`, so the tool degrades to something usable rather than to nothing.
 *
 * The JSON block is wrapped in `<user_input>` boundary markers: it can embed
 * attacker-controlled substrings verbatim (a finding's `path`, the graph's
 * narration — both quote store keys straight out of the snapshot), and this
 * is the text an MCP client's model actually reads back as context. The
 * marker lets that model tell "data to inspect" from "instructions to
 * follow". `summary` is always template text (counts and enum names only,
 * see `findingsSummary`) so it's left unwrapped. Exported so tests can assert
 * the wrapping without standing up a transport.
 */
export function buildToolResult<T>(summary: string, structured: T) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: wrapUntrusted(JSON.stringify(structured, null, 2)) },
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
  guardToolInput('inspect_dangling_refs', args);
  // Findings embed store keys verbatim (`me({"authToken":"..."})`), and those
  // strings are what a model reads. Stats are numbers; nothing to scrub there.
  const output = inspectDanglingRefs(args);
  return { ...output, findings: redactSecrets(output.findings) };
}

export function runCompareQueryToCache(args: unknown): CompareQueryToCacheOutput {
  guardToolInput('compare_query_to_cache', args);
  // `misses` entries quote store keys and field paths back out of the cache,
  // same shape as `inspectDanglingRefs`'s findings — same scrub.
  const output = compareQueryToCache(args);
  return { ...output, misses: redactSecrets(output.misses) };
}

/**
 * Restore -> patch -> re-extract.
 *
 * The throwaway `InMemoryCache` is what makes the Day 2 patcher usable over a
 * transport: `cache.modify` needs a real cache to give the modifier its
 * `canRead` / `isReference` helpers, and only Apollo can supply those.
 */
export function runPatchCache(args: unknown): PatchCacheMcpOutput {
  // Ahead of the parse: `cache.restore()` below is an assignment site, and a
  // `__proto__` key survives `JSON.parse` as a real own property.
  guardToolInput('patch_cache', args);

  const parsed = PatchCacheMcpInputSchema.parse(args);
  assertHumanApproved(parsed.operations, parsed.approved, parsed.dryRun);

  const cache = new InMemoryCache();
  // Zod guarantees "object of objects" but not Apollo's recursive `StoreValue`,
  // which no schema expresses without a lot of noise for no runtime gain. The
  // cast is the seam between the two; the parse above is what actually guards.
  cache.restore(parsed.cache as NormalizedCacheObject);

  const tracer = new Tracer();
  // `patchCache` re-parses and ignores the extra `cache` key.
  const output = tracer.measure('patchCache', () => patchCache(cache, parsed), {
    entityCount: (r) => r.results.length,
  });

  // `cache` and the echoed `operations` go back verbatim: that store is the
  // caller's own, bound for `cache.restore()`, and a redacted value there is
  // data corruption rather than a safety win. Per-op `error` strings and the
  // trace are derived text, so those get scrubbed.
  return {
    ...output,
    results: output.results.map((r) =>
      r.error === undefined ? r : { ...r, error: redactSecrets(r.error) },
    ),
    cache: cache.extract() as PatchCacheMcpOutput['cache'],
    trace: redactSecrets(tracer.export()),
  };
}

export async function runDiagnoseCacheGraph(args: unknown): Promise<DiagnoseCacheGraphOutput> {
  guardToolInput('diagnose_cache_graph', args);

  const { cache } = DiagnoseCacheGraphInputSchema.parse(args);

  // `withTracer` puts a fresh tracer on the async context so `inspectorNode` /
  // `reasonerNode` / `patcherNode` — invoked internally by `cacheAgentGraph`,
  // not by us — can record their own spans via `getActiveTracer()`.
  const { result: state, trace } = await withTracer(() =>
    cacheAgentGraph.invoke({ cacheState: cache as NormalizedCacheObject }),
  );

  // Findings, narration and trace all quote store keys and field names back at
  // the caller; `proposedPatches` is the machine-readable plan that has to feed
  // `patch_cache` unaltered, so it is left alone.
  return {
    findings: redactSecrets(state.findings),
    proposedPatches: state.proposedPatches,
    narration: redactSecrets(state.messages.map((m) => String(m.content))),
    trace: redactSecrets(trace),
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
      return buildToolResult(findingsSummary(output.findings), output);
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
      return buildToolResult(summary, output);
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
      // destructiveHint: the platform-native MCP signal well-behaved clients
      // (Claude Desktop, Claude Code) use to gate a tool call behind their own
      // human-approval UI — on top of, not instead of, the server-side
      // APOLLO_COPILOT_REQUIRE_APPROVAL gate in assertHumanApproved.
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
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

      return buildToolResult(summary, output);
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

      return buildToolResult(summary, output);
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
