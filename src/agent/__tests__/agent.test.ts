/**
 * Graph behaviour tests.
 *
 * These run the compiled graph end to end against the serialized fixtures —
 * no LLM, no network, so the assertions are exact rather than fuzzy. The last
 * block closes the loop: the patches the reasoner proposes are applied to a
 * real `InMemoryCache` and the cache is re-inspected, which is the only
 * assertion that proves the proposals actually repair anything.
 */

import { InMemoryCache } from '@apollo/client/cache/index.js';
import { describe, expect, it } from 'vitest';

import {
  healthyEntity,
  missingTypenameOrId,
  orphanedPointer,
  type ExpectedFinding,
} from '../../__mocks__/sampleCacheState.js';
import { PatchOperationSchema, type Finding, type PatchOperation } from '../../schemas/tools.js';
import { inspectDanglingRefs } from '../../tools/inspectDanglingRefs.js';
import { patchCache } from '../../tools/patchCache.js';
import { cacheAgentGraph } from '../graph.js';

/** Findings carry prose; compare only the parts the fixture pins down. */
function comparable(findings: (Finding | ExpectedFinding)[]) {
  return findings.map(({ kind, path, danglingRef }) => ({ kind, path, danglingRef }));
}

function modifyOp(patches: PatchOperation[], id: string) {
  return patches.find((op) => op.type === 'modify' && op.id === id);
}

describe('detecting orphaned refs', () => {
  it('reports exactly the fixture findings', async () => {
    const result = await cacheAgentGraph.invoke({ cacheState: orphanedPointer.cache });

    expect(comparable(result.findings)).toEqual(comparable(orphanedPointer.expectedFindings));
  });
});

describe('generating declarative patches', () => {
  it('merges both dangling fields of User:2 into one modify and evicts Post:999', async () => {
    const { proposedPatches } = await cacheAgentGraph.invoke({
      cacheState: orphanedPointer.cache,
    });

    const modify = modifyOp(proposedPatches, 'User:2');
    expect(modify).toBeDefined();
    expect(modify).toMatchObject({
      type: 'modify',
      fields: {
        avatar: { action: 'PRUNE_DANGLING_REFS' },
        posts: { action: 'PRUNE_DANGLING_REFS' },
      },
    });

    // One merged op, not one per finding.
    expect(proposedPatches.filter((op) => op.type === 'modify' && op.id === 'User:2')).toHaveLength(1);

    expect(proposedPatches).toContainEqual(
      expect.objectContaining({ type: 'evict', id: 'Post:999' }),
    );

    // Pointers are pruned before their targets are collected.
    const firstEvict = proposedPatches.findIndex((op) => op.type === 'evict');
    const lastModify = proposedPatches.map((op) => op.type).lastIndexOf('modify');
    expect(lastModify).toBeLessThan(firstEvict);
  });

  it('emits operations that round-trip through PatchOperationSchema', async () => {
    const { proposedPatches } = await cacheAgentGraph.invoke({
      cacheState: orphanedPointer.cache,
    });

    expect(proposedPatches.length).toBeGreaterThan(0);
    for (const op of proposedPatches) {
      expect(PatchOperationSchema.parse(op)).toEqual(op);
    }
  });
});

describe('verifying clean state', () => {
  it('short-circuits to END without running the reasoner', async () => {
    const result = await cacheAgentGraph.invoke({ cacheState: healthyEntity.cache });

    expect(result.findings).toEqual([]);
    expect(result.proposedPatches).toEqual([]);
    // Only the inspector spoke — proof the conditional edge skipped the rest.
    expect(result.messages).toHaveLength(1);
    expect(String(result.messages[0].content)).toMatch(/clean/i);
  });
});

describe('unpatchable findings', () => {
  it('reports normalization gaps but proposes nothing', async () => {
    const result = await cacheAgentGraph.invoke({ cacheState: missingTypenameOrId.cache });

    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.proposedPatches).toEqual([]);

    const narration = result.messages.map((m) => String(m.content)).join('\n');
    expect(narration).toMatch(/Skipped/);
    expect(narration).toMatch(/MISSING_TYPENAME/);
  });
});

describe('round trip', () => {
  it('applying the proposed patches clears every ORPHANED_REF', async () => {
    const { proposedPatches } = await cacheAgentGraph.invoke({
      cacheState: orphanedPointer.cache,
    });

    const cache = new InMemoryCache();
    cache.restore(orphanedPointer.cache);

    const before = inspectDanglingRefs({ cache: cache.extract() });
    expect(before.findings.some((f) => f.kind === 'ORPHANED_REF')).toBe(true);

    patchCache(cache, { operations: proposedPatches });

    const after = inspectDanglingRefs({ cache: cache.extract() });
    expect(after.findings.filter((f) => f.kind === 'ORPHANED_REF')).toEqual([]);
  });
});
