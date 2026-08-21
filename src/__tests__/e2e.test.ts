/**
 * End-to-end sanity: diagnose -> patch -> re-inspect, over one snapshot.
 *
 * The unit tests pin each stage against a fixture built for that stage. This
 * one asks the only question a user actually has: if I hand the copilot a real
 * cache and apply exactly what it proposes, is the cache clean afterwards?
 *
 * "Clean" means everything the patcher owns — dangling refs and unreachable
 * entities — is gone. It deliberately does NOT mean zero findings full stop:
 * MISSING_TYPENAME / MISSING_ID are defects in the query or fragment, not in
 * the stored data, so `reasonerNode` proposes nothing for them and no cache
 * mutation could fix them. The test asserts those survive the round trip
 * untouched, which is the contract, rather than pretending they were repaired.
 */

import { describe, expect, it } from 'vitest';

import {
  runDiagnoseCacheGraph,
  runInspectDanglingRefs,
  runPatchCache,
} from '../mcp/server.js';
import type { Finding } from '../schemas/tools.js';

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A React Native feed screen's `cache.extract()` after a few hours of use:
 * a paginated feed, a current user, comments, and every defect Day 1 named,
 * mixed together the way they actually arrive.
 *
 *   Dangling refs (4)
 *     ROOT_QUERY.feed({"first":10}).2  -> Post:3        never written; server returned a ref only
 *     User:1.avatar                    -> Avatar:404    evicted, parent field not modified
 *     Post:1.comments.1                -> Comment:12    optimistic comment rolled back
 *     Post:2.author                     -> User:2        blocked user evicted
 *
 *   Unreachable entities (2)
 *     Post:900 -> Comment:901          a stale page whose parent field was overwritten
 *
 *   Unkeyable inline objects (3 findings)
 *     User:1.settings   no __typename, no id  (hand-written writeQuery payload)
 *     Post:1.metrics    __typename, no id     (server selection dropped id)
 */
const feedSnapshot = {
  ROOT_QUERY: {
    __typename: 'Query',
    'feed({"first":10})': [
      { __ref: 'Post:1' },
      { __ref: 'Post:2' },
      { __ref: 'Post:3' },
    ],
    currentUser: { __ref: 'User:1' },
  },
  'User:1': {
    __typename: 'User',
    id: '1',
    handle: 'ada',
    avatar: { __ref: 'Avatar:404' },
    settings: {
      theme: 'dark',
      pushEnabled: true,
    },
  },
  'Post:1': {
    __typename: 'Post',
    id: '1',
    body: 'Shipped the analytical engine',
    author: { __ref: 'User:1' },
    comments: [{ __ref: 'Comment:11' }, { __ref: 'Comment:12' }],
    metrics: {
      __typename: 'PostMetrics',
      likes: 12,
      shares: 2,
    },
  },
  'Post:2': {
    __typename: 'Post',
    id: '2',
    body: 'Second post',
    author: { __ref: 'User:2' },
    comments: [],
  },
  'Comment:11': {
    __typename: 'Comment',
    id: '11',
    body: 'Congrats',
    author: { __ref: 'User:1' },
  },
  'Post:900': {
    __typename: 'Post',
    id: '900',
    body: 'Stale page-2 draft',
    comments: [{ __ref: 'Comment:901' }],
  },
  'Comment:901': {
    __typename: 'Comment',
    id: '901',
    body: 'Orphaned reply',
    author: { __ref: 'User:1' },
  },
};

/** Findings carry prose; identity is kind + path (+ ref). */
const key = (f: Finding) => `${f.kind} ${f.path}${f.danglingRef ? ` -> ${f.danglingRef}` : ''}`;

const GAP_KINDS: Finding['kind'][] = ['MISSING_TYPENAME', 'MISSING_ID'];
const isGap = (f: Finding) => GAP_KINDS.includes(f.kind);

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('e2e: diagnose -> patch -> re-inspect', () => {
  it('repairs every patchable defect in one pass', async () => {
    // --- 1. Diagnose -------------------------------------------------------

    const diagnosis = await runDiagnoseCacheGraph({ cache: feedSnapshot });

    expect(diagnosis.findings.map(key).sort()).toEqual(
      [
        'ORPHANED_REF ROOT_QUERY.feed({"first":10}).2 -> Post:3',
        'ORPHANED_REF User:1.avatar -> Avatar:404',
        'ORPHANED_REF Post:1.comments.1 -> Comment:12',
        'ORPHANED_REF Post:2.author -> User:2',
        'MISSING_TYPENAME User:1.settings',
        'MISSING_ID User:1.settings',
        'MISSING_ID Post:1.metrics',
        'UNREACHABLE_ENTITY Post:900',
        'UNREACHABLE_ENTITY Comment:901',
      ].sort(),
    );

    // One modify per affected entity, one evict per unreachable entity, and
    // modifies ordered first so pointers drop before their targets go.
    expect(diagnosis.proposedPatches.map((op) => `${op.type} ${op.id}`)).toEqual([
      'modify ROOT_QUERY',
      'modify User:1',
      'modify Post:1',
      'modify Post:2',
      'evict Post:900',
      'evict Comment:901',
    ]);

    // inspector -> reasoner -> patcher each spoke once.
    expect(diagnosis.narration).toHaveLength(3);
    expect(diagnosis.narration[0]).toContain('9 findings');
    expect(diagnosis.narration[1]).toContain('Skipped 3 unpatchable findings');
    expect(diagnosis.narration[2]).toContain('Ready to apply 6 operations');

    // --- 2. Patch ----------------------------------------------------------

    const patched = runPatchCache({
      cache: feedSnapshot,
      operations: diagnosis.proposedPatches,
      gc: true,
    });

    expect(patched.dryRun).toBe(false);
    expect(patched.results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(patched.results.every((r) => r.changed)).toBe(true);
    // The evicts already took the unreachable entities; gc has nothing left.
    expect(patched.collected).toEqual([]);

    // --- 3. Re-inspect -----------------------------------------------------

    const after = runInspectDanglingRefs({
      cache: patched.cache,
      includeNormalizationGaps: false,
    });

    expect(after.findings).toEqual([]);
    expect(after.stats.danglingCount).toBe(0);
    expect(after.stats.unreachableCount).toBe(0);

    // The query-side gaps are still there, unchanged — nothing in the cache
    // could have fixed them, so a patcher that "fixed" them would be lying.
    const gapsBefore = diagnosis.findings.filter(isGap).map(key).sort();
    const gapsAfter = runInspectDanglingRefs({ cache: patched.cache })
      .findings.map(key)
      .sort();

    expect(gapsAfter).toEqual(gapsBefore);

    // --- 4. Converged ------------------------------------------------------

    // Re-running the whole workflow on the patched cache proposes nothing:
    // the pass was a fixed point, not the first step of a loop.
    const rediagnosis = await runDiagnoseCacheGraph({ cache: patched.cache });
    expect(rediagnosis.proposedPatches).toEqual([]);
    expect(rediagnosis.findings.every(isGap)).toBe(true);
  });

  it('leaves the input snapshot untouched', async () => {
    const before = JSON.stringify(feedSnapshot);
    const diagnosis = await runDiagnoseCacheGraph({ cache: feedSnapshot });
    runPatchCache({ cache: feedSnapshot, operations: diagnosis.proposedPatches, gc: true });

    // The MCP patcher restores into a throwaway InMemoryCache; the caller's
    // snapshot is an input, never an output.
    expect(JSON.stringify(feedSnapshot)).toBe(before);
  });
});
