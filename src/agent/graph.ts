/**
 * The cache-diagnosis graph: inspect -> reason -> plan.
 *
 * Deliberately LLM-free. Every defect this copilot knows about has a
 * mechanical repair (prune the pointer, evict the orphan), so a model would
 * only add latency, cost and nondeterminism to a decision a switch statement
 * already makes correctly. The graph earns its keep as orchestration —
 * short-circuiting a clean cache, keeping channel ownership honest, and
 * narrating each step — not as reasoning.
 */

import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';

import { CacheAgentAnnotation, type CacheAgentState, type CacheAgentUpdate } from './state.js';
import { inspectDanglingRefs } from '../tools/inspectDanglingRefs.js';
import { getActiveTracer } from '../telemetry/tracer.js';
import { memoryStore } from '../memory/store.js';
import type { Finding, PatchOperation } from '../schemas/tools.js';

/** Findings retrieved from memory this run — cap keeps the reconcile step off the whole store. */
const MEMORY_RETRIEVAL_BUDGET = 10;

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

/**
 * Split `User:2.posts.1` into `{ entityKey: 'User:2', field: 'posts' }`.
 *
 * The entity key ends at the FIRST `.` — cache keys are `Type:id`, never dotted.
 * Trailing numeric segments are list indices from the walker; anything else in
 * the remainder is part of the field name, which is what keeps ROOT_QUERY
 * arg-keys like `user({"id":"1.5"})` intact.
 */
function parseFieldPath(path: string): { entityKey: string; field: string } | undefined {
  const dot = path.indexOf('.');
  if (dot === -1) return undefined;

  const segments = path.slice(dot + 1).split('.');
  while (segments.length > 1 && /^\d+$/.test(segments[segments.length - 1])) segments.pop();

  return { entityKey: path.slice(0, dot), field: segments.join('.') };
}

