/**
 * Public API barrel: all exports for apollo-cache-copilot.
 *
 * Consumers can import:
 *   - Zod schemas for tool inputs/outputs
 *   - Types for cache state and patches
 *   - The compiled LangGraph agent + state annotations
 *   - In-process tool functions (inspectDanglingRefs, compareQueryToCache, patchCache)
 *   - MCP server factory and stdio runner
 */

// ---------------------------------------------------------------------------
// Zod schemas (validation + type inference)
// ---------------------------------------------------------------------------

export {
  // Primitives
  StoreObjectSchema,
  NormalizedCacheSchema,
  FindingKindSchema,
  FindingSchema,
  // inspectDanglingRefs
  InspectDanglingRefsInputSchema,
  InspectDanglingRefsOutputSchema,
  // compareQueryToCache (future tool)
  CacheMissSchema,
  CompareQueryToCacheInputSchema,
  CompareQueryToCacheOutputSchema,
  // patchCache
  FieldPatchSchema,
  PatchOperationSchema,
  PatchCacheInputSchema,
  PatchResultSchema,
  PatchCacheOutputSchema,
  // MCP surface
  PatchCacheMcpInputSchema,
  PatchCacheMcpOutputSchema,
  DiagnoseCacheGraphInputSchema,
  DiagnoseCacheGraphOutputSchema,
  // Telemetry
  TraceEventSchema,
  TraceExportSchema,
  // Inferred types
  type Finding,
  type FindingKind,
  type InspectDanglingRefsInput,
  type InspectDanglingRefsArgs,
  type InspectDanglingRefsOutput,
  type CompareQueryToCacheInput,
  type CompareQueryToCacheArgs,
  type CompareQueryToCacheOutput,
  type CacheMiss,
  type FieldPatch,
  type PatchOperation,
  type PatchCacheInput,
  type PatchCacheArgs,
  type PatchCacheOutput,
  type PatchResult,
  type PatchCacheMcpInput,
  type PatchCacheMcpOutput,
  type DiagnoseCacheGraphInput,
  type DiagnoseCacheGraphOutput,
} from './schemas/tools.js';

// ---------------------------------------------------------------------------
// Security guardrails
// ---------------------------------------------------------------------------

export {
  GuardrailError,
  MAX_INPUT_DEPTH,
  REDACTED,
  KNOWN_TOOLS,
  KNOWN_OPERATION_TYPES,
  KNOWN_PATCH_ACTIONS,
  TOOL_ALLOWLIST_ENV,
  ACTION_ALLOWLIST_ENV,
  assertSafeInput,
  assertToolAllowed,
  assertOperationsAllowed,
  guardToolInput,
  redactSecrets,
  redactString,
  type GuardrailCode,
  type KnownTool,
  type SanitizeOptions,
} from './security/guardrails.js';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export {
  Tracer,
  getActiveTracer,
  withTracer,
  formatTraceSummary,
  type StepStatus,
  type TraceEvent,
  type TraceExport,
} from './telemetry/tracer.js';

// ---------------------------------------------------------------------------
// Agent state and annotations
// ---------------------------------------------------------------------------

export {
  CacheAgentAnnotation,
  type CacheAgentState,
  type CacheAgentUpdate,
} from './agent/state.js';

// ---------------------------------------------------------------------------
// LangGraph agent and node functions
// ---------------------------------------------------------------------------

export {
  buildCacheAgentGraph,
  cacheAgentGraph,
  inspectorNode,
  reasonerNode,
  patcherNode,
} from './agent/graph.js';

// ---------------------------------------------------------------------------
// In-process tools
// ---------------------------------------------------------------------------

export { inspectDanglingRefs } from './tools/inspectDanglingRefs.js';
export { compareQueryToCache } from './tools/compareQueryToCache.js';
export { patchCache } from './tools/patchCache.js';

// ---------------------------------------------------------------------------
// MCP server (factory + stdio runner)
// ---------------------------------------------------------------------------

export {
  SERVER_NAME,
  SERVER_VERSION,
  runInspectDanglingRefs,
  runCompareQueryToCache,
  runPatchCache,
  runDiagnoseCacheGraph,
  createServer,
  startStdioServer,
} from './mcp/server.js';
