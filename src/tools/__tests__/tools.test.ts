/**
 * Tool contract tests.
 *
 * The point of this file is the input boundary: every tool must run its
 * argument object through Zod before doing anything, so a malformed MCP payload
 * fails with a readable path instead of a mystery throw inside a cache walk.
 * Behavioural coverage here is deliberately thin — just enough to prove the
 * parsed args reach the implementation.
 */

import { InMemoryCache } from '@apollo/client/cache/index.js';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  fixtures,
  identityRiskField,
  orphanedPointer,
  type ExpectedFinding,
} from '../../__mocks__/sampleCacheState.js';
import {
  CompareQueryToCacheInputSchema,
  FieldPatchSchema,
  InspectDanglingRefsInputSchema,
  PatchCacheInputSchema,
  PatchOperationSchema,
} from '../../schemas/tools.js';
import { inspectDanglingRefs } from '../inspectDanglingRefs.js';
import { compareQueryToCache } from '../compareQueryToCache.js';
import { patchCache } from '../patchCache.js';

/** Minimal cache that satisfies NormalizedCacheSchema. */
const MINIMAL_CACHE = { ROOT_QUERY: { __typename: 'Query' } };

/** Drop `message` so fixtures don't have to duplicate prose. */
function comparable(findings: { kind: string; path: string; danglingRef?: string }[]) {
  return findings.map(({ kind, path, danglingRef }) =>
    danglingRef === undefined ? { kind, path } : { kind, path, danglingRef },
  );
}

function normalizeExpected(expected: ExpectedFinding[]) {
  return comparable(expected);
}

/** The first issue's path, or a marker that reads better than `undefined`. */
function firstIssuePath(fn: () => unknown): (string | number | symbol)[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZodError) return err.issues[0].path;
    throw err;
  }
  throw new Error('expected a ZodError, but nothing was thrown');
}

// ---------------------------------------------------------------------------
// InspectDanglingRefsInputSchema
// ---------------------------------------------------------------------------

describe('InspectDanglingRefsInputSchema', () => {
  it('applies defaults to a minimal input', () => {
    const args = InspectDanglingRefsInputSchema.parse({ cache: MINIMAL_CACHE });

    expect(args.includeUnreachable).toBe(true);
    expect(args.includeNormalizationGaps).toBe(true);
    expect(args.includeIdentityRisk).toBe(false);
    expect(args.rootIds).toBeUndefined();
    expect(args.identityFieldNames).toBeUndefined();
  });

  it('keeps explicit values over defaults', () => {
    const args = InspectDanglingRefsInputSchema.parse({
      cache: MINIMAL_CACHE,
      rootIds: ['ROOT_QUERY'],
      includeUnreachable: false,
      includeNormalizationGaps: false,
      includeIdentityRisk: false,
      identityFieldNames: ['whoami'],
    });

    expect(args).toEqual({
      cache: MINIMAL_CACHE,
      rootIds: ['ROOT_QUERY'],
      includeUnreachable: false,
      includeNormalizationGaps: false,
      includeIdentityRisk: false,
      identityFieldNames: ['whoami'],
    });
  });

  it('rejects a missing cache', () => {
    expect(firstIssuePath(() => InspectDanglingRefsInputSchema.parse({}))).toEqual(['cache']);
  });

  it('rejects a non-object cache', () => {
    expect(
      firstIssuePath(() => InspectDanglingRefsInputSchema.parse({ cache: 'ROOT_QUERY' })),
    ).toEqual(['cache']);
  });

  it('rejects a cache whose entries are not store objects', () => {
    expect(
      firstIssuePath(() => InspectDanglingRefsInputSchema.parse({ cache: { 'User:1': 42 } })),
    ).toEqual(['cache', 'User:1']);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      firstIssuePath(() =>
        InspectDanglingRefsInputSchema.parse({ cache: MINIMAL_CACHE, includeUnreachable: 'yes' }),
      ),
    ).toEqual(['includeUnreachable']);
  });
});