/** Entity key a finding's path belongs to — the path itself when it carries no field (e.g. `UNREACHABLE_ENTITY`). */
function entityKeyOf(path: string): string {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

/** Long-term memory key for one finding — kind + path, so distinct defects on the same entity don't collide. */
function memoryKey(finding: Finding): string {
  return `${finding.kind}:${finding.path}`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Plural-aware count phrase, e.g. `2 orphaned refs`. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function summarize(findings: Finding[]): string {
  if (findings.length === 0) return 'Cache is clean: no findings.';

  const by = (kind: Finding['kind']) => findings.filter((f) => f.kind === kind).length;
  const parts: string[] = [];
  if (by('ORPHANED_REF')) parts.push(count(by('ORPHANED_REF'), 'orphaned ref', 'orphaned refs'));
  if (by('UNREACHABLE_ENTITY'))
    parts.push(count(by('UNREACHABLE_ENTITY'), 'unreachable entity', 'unreachable entities'));
  if (by('MISSING_TYPENAME'))
    parts.push(count(by('MISSING_TYPENAME'), 'missing __typename', 'missing __typenames'));
  if (by('MISSING_ID')) parts.push(count(by('MISSING_ID'), 'missing id', 'missing ids'));
  if (by('UNSCOPED_IDENTITY_FIELD'))
    parts.push(count(by('UNSCOPED_IDENTITY_FIELD'), 'identity-scoped field flagged', 'identity-scoped fields flagged'));

  return `${count(findings.length, 'finding', 'findings')}: ${parts.join(', ')}.`;
}

export function inspectorNode(state: CacheAgentState): CacheAgentUpdate {
  const { findings } = getActiveTracer().measure(
    'inspector',
    () => inspectDanglingRefs({ cache: state.cacheState, includeIdentityRisk: true }),
    { entityCount: (r) => r.findings.length },
  );
  return { findings, messages: [new AIMessage(summarize(findings))] };
}

function reason(state: CacheAgentState): CacheAgentUpdate {
  /** entityKey -> merged field patches, so one entity yields one `modify`. */
  const modifies = new Map<string, PatchOperation & { type: 'modify' }>();
  const evictKeys = new Set<string>();
  let skipped = 0;

  for (const finding of state.findings) {
    switch (finding.kind) {
      case 'ORPHANED_REF': {
        const parsed = parseFieldPath(finding.path);
        if (!parsed) break; // a ref directly at an entity root isn't a field we can modify
        let op = modifies.get(parsed.entityKey);
        if (!op) {
          op = {
            type: 'modify',
            id: parsed.entityKey,
            fields: {},
            optimistic: false,
            broadcast: true,
          };
          modifies.set(parsed.entityKey, op);
        }
        op.fields[parsed.field] = { action: 'PRUNE_DANGLING_REFS' };
        break;
      }

      case 'UNREACHABLE_ENTITY':
        evictKeys.add(finding.path);
        break;

      // Unkeyable inline objects are a defect in the query/fragment, not in the
      // stored data. No cache mutation repairs them — evicting just re-fetches
      // the same shape — so they are reported and left alone. Unscoped
      // identity fields are the same story from the other direction: the
      // real fix (clearStore() at the identity boundary) is app code, not a
      // cache mutation, so there's nothing here to propose either.
      case 'MISSING_TYPENAME':
      case 'MISSING_ID':
      case 'UNSCOPED_IDENTITY_FIELD':
        skipped += 1;
        break;
    }
  }

  // Modifies before evicts: drop the pointer first, then collect the target.
  const proposedPatches: PatchOperation[] = [
    ...modifies.values(),
    ...[...evictKeys].map<PatchOperation>((id) => ({ type: 'evict', id, broadcast: true })),
  ];

  const narration =
    proposedPatches.length === 0
      ? 'No patches proposed.'
      : `Proposing ${count(modifies.size, 'modify', 'modifies')} (${[...modifies.keys()].join(', ')})` +
        ` and ${count(evictKeys.size, 'evict', 'evicts')}` +
        (evictKeys.size ? ` (${[...evictKeys].join(', ')})` : '') +
        '.';

  const skipNote = skipped
    ? ` Skipped ${count(skipped, 'unpatchable finding', 'unpatchable findings')}:` +
      ' these are query/fragment or identity-scoping defects, not cache corruption, and cannot be repaired by' +
      ' mutating the cache.'
    : '';

  return { proposedPatches, messages: [new AIMessage(narration + skipNote)] };
}

/**
 * Recall + conflict resolution. No-op when the caller didn't set `sessionId`
 * (the default), so a plain `cacheAgentGraph.invoke({ cacheState })` behaves
 * exactly as it did before memory existed.
 *
 * A retrieved finding only gets resurrected when its entity is entirely
 * absent from this turn's `cacheState` — i.e. this snapshot never covered
 * it, so memory is the only opinion available. Any entity the snapshot does
 * cover is settled by the fresh inspection, even when that inspection found
 * nothing there anymore: fresh, verified data always outranks a memory of a
 * past turn.
 */
function reconcile(state: CacheAgentState): CacheAgentUpdate {
  if (!state.sessionId) return {};

  const freshEntityKeys = new Set(Object.keys(state.cacheState));
  const retrieved = memoryStore.retrieveContext(state.sessionId, { maxItems: MEMORY_RETRIEVAL_BUDGET });

  const recovered = retrieved
    .map((r) => r.value as Finding)
    .filter((f) => !freshEntityKeys.has(entityKeyOf(f.path)));

  if (recovered.length === 0) return {};

  return {
    findings: [...state.findings, ...recovered],
    messages: [
      new AIMessage(
        `Recovered ${count(recovered.length, 'finding', 'findings')} from memory for entities this snapshot ` +
          'did not cover.',
      ),
    ],
  };
}

export function reconcileNode(state: CacheAgentState): CacheAgentUpdate {
  return getActiveTracer().measure('reconcile', () => reconcile(state));
}

export function reasonerNode(state: CacheAgentState): CacheAgentUpdate {
  return getActiveTracer().measure('reasoner', () => reason(state), {
    entityCount: () => state.findings.length,
  });
}

/**
 * Plans rather than applies: the graph only ever sees a serialized snapshot, so
 * the live `InMemoryCache` stays the caller's to patch via `patchCache`.
 */
function plan(state: CacheAgentState): CacheAgentUpdate {
  const targets = state.proposedPatches.map((op) => `${op.type} ${op.id}`).join(', ');
  const narration = state.proposedPatches.length
    ? `Ready to apply ${count(state.proposedPatches.length, 'operation', 'operations')} via patchCache: ${targets}.`
    : 'Nothing to apply.';

  return { messages: [new AIMessage(narration)] };
}

export function patcherNode(state: CacheAgentState): CacheAgentUpdate {
  return getActiveTracer().measure('patcher', () => plan(state), {
    entityCount: () => state.proposedPatches.length,
  });
}

/**
 * Commit this turn's findings to long-term memory (verified — they're fresh)
 * and append the turn to the short-term ring buffer. No-op without a
 * `sessionId`, same as `reconcile`.
 */
function commit(state: CacheAgentState): CacheAgentUpdate {
  if (!state.sessionId) return {};

  memoryStore.recordTurn(state.sessionId, { findings: state.findings, proposedPatches: state.proposedPatches });
  for (const finding of state.findings) {
    memoryStore.remember(state.sessionId, memoryKey(finding), finding, { verified: true });
  }
  return {};
}

export function commitNode(state: CacheAgentState): CacheAgentUpdate {
  return getActiveTracer().measure('commit', () => commit(state), {
    entityCount: () => state.findings.length,
  });
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export function buildCacheAgentGraph() {
  return new StateGraph(CacheAgentAnnotation)
    .addNode('inspector', inspectorNode)
    .addNode('reconcile', reconcileNode)
    .addNode('reasoner', reasonerNode)
    .addNode('patcher', patcherNode)
    .addNode('commit', commitNode)
    .addEdge(START, 'inspector')
    .addEdge('inspector', 'reconcile')
    // A clean cache has nothing to reason about — skip straight to commit
    // rather than burning a pass that can only produce an empty patch list.
    // Memory can still add findings in `reconcile` (a stale entity this
    // snapshot didn't cover), so the check runs after it, not before.
    .addConditionalEdges('reconcile', (state: CacheAgentState) =>
      state.findings.length === 0 ? 'commit' : 'reasoner',
    )
    .addEdge('reasoner', 'patcher')
    .addEdge('patcher', 'commit')
    .addEdge('commit', END)
    .compile();
}

export const cacheAgentGraph = buildCacheAgentGraph();
