/**
 * Shared state for the cache-diagnosis graph.
 *
 * The flow is inspector -> reasoner -> patcher, and each node owns exactly one
 * channel: the inspector writes `findings`, the reasoner writes
 * `proposedPatches`, the patcher writes `messages`. Only `messages` accumulates
 * — the other channels are last-write-wins, because re-running a node means
 * re-analyzing the same cache, and appending there would duplicate every
 * finding on the second pass.
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

import type { Finding, PatchOperation } from '../schemas/tools.js';
import type { NormalizedCacheObject } from '@apollo/client';

export const CacheAgentAnnotation = Annotation.Root({
  /** Serialized `cache.extract()` output under diagnosis. Set by the caller. */
  cacheState: Annotation<NormalizedCacheObject>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),

  /** What the inspector found. Empty array means a clean cache. */
  findings: Annotation<Finding[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** Declarative repairs the reasoner derived from `findings`. */
  proposedPatches: Annotation<PatchOperation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** Human-readable narration of the run; the only accumulating channel. */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export type CacheAgentState = typeof CacheAgentAnnotation.State;
export type CacheAgentUpdate = typeof CacheAgentAnnotation.Update;