// ---------------------------------------------------------------------------
// CompareQueryToCacheInputSchema
// ---------------------------------------------------------------------------

describe('CompareQueryToCacheInputSchema', () => {
  it('applies defaults to a minimal input', () => {
    const args = CompareQueryToCacheInputSchema.parse({
      cache: MINIMAL_CACHE,
      query: '{ user { id } }',
    });

    expect(args.variables).toEqual({});
    expect(args.rootId).toBe('ROOT_QUERY');
    expect(args.returnPartialData).toBe(true);
  });

  it('keeps explicit values over defaults', () => {
    const args = CompareQueryToCacheInputSchema.parse({
      cache: MINIMAL_CACHE,
      query: '{ user { id } }',
      variables: { id: '2' },
      rootId: 'User:2',
      returnPartialData: false,
    });

    expect(args.variables).toEqual({ id: '2' });
    expect(args.rootId).toBe('User:2');
    expect(args.returnPartialData).toBe(false);
  });

  it('rejects an empty query string', () => {
    expect(
      firstIssuePath(() =>
        CompareQueryToCacheInputSchema.parse({ cache: MINIMAL_CACHE, query: '' }),
      ),
    ).toEqual(['query']);
  });

  it('rejects a missing query', () => {
    expect(
      firstIssuePath(() => CompareQueryToCacheInputSchema.parse({ cache: MINIMAL_CACHE })),
    ).toEqual(['query']);
  });

  it('rejects a non-object cache', () => {
    expect(
      firstIssuePath(() =>
        CompareQueryToCacheInputSchema.parse({ cache: null, query: '{ user { id } }' }),
      ),
    ).toEqual(['cache']);
  });
});

// ---------------------------------------------------------------------------
// FieldPatchSchema / PatchOperationSchema
// ---------------------------------------------------------------------------

describe('FieldPatchSchema', () => {
  it('accepts DELETE', () => {
    expect(FieldPatchSchema.parse({ action: 'DELETE' })).toEqual({ action: 'DELETE' });
  });

  it('accepts INVALIDATE', () => {
    expect(FieldPatchSchema.parse({ action: 'INVALIDATE' })).toEqual({ action: 'INVALIDATE' });
  });

  it('accepts SET with a value', () => {
    expect(FieldPatchSchema.parse({ action: 'SET', value: [1, 'two', null] })).toEqual({
      action: 'SET',
      value: [1, 'two', null],
    });
  });

  it('accepts PRUNE_DANGLING_REFS', () => {
    expect(FieldPatchSchema.parse({ action: 'PRUNE_DANGLING_REFS' })).toEqual({
      action: 'PRUNE_DANGLING_REFS',
    });
  });

  it('rejects an unknown action', () => {
    expect(firstIssuePath(() => FieldPatchSchema.parse({ action: 'NUKE' }))).toEqual(['action']);
  });
});

describe('PatchOperationSchema', () => {
  it('defaults a modify op', () => {
    const op = PatchOperationSchema.parse({
      type: 'modify',
      fields: { avatar: { action: 'DELETE' } },
    });

    expect(op).toEqual({
      type: 'modify',
      id: 'ROOT_QUERY',
      fields: { avatar: { action: 'DELETE' } },
      optimistic: false,
      broadcast: true,
    });
  });

  it('defaults an evict op', () => {
    const op = PatchOperationSchema.parse({ type: 'evict', id: 'Post:999' });

    expect(op).toEqual({ type: 'evict', id: 'Post:999', broadcast: true });
  });

  it('rejects an unknown discriminator value', () => {
    expect(firstIssuePath(() => PatchOperationSchema.parse({ type: 'delete', id: 'User:1' }))).toEqual(
      ['type'],
    );
  });

  it('rejects an evict op with no id', () => {
    expect(firstIssuePath(() => PatchOperationSchema.parse({ type: 'evict' }))).toEqual(['id']);
  });
});

