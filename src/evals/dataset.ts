/**
 * Day 8 eval dataset — serialized `InMemoryCache` snapshots covering the
 * defect classes `inspectDanglingRefs` / `cacheAgentGraph` claim to catch:
 * clean caches, dangling refs, unreachable entities, reference cycles,
 * unkeyable inline objects, unscoped identity fields, and mixes of all five.
 *
 * Each case's `expectedFindingCounts` is a hand-traced result of running the
 * detector's actual algorithm against `cache` — not a guess. The runner
 * fails loudly if the code and this file disagree.
 */

import type { FindingKind } from '../schemas/tools.js';

type StoreObject = Record<string, unknown>;
type NormalizedCache = Record<string, StoreObject>;

export type EvalCategory =
  | 'clean'
  | 'dangling'
  | 'unreachable'
  | 'circular'
  | 'unkeyable'
  | 'mixed'
  | 'edge'
  | 'identity';

export interface EvalCase {
  name: string;
  category: EvalCategory;
  description: string;
  cache: NormalizedCache;
  /** Expected count per finding kind. Omitted kinds are expected to be 0. */
  expectedFindingCounts: Partial<Record<FindingKind, number>>;
}

const ref = (key: string) => ({ __ref: key });

export const EVAL_CASES: EvalCase[] = [
  // ---------------------------------------------------------------------
  // clean
  // ---------------------------------------------------------------------
  {
    name: 'empty-cache',
    category: 'clean',
    description: 'No entities at all.',
    cache: {},
    expectedFindingCounts: {},
  },
  {
    name: 'clean-root-only',
    category: 'clean',
    description: 'One valid ref from ROOT_QUERY to a well-formed entity.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', name: 'Alice' },
    },
    expectedFindingCounts: {},
  },
  {
    name: 'clean-nested-list',
    category: 'clean',
    description: 'List of valid refs plus an entity-to-entity cross-reference.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', users: [ref('User:1'), ref('User:2')] },
      'User:1': { __typename: 'User', id: '1', name: 'A' },
      'User:2': { __typename: 'User', id: '2', name: 'B', friend: ref('User:1') },
    },
    expectedFindingCounts: {},
  },

  // ---------------------------------------------------------------------
  // dangling
  // ---------------------------------------------------------------------
  {
    name: 'dangling-root-field',
    category: 'dangling',
    description: 'ROOT_QUERY points at an entity that was never written.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', user: ref('User:99') },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },
  {
    name: 'dangling-in-list',
    category: 'dangling',
    description: 'One valid and one dangling ref in the same list field.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', posts: [ref('Post:1'), ref('Post:2')] },
      'Post:1': { __typename: 'Post', id: '1', title: 'Hi' },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },
  {
    name: 'dangling-multiple-entities',
    category: 'dangling',
    description: 'Two unrelated entities each hold one dangling ref.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', users: [ref('User:1'), ref('User:2')] },
      'User:1': { __typename: 'User', id: '1', pet: ref('Pet:1') },
      'User:2': { __typename: 'User', id: '2', pet: ref('Pet:2') },
    },
    expectedFindingCounts: { ORPHANED_REF: 2 },
  },
  {
    name: 'dangling-root-mutation',
    category: 'dangling',
    description: 'A mutation result ref that never got backed by a written entity.',
    cache: {
      ROOT_QUERY: { __typename: 'Query' },
      ROOT_MUTATION: { __typename: 'Mutation', deletePost: ref('Post:5') },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },
  {
    name: 'dangling-root-subscription',
    category: 'dangling',
    description: 'A subscription push ref pointing at nothing.',
    cache: {
      ROOT_QUERY: { __typename: 'Query' },
      ROOT_SUBSCRIPTION: { __typename: 'Subscription', onMessage: ref('Message:1') },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },
  {
    name: 'dangling-nested-two-levels',
    category: 'dangling',
    // Known reasoner gap: `parseFieldPath` turns this finding's path into the
    // fake field name `edges.0.node`, which doesn't match any real top-level
    // field on Feed:1 — `cache.modify` silently no-ops. Diagnosis is correct;
    // auto-repair isn't, for refs nested inside a list of objects (as opposed
    // to a bare list of refs). Kept in the suite specifically to catch this.
    description: 'Dangling ref two levels deep inside an inline connection edge.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', feed: ref('Feed:1') },
      'Feed:1': {
        __typename: 'Feed',
        id: '1',
        edges: [{ __typename: 'Edge', id: 'e1', node: ref('Post:1') }],
      },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },
  {
    name: 'dangling-multi-field-same-entity',
    category: 'dangling',
    description: 'One entity with two separate fields each dangling — merge test for the reasoner.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': {
        __typename: 'User',
        id: '1',
        bestFriend: ref('User:404'),
        favoritePost: ref('Post:404'),
      },
    },
    expectedFindingCounts: { ORPHANED_REF: 2 },
  },
  {
    name: 'dangling-array-mixed-valid-invalid',
    category: 'dangling',
    description: 'Five-item ref list, two dangling — partial prune must keep the valid three.',
    cache: {
      ROOT_QUERY: {
        __typename: 'Query',
        feed: [ref('Post:1'), ref('Post:2'), ref('Post:3'), ref('Post:4'), ref('Post:5')],
      },
      'Post:1': { __typename: 'Post', id: '1' },
      'Post:3': { __typename: 'Post', id: '3' },
      'Post:5': { __typename: 'Post', id: '5' },
    },
    expectedFindingCounts: { ORPHANED_REF: 2 },
  },

  // ---------------------------------------------------------------------
  // unreachable
  // ---------------------------------------------------------------------
  {
    name: 'unreachable-single',
    category: 'unreachable',
    description: 'A valid entity no root path reaches.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', name: 'A' },
      'User:2': { __typename: 'User', id: '2', name: 'B' },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 1 },
  },
  {
    name: 'unreachable-chain',
    category: 'unreachable',
    description: 'An unreachable entity that itself validly refs another unreachable entity.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1' },
      'User:3': { __typename: 'User', id: '3', friend: ref('User:4') },
      'User:4': { __typename: 'User', id: '4' },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 2 },
  },
  {
    name: 'unreachable-with-valid-ref-inside',
    category: 'unreachable',
    description: 'Unreachable entity references a reachable one — eviction must not cascade.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', name: 'A' },
      'Draft:1': { __typename: 'Draft', id: '1', author: ref('User:1') },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 1 },
  },
  {
    name: 'unreachable-no-root-query',
    category: 'unreachable',
    description: 'No ROOT_QUERY/MUTATION/SUBSCRIPTION at all — every entity is unreachable.',
    cache: {
      'User:1': { __typename: 'User', id: '1', name: 'A' },
      'User:2': { __typename: 'User', id: '2', friend: ref('User:1') },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 2 },
  },
  {
    name: 'unreachable-large-fanout',
    category: 'unreachable',
    description: 'Five referenced entities plus one orphaned extra.',
    cache: {
      ROOT_QUERY: {
        __typename: 'Query',
        users: [ref('User:1'), ref('User:2'), ref('User:3'), ref('User:4'), ref('User:5')],
      },
      'User:1': { __typename: 'User', id: '1' },
      'User:2': { __typename: 'User', id: '2' },
      'User:3': { __typename: 'User', id: '3' },
      'User:4': { __typename: 'User', id: '4' },
      'User:5': { __typename: 'User', id: '5' },
      'User:100': { __typename: 'User', id: '100' },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 1 },
  },

  // ---------------------------------------------------------------------
  // circular
  // ---------------------------------------------------------------------
  {
    name: 'circular-reachable',
    category: 'circular',
    description: 'A <-> B cycle reachable from root — must not be flagged, must not hang.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', team: ref('Team:A') },
      'Team:A': { __typename: 'Team', id: 'A', rival: ref('Team:B') },
      'Team:B': { __typename: 'Team', id: 'B', rival: ref('Team:A') },
    },
    expectedFindingCounts: {},
  },
  {
    name: 'circular-unreachable',
    category: 'circular',
    description: 'A cycle disconnected from every root — both sides are collectible.',
    cache: {
      ROOT_QUERY: { __typename: 'Query' },
      'Team:C': { __typename: 'Team', id: 'C', rival: ref('Team:D') },
      'Team:D': { __typename: 'Team', id: 'D', rival: ref('Team:C') },
    },
    expectedFindingCounts: { UNREACHABLE_ENTITY: 2 },
  },
  {
    name: 'self-reference',
    category: 'circular',
    description: 'An entity that refs itself — valid, reachable, no findings.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', bestFriend: ref('User:1') },
    },
    expectedFindingCounts: {},
  },

  // ---------------------------------------------------------------------
  // unkeyable / normalization gaps
  // ---------------------------------------------------------------------
  {
    name: 'inline-missing-id',
    category: 'unkeyable',
    description: 'Inline object has __typename but no id/_id.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': {
        __typename: 'User',
        id: '1',
        address: { __typename: 'Address', street: 'Main St' },
      },
    },
    expectedFindingCounts: { MISSING_ID: 1 },
  },
  {
    name: 'inline-missing-typename',
    category: 'unkeyable',
    description: 'Inline object has an id but no __typename.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': {
        __typename: 'User',
        id: '1',
        address: { id: 'addr-1', street: 'Main St' },
      },
    },
    expectedFindingCounts: { MISSING_TYPENAME: 1 },
  },
  {
    name: 'inline-missing-both',
    category: 'unkeyable',
    description: 'Inline object has neither __typename nor id — fully unkeyable.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', geo: { lat: 40.7, lng: -74.0 } },
    },
    expectedFindingCounts: { MISSING_TYPENAME: 1, MISSING_ID: 1 },
  },
  {
    name: 'nested-unkeyable-deep',
    category: 'unkeyable',
    description: 'Unkeyable object nested three levels inside a well-formed entity.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': {
        __typename: 'User',
        id: '1',
        settings: {
          __typename: 'Settings',
          id: 's1',
          theme: { mode: 'dark', accent: 'blue' },
        },
      },
    },
    expectedFindingCounts: { MISSING_TYPENAME: 1, MISSING_ID: 1 },
  },

  // ---------------------------------------------------------------------
  // mixed
  // ---------------------------------------------------------------------
  {
    name: 'mixed-dangling-and-unreachable',
    category: 'mixed',
    description: 'One dangling ref and one unrelated unreachable entity in the same cache.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', avatar: ref('Image:1') },
      'Order:99': { __typename: 'Order', id: '99' },
    },
    expectedFindingCounts: { ORPHANED_REF: 1, UNREACHABLE_ENTITY: 1 },
  },
  {
    name: 'mixed-all-three',
    category: 'mixed',
    description: 'Dangling ref + unkeyable inline object + unreachable entity, all at once.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1') },
      'User:1': {
        __typename: 'User',
        id: '1',
        pet: ref('Pet:1'),
        profile: { bio: 'hi' },
      },
      'Ghost:1': { __typename: 'Ghost', id: '1' },
    },
    expectedFindingCounts: {
      ORPHANED_REF: 1,
      MISSING_TYPENAME: 1,
      MISSING_ID: 1,
      UNREACHABLE_ENTITY: 1,
    },
  },
  {
    name: 'mixed-evict-then-modify-order',
    category: 'mixed',
    description: 'An unreachable entity that also owns its own dangling ref — modify + evict on the same id.',
    cache: {
      ROOT_QUERY: { __typename: 'Query' },
      'Zombie:1': { __typename: 'Zombie', id: '1', friend: ref('Zombie:404') },
    },
    expectedFindingCounts: { ORPHANED_REF: 1, UNREACHABLE_ENTITY: 1 },
  },

  // ---------------------------------------------------------------------
  // edge
  // ---------------------------------------------------------------------
  {
    name: 'large-fanout-clean',
    category: 'edge',
    description: 'Ten valid refs from root, nothing dangling or unreachable.',
    cache: {
      ROOT_QUERY: {
        __typename: 'Query',
        users: Array.from({ length: 10 }, (_, i) => ref(`User:${i + 1}`)),
      },
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `User:${i + 1}`,
          { __typename: 'User', id: String(i + 1) },
        ]),
      ),
    },
    expectedFindingCounts: {},
  },
  {
    name: 'dangling-near-miss-key',
    category: 'edge',
    description: 'A dangling ref whose key is one character off from a real entity — no fuzzy matching.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', entity: ref('User:1'), ghost: ref('User:1x') },
      'User:1': { __typename: 'User', id: '1', name: 'Real' },
    },
    expectedFindingCounts: { ORPHANED_REF: 1 },
  },

  // ---------------------------------------------------------------------
  // identity
  // ---------------------------------------------------------------------
  {
    name: 'identity-current-user-field',
    category: 'identity',
    description: 'ROOT_QUERY.me resolves cleanly, but the field name carries no session/identity in its key.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', me: ref('User:1') },
      'User:1': { __typename: 'User', id: '1', name: 'A' },
    },
    expectedFindingCounts: { UNSCOPED_IDENTITY_FIELD: 1 },
  },
  {
    name: 'identity-field-with-args',
    category: 'identity',
    description: 'currentUser(...) with serialized args — arg suffix must be stripped before name matching.',
    cache: {
      ROOT_QUERY: { __typename: 'Query', 'currentUser({"locale":"en"})': ref('User:1') },
      'User:1': { __typename: 'User', id: '1', name: 'A' },
    },
    expectedFindingCounts: { UNSCOPED_IDENTITY_FIELD: 1 },
  },
];
