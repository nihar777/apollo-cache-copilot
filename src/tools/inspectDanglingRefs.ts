/**
 * `inspectDanglingRefs` — a static audit of a serialized `InMemoryCache`.
 *
 * Apollo fails silently on all three defects this reports: a dangling `__ref`
 * reads back as `undefined` (blank UI, no throw), an unreachable entity just
 * leaks until `gc()`, and an un-keyable inline object renders fine on first
 * paint and then diverges on the second write. So the only way to see them is
 * to walk the extracted store and say so out loud.
 */

import {
  InspectDanglingRefsInputSchema,
  type Finding,
  type InspectDanglingRefsOutput,
} from '../schemas/tools.js';

/** Roots Apollo writes operation results under, when they exist. */
const DEFAULT_ROOT_IDS = ['ROOT_QUERY', 'ROOT_MUTATION', 'ROOT_SUBSCRIPTION'];

/**
 * ROOT_QUERY field names that conventionally carry "who's logged in right
 * now" data. Apollo caches these by field name alone — nothing about the
 * cache key encodes a session or account, so a corrupted identity switch
 * (impersonation, account switch, login/logout without a full reset) can
 * leave one identity's cached value readable by the next.
 */
const DEFAULT_IDENTITY_FIELD_NAMES = ['me', 'viewer', 'currentUser', 'currentAccount', 'session', 'profile'];

/** `user({"id":"1"})` -> `user` — strip Apollo's serialized-args suffix. */
function bareFieldName(storeKeyName: string): string {
  const paren = storeKeyName.indexOf('(');
  return paren === -1 ? storeKeyName : storeKeyName.slice(0, paren);
}

type StoreObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** Plain object test — arrays and null are values, not store objects. */
function isPlainObject(value: unknown): value is StoreObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ __ref: 'User:1' }` — a pointer, never an inline object. */
function refTarget(value: unknown): string | undefined {
  if (isPlainObject(value) && typeof value.__ref === 'string') return value.__ref;
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function inspectDanglingRefs(input: unknown): InspectDanglingRefsOutput {
  const args = InspectDanglingRefsInputSchema.parse(input);
  const { cache, includeUnreachable, includeNormalizationGaps, includeIdentityRisk } = args;
  const identityFieldNames = args.identityFieldNames ?? DEFAULT_IDENTITY_FIELD_NAMES;

  const entityKeys = Object.keys(cache);
  const findings: Finding[] = [];
  let refCount = 0;
  let danglingCount = 0;

  /** Refs found per entity, reused below for reachability (one walk, not two). */
  const outgoingRefs = new Map<string, string[]>();

  for (const entityKey of entityKeys) {
    const refs: string[] = [];

    // `seen` guards against a self-referential value object; entity-to-entity
    // cycles can't happen here because we never follow a `__ref`.
    const seen = new Set<unknown>();

    const walk = (value: unknown, path: string): void => {
      const target = refTarget(value);
      if (target !== undefined) {
        refCount += 1;
        refs.push(target);
        if (!(target in cache)) {
          danglingCount += 1;
          findings.push({
            kind: 'ORPHANED_REF',
            path,
            danglingRef: target,
            message: `Points at "${target}", which is not in the cache. Reads here return undefined.`,
          });
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}.${index}`));
        return;
      }

      if (!isPlainObject(value)) return;
      if (seen.has(value)) return;
      seen.add(value);

      // An empty object carries no evidence either way — don't cry wolf.
      const keys = Object.keys(value);
      if (includeNormalizationGaps && keys.length > 0) {
        if (!('__typename' in value)) {
          findings.push({
            kind: 'MISSING_TYPENAME',
            path,
            message: 'Inline object has no __typename, so Apollo could not normalize it.',
          });
        }
        if (!('id' in value) && !('_id' in value)) {
          findings.push({
            kind: 'MISSING_ID',
            path,
            message: 'Inline object has no id/_id, so Apollo could not normalize it.',
          });
        }
      }

      for (const key of keys) walk(value[key], `${path}.${key}`);
    };

    // The entity itself is keyed by definition — only its fields get the
    // normalization-gap check, so we walk fields rather than the entity.
    const entity = cache[entityKey] as StoreObject;
    for (const key of Object.keys(entity)) walk(entity[key], `${entityKey}.${key}`);

    outgoingRefs.set(entityKey, refs);
  }

  // -------------------------------------------------------------------------
  // Reachability — appended last so per-entity findings stay contiguous
  // -------------------------------------------------------------------------

  let unreachableCount = 0;

  if (includeUnreachable) {
    const roots = args.rootIds ?? DEFAULT_ROOT_IDS.filter((id) => id in cache);
    const reachable = new Set<string>();
    const queue = [...roots];

    while (queue.length > 0) {
      const key = queue.pop() as string;
      if (reachable.has(key)) continue; // visited set is the cycle guard
      reachable.add(key);
      for (const ref of outgoingRefs.get(key) ?? []) queue.push(ref);
    }

    for (const entityKey of entityKeys) {
      if (reachable.has(entityKey)) continue;
      unreachableCount += 1;
      findings.push({
        kind: 'UNREACHABLE_ENTITY',
        path: entityKey,
        message: 'No root reaches this entity; cache.gc() would collect it.',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Identity-scoping risk — naming-convention heuristic, ROOT_QUERY only
  // -------------------------------------------------------------------------

  let identityRiskCount = 0;

  if (includeIdentityRisk) {
    const rootQuery = cache['ROOT_QUERY'] as StoreObject | undefined;
    if (rootQuery) {
      for (const fieldKey of Object.keys(rootQuery)) {
        if (!identityFieldNames.includes(bareFieldName(fieldKey))) continue;
        identityRiskCount += 1;
        findings.push({
          kind: 'UNSCOPED_IDENTITY_FIELD',
          path: `ROOT_QUERY.${fieldKey}`,
          message:
            `"${fieldKey}" looks identity-scoped, but Apollo caches it by field name only — nothing in the ` +
            'key encodes which session wrote it. This is a naming heuristic, not proof of a leak: if you ' +
            'already call client.clearStore() (or use a fresh cache) on every identity switch (impersonation, ' +
            'account switch, login/logout), this is a false positive. If you don\'t, the next identity can ' +
            'read the previous one\'s cached value here — a targeted evict() can\'t guarantee it clears ' +
            'everything an identity switch touched.',
        });
      }
    }
  }

  return {
    findings,
    stats: {
      entityCount: entityKeys.length,
      refCount,
      danglingCount,
      unreachableCount,
      identityRiskCount,
    },
  };
}
