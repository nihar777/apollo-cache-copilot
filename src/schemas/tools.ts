/**
 * Zod input/output contracts for the copilot's MCP tools.
 *
 * Every tool parses its argument object through the schema here before doing
 * any work, so a malformed MCP payload fails at the boundary with a readable
 * path instead of throwing somewhere inside a cache walk.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A single entry in `cache.extract()` output. Values stay `unknown` — the
 *  walker narrows them; validating the whole JSON tree here buys nothing. */
export const StoreObjectSchema = z.record(z.string(), z.unknown());

/** The shape `InMemoryCache.extract()` returns. */
export const NormalizedCacheSchema = z.record(z.string(), StoreObjectSchema);

export const FindingKindSchema = z.enum([
  'ORPHANED_REF',
  'MISSING_TYPENAME',
  'MISSING_ID',
  'UNREACHABLE_ENTITY',
]);

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  /** Dotted path from a cache key, e.g. `User:2.posts.1`. */
  path: z.string(),
  /** Populated for ORPHANED_REF only. */
  danglingRef: z.string().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// inspectDanglingRefs
// ---------------------------------------------------------------------------

export const InspectDanglingRefsInputSchema = z.object({
  cache: NormalizedCacheSchema,
  /** Roots to start reachability from. Defaults to ROOT_QUERY + ROOT_MUTATION. */
  rootIds: z.array(z.string()).optional(),
  /** Report entities no root can reach (gc candidates). */
  includeUnreachable: z.boolean().default(true),
  /** Report inline objects missing __typename / id. */
  includeNormalizationGaps: z.boolean().default(true),
});

export const InspectDanglingRefsOutputSchema = z.object({
  findings: z.array(FindingSchema),
  stats: z.object({
    entityCount: z.number().int(),
    refCount: z.number().int(),
    danglingCount: z.number().int(),
    unreachableCount: z.number().int(),
  }),
});

// ---------------------------------------------------------------------------
// compareQueryToCache
// ---------------------------------------------------------------------------

export const CacheMissSchema = z.object({
  /** Cache key the miss was found under, e.g. `User:2`. */
  entityId: z.string(),
  /** Field path relative to the query root. */
  path: z.string(),
  reason: z.enum(['MISSING_FIELD', 'DANGLING_REF', 'NOT_NORMALIZED']),
  message: z.string().optional(),
});

export const CompareQueryToCacheInputSchema = z.object({
  cache: NormalizedCacheSchema,
  /** GraphQL document source for the query being diagnosed. */
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Cache key to read from. Defaults to ROOT_QUERY. */
  rootId: z.string().default('ROOT_QUERY'),
  /** Mirrors Apollo's `returnPartialData`. */
  returnPartialData: z.boolean().default(true),
});

export const CompareQueryToCacheOutputSchema = z.object({
  complete: z.boolean(),
  misses: z.array(CacheMissSchema),
  /** Fields the query asked for that the cache satisfied. */
  satisfiedFields: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// patchCache
// ---------------------------------------------------------------------------

/**
 * Field-level edits, expressed declaratively so they survive a JSON hop.
 * `cache.modify` takes functions; the tool builds those from these descriptors.
 */
export const FieldPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('DELETE') }),
  z.object({ action: z.literal('INVALIDATE') }),
  z.object({ action: z.literal('SET'), value: z.unknown() }),
  /** Drop dangling `__ref`s from a field holding a list of references. */
  z.object({ action: z.literal('PRUNE_DANGLING_REFS') }),
]);

export const PatchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('modify'),
    /** Cache key, e.g. `User:2`. Defaults to ROOT_QUERY inside Apollo. */
    id: z.string().default('ROOT_QUERY'),
    fields: z.record(z.string(), FieldPatchSchema),
    optimistic: z.boolean().default(false),
    broadcast: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('evict'),
    id: z.string(),
    /** Evict a single field instead of the whole entity. */
    fieldName: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    broadcast: z.boolean().default(true),
  }),
]);

export const PatchCacheInputSchema = z.object({
  operations: z.array(PatchOperationSchema).min(1),
  /** Run `cache.gc()` once after all operations land. */
  gc: z.boolean().default(false),
  /** Validate and report without touching the cache. */
  dryRun: z.boolean().default(false),
});

export const PatchResultSchema = z.object({
  operation: PatchOperationSchema,
  /** What `cache.modify` / `cache.evict` returned. */
  changed: z.boolean(),
  error: z.string().optional(),
});

export const PatchCacheOutputSchema = z.object({
  dryRun: z.boolean(),
  results: z.array(PatchResultSchema),
  /** Cache keys removed by the trailing `gc()`, when it ran. */
  collected: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------

/**
 * `patch_cache` over MCP.
 *
 * `patchCache` mutates a live `ApolloCache`, but a stdio server has no live
 * cache to hand it — only JSON. So the MCP tool carries the snapshot alongside
 * the operations: the server restores it into a throwaway `InMemoryCache`,
 * patches that, and returns the re-extracted store for the caller to compare
 * or restore. Same contract as the in-process tool, plus the cache.
 */
export const PatchCacheMcpInputSchema = PatchCacheInputSchema.extend({
  cache: NormalizedCacheSchema,
});

export const PatchCacheMcpOutputSchema = PatchCacheOutputSchema.extend({
  /** The store after the operations landed. Unchanged when `dryRun`. */
  cache: NormalizedCacheSchema,
});

/** `diagnose_cache_graph` — the Day 3 graph's single input channel. */
export const DiagnoseCacheGraphInputSchema = z.object({
  cache: NormalizedCacheSchema,
});

export const DiagnoseCacheGraphOutputSchema = z.object({
  findings: z.array(FindingSchema),
  proposedPatches: z.array(PatchOperationSchema),
  /** One entry per node that spoke, in visit order. */
  narration: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Finding = z.infer<typeof FindingSchema>;
export type FindingKind = z.infer<typeof FindingKindSchema>;

export type InspectDanglingRefsInput = z.input<typeof InspectDanglingRefsInputSchema>;
export type InspectDanglingRefsArgs = z.output<typeof InspectDanglingRefsInputSchema>;
export type InspectDanglingRefsOutput = z.infer<typeof InspectDanglingRefsOutputSchema>;

export type CompareQueryToCacheInput = z.input<typeof CompareQueryToCacheInputSchema>;
export type CompareQueryToCacheArgs = z.output<typeof CompareQueryToCacheInputSchema>;
export type CompareQueryToCacheOutput = z.infer<typeof CompareQueryToCacheOutputSchema>;
export type CacheMiss = z.infer<typeof CacheMissSchema>;

export type FieldPatch = z.infer<typeof FieldPatchSchema>;
export type PatchOperation = z.infer<typeof PatchOperationSchema>;
export type PatchCacheInput = z.input<typeof PatchCacheInputSchema>;
export type PatchCacheArgs = z.output<typeof PatchCacheInputSchema>;
export type PatchCacheOutput = z.infer<typeof PatchCacheOutputSchema>;
export type PatchResult = z.infer<typeof PatchResultSchema>;

export type PatchCacheMcpInput = z.input<typeof PatchCacheMcpInputSchema>;
export type PatchCacheMcpOutput = z.infer<typeof PatchCacheMcpOutputSchema>;
export type DiagnoseCacheGraphInput = z.input<typeof DiagnoseCacheGraphInputSchema>;
export type DiagnoseCacheGraphOutput = z.infer<typeof DiagnoseCacheGraphOutputSchema>;
