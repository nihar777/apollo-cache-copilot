import type { NormalizedCacheObject } from '@apollo/client';
import { InMemoryCache } from '@apollo/client/cache/index.js';
import { gql } from '@apollo/client/core/index.js';
import type { FragmentDefinitionNode, SelectionSetNode } from 'graphql';

import {
  CompareQueryToCacheInputSchema,
  CompareQueryToCacheOutputSchema,
  type CacheMiss,
  type CompareQueryToCacheOutput,
} from '../schemas/tools.js';

type MissingLeaf = { path: string[]; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSelections(
  value: unknown,
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, SelectionSetNode>,
  path: string,
  satisfied: Set<string>,
): void {
  if (!selectionSet || !isPlainObject(value)) return;

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      const key = selection.alias?.value ?? selection.name.value;
      if (key === '__typename') continue;

      const nextPath = path ? `${path}.${key}` : key;
      if (!(key in value) || value[key] === undefined) continue;

      satisfied.add(nextPath);
      const nextValue = value[key];

      if (Array.isArray(nextValue)) {
        nextValue.forEach((item, index) => {
          collectSelections(item, selection.selectionSet, fragments, `${nextPath}.${index}`, satisfied);
        });
      } else {
        collectSelections(nextValue, selection.selectionSet, fragments, nextPath, satisfied);
      }
      continue;
    }

    if (selection.kind === 'InlineFragment') {
      collectSelections(value, selection.selectionSet, fragments, path, satisfied);
      continue;
    }

    if (selection.kind === 'FragmentSpread') {
      const fragment = fragments.get(selection.name.value);
      collectSelections(value, fragment, fragments, path, satisfied);
    }
  }
}

function flattenMissingTree(missing: unknown, prefix: string[] = []): MissingLeaf[] {
  if (!isPlainObject(missing)) return [];

  const leaves: MissingLeaf[] = [];
  for (const [key, value] of Object.entries(missing)) {
    const nextPath = [...prefix, key];
    if (typeof value === 'string') {
      leaves.push({ path: nextPath, message: value });
      continue;
    }

    leaves.push(...flattenMissingTree(value, nextPath));
  }

  return leaves;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function inferEntityId(parentValue: unknown, message: string, fallback: string): string {
  if (isPlainObject(parentValue) && typeof parentValue.__typename === 'string') {
    const id = parentValue.id ?? parentValue._id;
    if (typeof id === 'string' || typeof id === 'number') {
      return `${parentValue.__typename}:${id}`;
    }
  }

  const sourceFromMessage = message.match(/ on ([^\s]+) object$/)?.[1];
  return sourceFromMessage ?? fallback;
}

function inferReason(message: string, parentValue: unknown): CacheMiss['reason'] {
  if (/Dangling reference to missing\s+/i.test(message)) return 'DANGLING_REF';

  if (isPlainObject(parentValue)) {
    const hasTypename = typeof parentValue.__typename === 'string';
    const hasId = parentValue.id !== undefined || parentValue._id !== undefined;
    if (!hasTypename || !hasId) return 'NOT_NORMALIZED';
  }

  return 'MISSING_FIELD';
}

export function compareQueryToCache(input: unknown): CompareQueryToCacheOutput {
  const args = CompareQueryToCacheInputSchema.parse(input);

  const query = gql(args.query);
  const cache = new InMemoryCache();
  cache.restore(args.cache as NormalizedCacheObject);

  let diff: ReturnType<InMemoryCache['diff']>;
  try {
    diff = cache.diff({
      query,
      variables: args.variables,
      id: args.rootId,
      returnPartialData: args.returnPartialData,
      optimistic: false,
    });
  } catch {
    diff = cache.diff({
      query,
      variables: args.variables,
      id: args.rootId,
      returnPartialData: true,
      optimistic: false,
    });
  }

  const fragments = new Map(
    query.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === 'FragmentDefinition',
      )
      .map((fragment) => [fragment.name.value, fragment.selectionSet]),
  );

  const satisfied = new Set<string>();
  for (const definition of query.definitions) {
    if (definition.kind !== 'OperationDefinition') continue;
    if (definition.operation !== 'query') continue;
    collectSelections(diff.result, definition.selectionSet, fragments, '', satisfied);
  }

  const misses: CacheMiss[] = [];
  const missingEntries = Array.isArray(diff.missing) ? diff.missing : [];
  for (const entry of missingEntries) {
    const tree = isPlainObject(entry) ? entry.missing : undefined;
    for (const leaf of flattenMissingTree(tree)) {
      const parentPath = leaf.path.slice(0, -1);
      const parentValue = readPath(diff.result, parentPath);
      misses.push({
        entityId: inferEntityId(parentValue, leaf.message, args.rootId),
        path: leaf.path.join('.'),
        reason: inferReason(leaf.message, parentValue),
        message: leaf.message,
      });
    }
  }

  return CompareQueryToCacheOutputSchema.parse({
    complete: Boolean(diff.complete),
    misses,
    satisfiedFields: [...satisfied],
  });
}