// ---------------------------------------------------------------------------
// PatchCacheInputSchema
// ---------------------------------------------------------------------------

describe('PatchCacheInputSchema', () => {
  it('applies defaults to a minimal input', () => {
    const args = PatchCacheInputSchema.parse({
      operations: [{ type: 'evict', id: 'Post:999' }],
    });

    expect(args).toEqual({
      operations: [{ type: 'evict', id: 'Post:999', broadcast: true }],
      gc: false,
      dryRun: false,
      approved: false,
    });
  });

  it('rejects a missing operations array', () => {
    expect(firstIssuePath(() => PatchCacheInputSchema.parse({}))).toEqual(['operations']);
  });

  it('rejects an empty operations array', () => {
    expect(firstIssuePath(() => PatchCacheInputSchema.parse({ operations: [] }))).toEqual([
      'operations',
    ]);
  });

  it('reports the offending operation index for a bad nested op', () => {
    expect(
      firstIssuePath(() =>
        PatchCacheInputSchema.parse({ operations: [{ type: 'evict', id: 'Post:1' }, { type: 'evict' }] }),
      ),
    ).toEqual(['operations', 1, 'id']);
  });

  it('reports the offending field for a bad nested field patch', () => {
    expect(
      firstIssuePath(() =>
        PatchCacheInputSchema.parse({
          operations: [{ type: 'modify', id: 'User:2', fields: { avatar: { action: 'NUKE' } } }],
        }),
      ),
    ).toEqual(['operations', 0, 'fields', 'avatar', 'action']);
  });
});

// ---------------------------------------------------------------------------
// inspectDanglingRefs
// ---------------------------------------------------------------------------

describe('inspectDanglingRefs', () => {
  it('throws a ZodError on malformed input', () => {
    expect(() => inspectDanglingRefs({ cache: 'nope' })).toThrow(ZodError);
    expect(() => inspectDanglingRefs(undefined)).toThrow(ZodError);
    expect(() => inspectDanglingRefs({ cache: MINIMAL_CACHE, rootIds: 'ROOT_QUERY' })).toThrow(
      ZodError,
    );
  });

  for (const fixture of fixtures) {
    it(`reports exactly the expected findings for ${fixture.name}`, () => {
      const { findings } = inspectDanglingRefs({ cache: fixture.cache });

      expect(comparable(findings)).toEqual(normalizeExpected(fixture.expectedFindings));
    });
  }

  it('counts what it walked', () => {
    const { stats } = inspectDanglingRefs({ cache: orphanedPointer.cache });

    expect(stats.entityCount).toBe(Object.keys(orphanedPointer.cache).length);
    expect(stats.danglingCount).toBe(2);
    expect(stats.unreachableCount).toBe(1);
    expect(stats.identityRiskCount).toBe(0);
  });

  describe('identity risk', () => {
    it('is off by default', () => {
      const { findings, stats } = inspectDanglingRefs({ cache: identityRiskField.cache });

      expect(findings).toEqual([]);
      expect(stats.identityRiskCount).toBe(0);
    });

    it('flags a ROOT_QUERY field matching the default identity names when opted in', () => {
      const { findings, stats } = inspectDanglingRefs({
        cache: identityRiskField.cache,
        includeIdentityRisk: true,
      });

      expect(comparable(findings)).toEqual(normalizeExpected(identityRiskField.expectedFindings));
      expect(stats.identityRiskCount).toBe(1);
    });

    it('matches only names in a custom identityFieldNames list', () => {
      const stillDefault = inspectDanglingRefs({
        cache: identityRiskField.cache,
        includeIdentityRisk: true,
        identityFieldNames: ['whoami'],
      });
      expect(stillDefault.findings).toEqual([]);

      const custom = inspectDanglingRefs({
        cache: { ROOT_QUERY: { __typename: 'Query', whoami: { __ref: 'User:9' } }, 'User:9': { __typename: 'User', id: '9' } },
        includeIdentityRisk: true,
        identityFieldNames: ['whoami'],
      });
      expect(custom.stats.identityRiskCount).toBe(1);
      expect(custom.findings[0]).toMatchObject({ kind: 'UNSCOPED_IDENTITY_FIELD', path: 'ROOT_QUERY.whoami' });
    });
  });
});

