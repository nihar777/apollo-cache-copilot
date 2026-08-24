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
export const StoreObjectSchema = z
  .record(z.string(), z.unknown())
  .describe('One normalized store entry: the raw field/value map Apollo keeps under a single cache key.');

/** The shape `InMemoryCache.extract()` returns. */
export const NormalizedCacheSchema = z
  .record(z.string(), StoreObjectSchema)
  .describe(
    'The full serialized cache, exactly as returned by `cache.extract()`. Keys are cache IDs ' +
      '(e.g. "ROOT_QUERY", "User:1"); values are that entity\'s stored fields, which may contain ' +
      '`{ "__ref": "<cache id>" }` pointers to other entries in this same object.',
  );

export const FindingKindSchema = z.enum([
  'ORPHANED_REF',
  'MISSING_TYPENAME',
  'MISSING_ID',
  'UNREACHABLE_ENTITY',
]);

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  path: z.string().describe('Dotted path to the defect from its cache key, e.g. "User:2.posts.1".'),
  danglingRef: z
    .string()
    .optional()
    .describe('The unresolved cache key the ref pointed at. Only present when kind is ORPHANED_REF.'),
  message: z.string().optional().describe('Human-readable explanation of this finding.'),
});

// ---------------------------------------------------------------------------
// inspectDanglingRefs
// ---------------------------------------------------------------------------

export const InspectDanglingRefsInputSchema = z.object({
  cache: NormalizedCacheSchema,
  rootIds: z
    .array(z.string())
    .optional()
    .describe(
      'Cache IDs to treat as reachability roots for the UNREACHABLE_ENTITY check, e.g. ["ROOT_QUERY"]. ' +
        'Omit to use every one of ROOT_QUERY / ROOT_MUTATION / ROOT_SUBSCRIPTION that is present in `cache`. ' +
        'Has no effect on ORPHANED_REF or normalization-gap findings.',
    ),
  includeUnreachable: z
    .boolean()
    .default(true)
    .describe(
      'Include UNREACHABLE_ENTITY findings for entities no root can reach (candidates `cache.gc()` would ' +
        'collect). Set false to skip reachability analysis and only check refs/normalization.',
    ),
  includeNormalizationGaps: z
    .boolean()
    .default(true)
    .describe(
      'Include MISSING_TYPENAME / MISSING_ID findings for inline (non-entity) objects that Apollo could not ' +
        'normalize because they lack a `__typename` or an `id`/`_id` field.',
    ),
});

export const InspectDanglingRefsOutputSchema = z.object({
  findings: z.array(FindingSchema).describe('Every defect found, in walk order.'),
  stats: z
    .object({
      entityCount: z.number().int().describe('Total cache keys in the input.'),
      refCount: z.number().int().describe('Total `__ref` pointers encountered.'),
      danglingCount: z.number().int().describe('Of those refs, how many did not resolve.'),
      unreachableCount: z.number().int().describe('Entities no root reaches.'),
    })
    .describe('Aggregate counts over the whole cache, independent of the findings list.'),
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
  z.object({ action: z.literal('DELETE') }).describe('Remove this field from the entity entirely.'),
  z
    .object({ action: z.literal('INVALIDATE') })
    .describe('Mark this field stale so Apollo refetches it, without removing or changing its value.'),
  z
    .object({ action: z.literal('SET'), value: z.unknown() })
    .describe('Overwrite this field with `value` (any JSON — a scalar, object, or `{ "__ref": "<cache id>" }`).'),
  z
    .object({ action: z.literal('PRUNE_DANGLING_REFS') })
    .describe(
      'Drop any `__ref` pointer(s) this field holds that no longer resolve to an entity in the cache. ' +
        'Works on a single ref or a list of refs; refs that still resolve are left untouched.',
    ),
]);

export const PatchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('modify'),
    id: z
      .string()
      .default('ROOT_QUERY')
      .describe('Cache key of the entity to modify, e.g. "User:2". Defaults to "ROOT_QUERY" if omitted.'),
    fields: z
      .record(z.string(), FieldPatchSchema)
      .describe('Map of field name -> FieldPatch describing how to change that one field.'),
    optimistic: z
      .boolean()
      .default(false)
      .describe('Apply against the optimistic layer instead of the base cache. Mirrors `cache.modify`\'s option.'),
    broadcast: z
      .boolean()
      .default(true)
      .describe('Notify active queries/subscriptions of this change. Set false to patch silently.'),
  }),
  z.object({
    type: z.literal('evict'),
    id: z.string().describe('Cache key of the entity to evict, e.g. "Post:5".'),
    fieldName: z
      .string()
      .optional()
      .describe('Evict only this one field instead of the whole entity at `id`.'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Field arguments to match when evicting a specific parameterized field (used with `fieldName`).'),
    broadcast: z
      .boolean()
      .default(true)
      .describe('Notify active queries/subscriptions of this eviction. Set false to patch silently.'),
  }),
]);

export const PatchCacheInputSchema = z.object({
  operations: z
    .array(PatchOperationSchema)
    .min(1)
    .describe('One or more modify/evict operations to apply, in order.'),
  gc: z
    .boolean()
    .default(false)
    .describe('Run `cache.gc()` once after all operations land, to collect anything the patches orphaned.'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Validate `operations` and report what would happen without mutating the cache.'),
});

export const PatchResultSchema = z.object({
  operation: PatchOperationSchema.describe('The operation this result is reporting on, echoed back.'),
  changed: z.boolean().describe('Whether `cache.modify` / `cache.evict` actually changed anything.'),
  error: z.string().optional().describe('Set when this one operation failed; the rest of the batch still ran.'),
});

export const PatchCacheOutputSchema = z.object({
  dryRun: z.boolean().describe('Echoes the request\'s dryRun — true means the cache was not actually touched.'),
  results: z.array(PatchResultSchema).describe('One result per input operation, in the same order.'),
  collected: z.array(z.string()).describe('Cache keys removed by the trailing `gc()`, when it ran.'),
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
  cache: NormalizedCacheSchema.describe('The store after the operations landed. Unchanged when `dryRun` is true.'),
});

/** `diagnose_cache_graph` — the Day 3 graph's single input channel. */
export const DiagnoseCacheGraphInputSchema = z.object({
  cache: NormalizedCacheSchema,
});

export const DiagnoseCacheGraphOutputSchema = z.object({
  findings: z.array(FindingSchema).describe('Every defect the inspector found in `cache`.'),
  proposedPatches: z
    .array(PatchOperationSchema)
    .describe('Mechanically-derived fixes for the fixable findings, ready to pass to patch_cache as-is.'),
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
