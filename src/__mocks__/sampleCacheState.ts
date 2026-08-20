/**
 * Serialized `InMemoryCache` fixtures — the exact shape `cache.extract()` returns.
 *
 * Three cases, one per Day 1 failure class:
 *   1. healthyEntity        — fully normalized, every `__ref` resolves
 *   2. orphanedPointer      — `__ref` to a cache key that does not exist
 *   3. missingTypenameOrId  — object stored inline because no cache key could be computed
 *
 * Each case ships `expectedFindings`, so analyzer tests assert against the
 * fixture instead of a hand-copied list that drifts.
 */

import type { NormalizedCacheObject } from '@apollo/client';

/** What the analyzer is expected to report for a fixture. */
export interface ExpectedFinding {
  kind: 'ORPHANED_REF' | 'MISSING_TYPENAME' | 'MISSING_ID' | 'UNREACHABLE_ENTITY';
  /** Dotted path from a cache root, e.g. `User:2.avatar`. */
  path: string;
  /** The dangling cache key, for ORPHANED_REF only. */
  danglingRef?: string;
}

export interface CacheFixture {
  name: string;
  description: string;
  cache: NormalizedCacheObject;
  expectedFindings: ExpectedFinding[];
}

// ---------------------------------------------------------------------------
// 1. Healthy entity — the zero-findings baseline (false-positive guard)
// ---------------------------------------------------------------------------

export const healthyEntity: CacheFixture = {
  name: 'healthyEntity',
  description:
    'Fully normalized User with a resolving Avatar ref and a resolving post list. Analyzer must report nothing.',
  cache: {
    ROOT_QUERY: {
      __typename: 'Query',
      'user({"id":"1"})': { __ref: 'User:1' },
    },
    'User:1': {
      __typename: 'User',
      id: '1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      avatar: { __ref: 'Avatar:10' },
      posts: [{ __ref: 'Post:100' }, { __ref: 'Post:101' }],
    },
    'Avatar:10': {
      __typename: 'Avatar',
      id: '10',
      url: 'https://cdn.example.com/a/10.png',
      width: 128,
      height: 128,
    },
    'Post:100': {
      __typename: 'Post',
      id: '100',
      title: 'Notes on the Analytical Engine',
      author: { __ref: 'User:1' }, // back-reference; cycle must not hang the walker
    },
    'Post:101': {
      __typename: 'Post',
      id: '101',
      title: 'On Bernoulli numbers',
      author: { __ref: 'User:1' },
    },
  },
  expectedFindings: [],
};

// ---------------------------------------------------------------------------
// 2. Orphaned pointer — `__ref` with no entity behind it
// ---------------------------------------------------------------------------

export const orphanedPointer: CacheFixture = {
  name: 'orphanedPointer',
  description:
    'Avatar:404 was evicted while User:2 still points at it, and a list holds a ref to a never-written Post. ' +
    'Apollo returns undefined for these fields, so the UI renders blank instead of throwing. ' +
    'Also carries Post:999, an entity no root can reach.',
  cache: {
    ROOT_QUERY: {
      __typename: 'Query',
      'user({"id":"2"})': { __ref: 'User:2' },
    },
    'User:2': {
      __typename: 'User',
      id: '2',
      name: 'Grace Hopper',
      // Evicted target: classic `cache.evict({ id: 'Avatar:404' })` without a
      // matching `cache.modify` on the parent field.
      avatar: { __ref: 'Avatar:404' },
      posts: [
        { __ref: 'Post:200' }, // resolves
        { __ref: 'Post:201' }, // dangling — mutation returned a ref, not the body
      ],
    },
    'Post:200': {
      __typename: 'Post',
      id: '200',
      title: 'The first compiler',
      author: { __ref: 'User:2' },
    },
    // Written by a query whose parent field was later overwritten. Nothing
    // points here anymore, so `gc()` would collect it.
    'Post:999': {
      __typename: 'Post',
      id: '999',
      title: 'Orphaned draft',
      author: { __ref: 'User:2' },
    },
  },
  expectedFindings: [
    { kind: 'ORPHANED_REF', path: 'User:2.avatar', danglingRef: 'Avatar:404' },
    { kind: 'ORPHANED_REF', path: 'User:2.posts.1', danglingRef: 'Post:201' },
    { kind: 'UNREACHABLE_ENTITY', path: 'Post:999' },
  ],
};

// ---------------------------------------------------------------------------
// 3. Missing __typename or id — silently stored inline, never normalized
// ---------------------------------------------------------------------------

export const missingTypenameOrId: CacheFixture = {
  name: 'missingTypenameOrId',
  description:
    'Three objects Apollo could not key: no __typename, no id, and neither. Each is stored inline under its ' +
    'parent instead of as an entity, so a second write creates a divergent copy. Renders correctly on first paint.',
  cache: {
    ROOT_QUERY: {
      __typename: 'Query',
      'user({"id":"3"})': { __ref: 'User:3' },
    },
    'User:3': {
      __typename: 'User',
      id: '3',
      name: 'Barbara Liskov',

      // Has id, no __typename — fragment or optimistic response omitted it.
      avatar: {
        id: '30',
        url: 'https://cdn.example.com/a/30.png',
      },

      // Has __typename, no id — server field selection dropped `id`.
      profile: {
        __typename: 'Profile',
        bio: 'Substitution principle',
        location: 'Cambridge, MA',
      },

      // Neither — hand-written writeQuery payload. Stored fully inline.
      settings: {
        theme: 'dark',
        notifications: true,
      },

      // Inline objects inside a list: same defect, one entry per index.
      posts: [
        { __typename: 'Post', id: '300', title: 'Programming with abstract data types' },
        { __typename: 'Post', title: 'Untitled draft' }, // no id
      ],
    },
  },
  expectedFindings: [
    { kind: 'MISSING_TYPENAME', path: 'User:3.avatar' },
    { kind: 'MISSING_ID', path: 'User:3.profile' },
    { kind: 'MISSING_TYPENAME', path: 'User:3.settings' },
    { kind: 'MISSING_ID', path: 'User:3.settings' },
    { kind: 'MISSING_ID', path: 'User:3.posts.1' },
  ],
};

export const fixtures: CacheFixture[] = [
  healthyEntity,
  orphanedPointer,
  missingTypenameOrId,
];

export const fixturesByName: Record<string, CacheFixture> = {
  healthyEntity,
  orphanedPointer,
  missingTypenameOrId,
};