// ---------------------------------------------------------------------------
// compareQueryToCache
// ---------------------------------------------------------------------------

describe('compareQueryToCache', () => {
  it('returns complete=true with no misses when the cache satisfies the query', () => {
    const output = compareQueryToCache({
      cache: fixtures[0].cache,
      query: `
        query GetUser($id: ID!) {
          user(id: $id) {
            id
            name
            avatar { url }
          }
        }
      `,
      variables: { id: '1' },
    });

    expect(output.complete).toBe(true);
    expect(output.misses).toEqual([]);
    expect(output.satisfiedFields).toEqual(expect.arrayContaining(['user', 'user.id', 'user.name', 'user.avatar']));
  });

  it('reports dangling refs and missing fields with stable path + reason', () => {
    const output = compareQueryToCache({
      cache: orphanedPointer.cache,
      query: `
        query GetUser($id: ID!) {
          user(id: $id) {
            id
            avatar { url }
            posts { id title }
            email
          }
        }
      `,
      variables: { id: '2' },
    });

    expect(output.complete).toBe(false);
    expect(output.misses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: 'User:2',
          path: 'user.avatar',
          reason: 'DANGLING_REF',
        }),
        expect.objectContaining({
          entityId: 'User:2',
          path: 'user.email',
          reason: 'MISSING_FIELD',
        }),
      ]),
    );
  });

  it('classifies missing fields on inline non-entity objects as NOT_NORMALIZED', () => {
    const output = compareQueryToCache({
      cache: {
        ROOT_QUERY: { __typename: 'Query', me: { __ref: 'User:1' } },
        'User:1': {
          __typename: 'User',
          id: '1',
          profile: { bio: 'hi' },
        },
      },
      query: '{ me { profile { bio location } } }',
    });

    expect(output.complete).toBe(false);
    expect(output.misses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'me.profile.location',
          reason: 'NOT_NORMALIZED',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// patchCache
// ---------------------------------------------------------------------------

describe('patchCache', () => {
  const restored = () => new InMemoryCache().restore(orphanedPointer.cache);

  it('throws a ZodError before touching the cache', () => {
    const cache = restored();
    const before = cache.extract();

    expect(() => patchCache(cache, { operations: [] })).toThrow(ZodError);
    expect(() => patchCache(cache, { operations: [{ type: 'demolish' }] })).toThrow(ZodError);
    expect(() => patchCache(cache, {})).toThrow(ZodError);

    expect(cache.extract()).toEqual(before);
  });

  it('evicts an entity and reports the change', () => {
    const cache = restored();

    const output = patchCache(cache, { operations: [{ type: 'evict', id: 'Post:999' }] });

    expect(output.dryRun).toBe(false);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].changed).toBe(true);
    expect(cache.extract()['Post:999']).toBeUndefined();
  });

  it('leaves the cache untouched on a dry run', () => {
    const cache = restored();
    const before = cache.extract();

    const output = patchCache(cache, {
      dryRun: true,
      gc: true,
      operations: [
        { type: 'evict', id: 'Post:999' },
        { type: 'modify', id: 'User:2', fields: { avatar: { action: 'DELETE' } } },
        { type: 'modify', id: 'User:2', fields: { posts: { action: 'PRUNE_DANGLING_REFS' } } },
      ],
    });

    expect(output.dryRun).toBe(true);
    expect(output.results).toHaveLength(3);
    for (const result of output.results) expect(result.changed).toBe(false);
    expect(output.collected).toEqual([]);
    expect(cache.extract()).toEqual(before);
  });
});
