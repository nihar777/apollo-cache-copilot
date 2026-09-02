/**
 * Memory module tests: the `MemoryStore` unit contract, then the graph
 * integration that actually exercises recall + conflict resolution end to
 * end against real cache fixtures.
 */

import { describe, expect, it } from 'vitest';

import { orphanedPointer, healthyEntity } from '../__mocks__/sampleCacheState.js';
import { MemoryStore } from '../memory/store.js';
import { cacheAgentGraph } from '../agent/graph.js';
import type { Finding } from '../schemas/tools.js';

describe('short-term conversation state', () => {
  it('keeps turns in order and evicts the oldest once the ring buffer is full', () => {
    const store = new MemoryStore({ maxShortTermTurns: 2 });

    store.recordTurn('s1', { findings: [{ turn: 1 }], proposedPatches: [] });
    store.recordTurn('s1', { findings: [{ turn: 2 }], proposedPatches: [] });
    store.recordTurn('s1', { findings: [{ turn: 3 }], proposedPatches: [] });

    const turns = store.getShortTerm('s1');
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.findings)).toEqual([[{ turn: 2 }], [{ turn: 3 }]]);
  });

  it('partitions short-term state by session', () => {
    const store = new MemoryStore();
    store.recordTurn('a', { findings: ['a-finding'], proposedPatches: [] });
    store.recordTurn('b', { findings: ['b-finding'], proposedPatches: [] });

    expect(store.getShortTerm('a')[0].findings).toEqual(['a-finding']);
    expect(store.getShortTerm('b')[0].findings).toEqual(['b-finding']);
  });

  it('returns nothing for a session that never recorded a turn', () => {
    expect(new MemoryStore().getShortTerm('never')).toEqual([]);
  });
});

describe('long-term memory retrieval', () => {
  it('recalls a remembered value by key', () => {
    const store = new MemoryStore();
    store.remember('s1', 'User:2', { flagged: true });
    expect(store.recall('s1', 'User:2')?.value).toEqual({ flagged: true });
  });

  it('enforces a strict context budget: never more than maxItems, newest first', () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      store.remember('s1', `key-${i}`, i, { now: 1000 + i });
    }

    const retrieved = store.retrieveContext('s1', { maxItems: 2, now: 2000 });
    expect(retrieved).toHaveLength(2);
    expect(retrieved.map((r) => r.value)).toEqual([4, 3]);
  });

  it('is scoped to one session — another session sees nothing', () => {
    const store = new MemoryStore();
    store.remember('s1', 'k', 'v');
    expect(store.retrieveContext('s2')).toEqual([]);
  });

  it('refuses a sessionId that would pollute the persisted dump object', () => {
    const store = new MemoryStore();
    expect(() => store.remember('__proto__', 'k', 'v')).toThrow(/forbidden key/);
    expect(() => store.remember('constructor', 'k', 'v')).toThrow(/forbidden key/);
  });
});

describe('stale and conflicting state recovery', () => {
  it('drops records older than staleAfterMs from retrieval', () => {
    const store = new MemoryStore({ staleAfterMs: 1000 });
    store.remember('s1', 'old', 'stale-value', { now: 0 });
    store.remember('s1', 'new', 'fresh-value', { now: 900 });

    const retrieved = store.retrieveContext('s1', { now: 1500 });
    expect(retrieved.map((r) => r.key)).toEqual(['new']);
  });

  it('resolveConflict prefers a verified fresh value over a retrieved one', () => {
    const store = new MemoryStore();
    const fresh = { value: 'current', verified: true };
    const retrieved = { key: 'k', value: 'stale', updatedAt: 0, verified: true };
    expect(store.resolveConflict(fresh, retrieved)).toBe('current');
  });

  it('resolveConflict prefers an unverified fresh value over nothing', () => {
    const store = new MemoryStore();
    expect(store.resolveConflict({ value: 'current', verified: false }, undefined)).toBe('current');
  });

  it('resolveConflict falls back to the retrieved value when there is no fresh input', () => {
    const store = new MemoryStore();
    const retrieved = { key: 'k', value: 'stale', updatedAt: 0, verified: true };
    expect(store.resolveConflict(undefined, retrieved)).toBe('stale');
  });
});

describe('memory integration with the agent graph', () => {
  it('does not touch memory when sessionId is omitted (existing behavior unchanged)', async () => {
    const result = await cacheAgentGraph.invoke({ cacheState: orphanedPointer.cache });
    // Same shape as the pre-memory graph: inspector, reasoner, patcher — no
    // recall/commit narration mixed in.
    expect(result.messages).toHaveLength(3);
  });

  it('recovers a prior finding for an entity a later, narrower snapshot no longer covers', async () => {
    const sessionId = `memory-recover-${Math.random()}`;

    // Turn 1: full cache with the known dangling refs — committed to memory.
    await cacheAgentGraph.invoke({ cacheState: orphanedPointer.cache, sessionId });

    // Turn 2: a snapshot that doesn't include User:2 or Post:999 at all (a
    // partial read). Memory is the only source left for those entities.
    const turn2 = await cacheAgentGraph.invoke({
      cacheState: { ROOT_QUERY: { __typename: 'Query' } },
      sessionId,
    });

    const recoveredPaths = turn2.findings.map((f: Finding) => f.path).sort();
    expect(recoveredPaths).toEqual(['Post:999', 'User:2.avatar', 'User:2.posts.1'].sort());
  });

  it('lets a fresh clean inspection override stale memory for the same entity', async () => {
    const sessionId = `memory-conflict-${Math.random()}`;

    // Turn 1: User:2 has dangling refs — committed to memory.
    await cacheAgentGraph.invoke({ cacheState: orphanedPointer.cache, sessionId });

    // Turn 2: User:2 comes back healthy (refs fixed), but Post:999 is still
    // absent from this snapshot. Fresh, verified data wins for User:2 (no
    // resurrected findings there); Post:999 still has no fresh opinion, so
    // memory recovers it.
    const fixedCache = {
      ROOT_QUERY: orphanedPointer.cache.ROOT_QUERY,
      'User:2': {
        __typename: 'User',
        id: '2',
        name: 'Grace Hopper',
        posts: [{ __ref: 'Post:200' }], // dangling Post:201 ref is gone, avatar field dropped entirely
      },
      'Post:200': orphanedPointer.cache['Post:200'],
      // Post:999 intentionally absent — this snapshot still doesn't cover it.
    };

    const turn2 = await cacheAgentGraph.invoke({ cacheState: fixedCache, sessionId });

    expect(turn2.findings.some((f: Finding) => entityOf(f) === 'User:2')).toBe(false);
    expect(turn2.findings.some((f: Finding) => f.path === 'Post:999')).toBe(true);
  });

  it('keeps memory isolated per session — a fresh session recalls nothing from another', async () => {
    await cacheAgentGraph.invoke({
      cacheState: orphanedPointer.cache,
      sessionId: `memory-isolation-a-${Math.random()}`,
    });

    // A brand-new session, never committed to, has nothing to recall even
    // against a snapshot that doesn't cover every entity.
    const result = await cacheAgentGraph.invoke({
      cacheState: healthyEntity.cache,
      sessionId: `memory-isolation-b-${Math.random()}`,
    });
    expect(result.findings).toEqual([]);
  });
});

function entityOf(finding: Finding): string {
  const dot = finding.path.indexOf('.');
  return dot === -1 ? finding.path : finding.path.slice(0, dot);
}
