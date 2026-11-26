/**
 * Break tests: try to make each tool hang, corrupt, or accept hostile input.
 * A failing test here is a real bug, not a flaky test.
 */

import { InMemoryCache } from '@apollo/client/cache/index.js';
import { describe, expect, it } from 'vitest';

import { GuardrailError } from '../../security/guardrails.js';
import { compareQueryToCache } from '../compareQueryToCache.js';
import { inspectDanglingRefs } from '../inspectDanglingRefs.js';
import { patchCache } from '../patchCache.js';

describe('break 1: cycles and size in inspectDanglingRefs', () => {
  it('terminates on entity-to-entity ref cycles', () => {
    const cache = {
      ROOT_QUERY: { __typename: 'Query', a: { __ref: 'A:1' } },
      'A:1': { __typename: 'A', id: '1', b: { __ref: 'B:1' } },
      'B:1': { __typename: 'B', id: '1', a: { __ref: 'A:1' } },
    };
    const out = inspectDanglingRefs({ cache });
    expect(out.findings).toEqual([]);
  });

  it('terminates on a self-referencing entity', () => {
    const cache = {
      ROOT_QUERY: { __typename: 'Query', a: { __ref: 'A:1' } },
      'A:1': { __typename: 'A', id: '1', self: { __ref: 'A:1' } },
    };
    expect(inspectDanglingRefs({ cache }).findings).toEqual([]);
  });

  it('handles 50k entities in under 5s', () => {
    const cache: Record<string, unknown> = {
      ROOT_QUERY: { __typename: 'Query', items: [] as unknown[] },
    };
    const items = (cache.ROOT_QUERY as { items: unknown[] }).items;
    for (let i = 0; i < 50_000; i++) {
      cache[`Item:${i}`] = { __typename: 'Item', id: String(i), next: { __ref: `Item:${i + 1}` } };
      items.push({ __ref: `Item:${i}` });
    }
    const start = Date.now();
    const out = inspectDanglingRefs({ cache });
    expect(Date.now() - start).toBeLessThan(5000);
    // last entity points at Item:50000, which does not exist
    expect(out.findings.some((f) => f.kind === 'ORPHANED_REF')).toBe(true);
  });
});

describe('break 2: hostile input into compareQueryToCache', () => {
  it('does not pollute Object.prototype via __proto__ keys in variables', () => {
    const variables = JSON.parse('{"__proto__":{"polluted":true}}');
    try {
      compareQueryToCache({
        cache: { ROOT_QUERY: { __typename: 'Query' } },
        query: 'query Q { me { id } }',
        variables,
      });
    } catch {
      // throwing is an acceptable refusal
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a deeply nested payload with a guardrail error, not a stack overflow', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 5000; i++) {
      const next = {};
      deep.n = next;
      deep = next;
    }
    // Must not crash the process with a stack overflow RangeError.
    let err: unknown;
    try {
      compareQueryToCache({
        cache: { ROOT_QUERY: { __typename: 'Query' } },
        query: 'query Q { me { id } }',
        variables: root,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailError);
  });
});

describe('break 3: patchCache atomicity', () => {
  function seeded() {
    const cache = new InMemoryCache();
    cache.restore({
      ROOT_QUERY: { __typename: 'Query', a: 1, b: 2 },
    });
    return cache;
  }

  it('reports a failed op without stopping later ops', () => {
    const cache = seeded();
    const out = patchCache(cache, {
      operations: [
        { type: 'modify', fields: { a: { action: 'SET', value: 10 } } },
        { type: 'modify', id: 'Nope:1', fields: { x: { action: 'DELETE' } } },
        { type: 'modify', fields: { b: { action: 'SET', value: 20 } } },
      ],
    });
    expect(out.results).toHaveLength(3);
    expect(out.results[1]).toMatchObject({ changed: false, error: 'entity not found' });
    expect(out.results[2].changed).toBe(true);
  });

  it('atomic: rolls back earlier ops when a later one throws at runtime', () => {
    const cache = seeded();
    const realModify = cache.modify.bind(cache);
    let calls = 0;
    cache.modify = ((o: Parameters<typeof realModify>[0]) => {
      if (++calls === 2) throw new Error('boom');
      return realModify(o);
    }) as typeof cache.modify;
    const before = JSON.stringify(cache.extract());
    const out = patchCache(cache, {
      atomic: true,
      operations: [
        { type: 'modify', fields: { a: { action: 'SET', value: 999 } } },
        { type: 'modify', fields: { b: { action: 'SET', value: 5 } } },
      ],
    });
    expect(out.results[1].error).toBeDefined();
    expect(out.results.every((r) => !r.changed)).toBe(true);
    expect(JSON.stringify(cache.extract())).toBe(before);
  });

  it('atomic: rolls back earlier ops when a later target is missing', () => {
    const cache = seeded();
    const before = cache.extract();

    const out = patchCache(cache, {
      atomic: true,
      operations: [
        { type: 'modify', fields: { a: { action: 'SET', value: 10 } } },
        { type: 'modify', id: 'Nope:1', fields: { x: { action: 'DELETE' } } },
      ],
    });

    expect(out.results.map(({ changed, error }) => ({ changed, error }))).toEqual([
      { changed: false, error: undefined },
      { changed: false, error: 'entity not found' },
    ]);
    expect(cache.extract()).toEqual(before);
  });

  it('non-atomic (default): keeps earlier ops applied when a later one throws', () => {
    const cache = seeded();
    const realModify = cache.modify.bind(cache);
    let calls = 0;
    cache.modify = ((o: Parameters<typeof realModify>[0]) => {
      if (++calls === 2) throw new Error('boom');
      return realModify(o);
    }) as typeof cache.modify;
    patchCache(cache, {
      operations: [
        { type: 'modify', fields: { a: { action: 'SET', value: 999 } } },
        { type: 'modify', fields: { b: { action: 'SET', value: 5 } } },
      ],
    });
    expect((cache.extract().ROOT_QUERY as { a: number }).a).toBe(999);
  });

  it('zod rejects a malformed batch before mutating anything', () => {
    const cache = seeded();
    const before = JSON.stringify(cache.extract());
    expect(() =>
      patchCache(cache, {
        operations: [
          { type: 'modify', fields: { a: { action: 'SET', value: 999 } } },
          { type: 'evict' },
        ],
      }),
    ).toThrow();
    expect(JSON.stringify(cache.extract())).toBe(before);
  });

  it('rejects __proto__ as a field name', () => {
    const cache = seeded();
    const ops = JSON.parse(
      '[{"type":"modify","fields":{"__proto__":{"action":"DELETE"}}}]',
    );
    expect(() => patchCache(cache, { operations: ops })).toThrow();
    expect(({} as Record<string, unknown>).action).toBeUndefined();
  });
});
