/**
 * `patchCache` — apply declarative repairs to a live Apollo cache.
 *
 * The MCP payload can only carry JSON, but `cache.modify` wants functions, so
 * every `FieldPatch` descriptor is rehydrated into a modifier here. Beyond that
 * this is a thin, ordered wrapper over `cache.modify` / `cache.evict`: one op in,
 * one result out, failures recorded rather than thrown so a bad key in the middle
 * of a batch doesn't strand the cache half-patched.
 */

import type { ApolloCache } from '@apollo/client';
import type { Modifier } from '@apollo/client/cache/index.js';

import { assertSafeInput } from '../security/guardrails.js';
import {
  PatchCacheInputSchema,
  type FieldPatch,
  type PatchCacheOutput,
  type PatchOperation,
  type PatchResult,
} from '../schemas/tools.js';

// ---------------------------------------------------------------------------
// Descriptor -> modifier
// ---------------------------------------------------------------------------

/** Rehydrate one JSON `FieldPatch` into the function `cache.modify` expects. */
function toModifier(patch: FieldPatch): Modifier<any> {
  switch (patch.action) {
    case 'DELETE':
      return (_value, { DELETE }) => DELETE;

    case 'INVALIDATE':
      return (_value, { INVALIDATE }) => INVALIDATE;

    case 'SET':
      return () => patch.value;

    case 'PRUNE_DANGLING_REFS':
      return (value, { DELETE, canRead, isReference }) => {
        if (Array.isArray(value)) {
          const kept = value.filter((entry) => !(isReference(entry) && !canRead(entry)));
          // Return the original array when nothing was dropped — a fresh array
          // is a new identity, and Apollo would broadcast a no-op change.
          return kept.length === value.length ? value : kept;
        }
        if (isReference(value) && !canRead(value)) return DELETE;
        return value;
      };
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function applyOperation(cache: ApolloCache<any>, op: PatchOperation): boolean {
  if (op.type === 'evict') {
    return cache.evict({
      id: op.id,
      // Omit rather than pass undefined: `fieldName: undefined` still reads as
      // a field eviction in some Apollo paths.
      ...(op.fieldName !== undefined && { fieldName: op.fieldName }),
      ...(op.args !== undefined && { args: op.args }),
      broadcast: op.broadcast,
    });
  }

  const fields: Record<string, Modifier<any>> = {};
  for (const [name, patch] of Object.entries(op.fields)) {
    fields[name] = toModifier(patch);
  }

  return cache.modify({
    id: op.id,
    broadcast: op.broadcast,
    optimistic: op.optimistic,
    fields,
  });
}

function targetExists(cache: ApolloCache<any>, op: PatchOperation): boolean {
  const optimistic = op.type === 'evict' || op.optimistic;
  return Object.hasOwn(cache.extract(optimistic), op.id);
}

function firstMissingTarget(
  cache: ApolloCache<any>,
  operations: PatchOperation[],
): number | undefined {
  const baseEntities = new Set(Object.keys(cache.extract()));
  const optimisticEntities = new Set(Object.keys(cache.extract(true)));

  for (const [index, operation] of operations.entries()) {
    const entities =
      operation.type === 'evict' || operation.optimistic ? optimisticEntities : baseEntities;
    if (!entities.has(operation.id)) return index;

    if (operation.type === 'evict' && !operation.fieldName) {
      baseEntities.delete(operation.id);
      optimisticEntities.delete(operation.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function patchCache(cache: ApolloCache<any>, input: unknown): PatchCacheOutput {
  // Guarded here, not only at the MCP boundary, because this is a public export
  // and `fields[name] = toModifier(patch)` below assigns at a caller-supplied
  // key. Only `operations` is walked: the MCP adapter passes its whole payload
  // through, and re-walking a large snapshot it has already checked is wasted
  // work on every patch call.
  if (typeof input === 'object' && input !== null && 'operations' in input) {
    assertSafeInput((input as { operations: unknown }).operations, { label: 'operations' });
  }

  const args = PatchCacheInputSchema.parse(input);

  if (args.dryRun) {
    return {
      dryRun: true,
      results: args.operations.map((operation) => ({
        operation,
        changed: false,
        ...(!targetExists(cache, operation) && { error: 'entity not found' }),
      })),
      collected: [],
    };
  }

  if (args.atomic) {
    const missingIndex = firstMissingTarget(cache, args.operations);
    if (missingIndex !== undefined) {
      return {
        dryRun: false,
        results: args.operations.slice(0, missingIndex + 1).map((operation, index) => ({
          operation,
          changed: false,
          ...(index === missingIndex && { error: 'entity not found' }),
        })),
        collected: [],
      };
    }
  }

  // ponytail: whole-cache snapshot, O(cache size); fine for opt-in repair batches.
  const snapshot = args.atomic ? cache.extract() : undefined;

  const results: PatchResult[] = [];
  for (const operation of args.operations) {
    try {
      if (!targetExists(cache, operation)) {
        results.push({ operation, changed: false, error: 'entity not found' });
        if (snapshot !== undefined) {
          // Atomic: undo everything applied so far and stop.
          cache.restore(snapshot);
          for (const r of results) r.changed = false;
          return { dryRun: false, results, collected: [] };
        }
        continue;
      }
      results.push({ operation, changed: applyOperation(cache, operation) });
    } catch (err) {
      results.push({ operation, changed: false, error: String(err) });
      if (snapshot !== undefined) {
        // Atomic: undo everything applied so far and stop.
        cache.restore(snapshot);
        for (const r of results) r.changed = false;
        return { dryRun: false, results, collected: [] };
      }
      // Best-effort: keep going, the remaining ops may be independent repairs.
    }
  }

  // `gc` is optional on custom ApolloCache implementations.
  const collected =
    args.gc && typeof cache.gc === 'function' ? cache.gc() : [];

  return { dryRun: false, results, collected };
}
