/**
 * Memory for the cache agent: short-term conversation state vs. long-term
 * persistent recall, kept as two separate stores rather than one blended
 * cache because they have different eviction policies.
 *
 * Short-term: a per-session ring buffer of recent graph turns. Pure
 * in-process state — gone on restart, capped so a long-running session
 * (an MCP server process) can't leak memory turn over turn.
 *
 * Long-term: a per-session key/value table of distilled facts (currently:
 * findings), each stamped with when it was written and whether it came from
 * a verified fresh inspection this turn. It's a plain JSON file behind a Map,
 * not SQLite — this ships inside an npm package, and a JSON blob keeps the
 * published tarball free of a native dependency. Swap the persist/load pair
 * for a real embedded DB if the per-session record count ever outgrows one
 * JSON parse.
 *
 * Retrieval is deliberately narrow: `retrieveContext` returns at most
 * `maxItems` records for one session, newest first, with anything older than
 * `staleAfterMs` dropped before the cap is applied — a caller can't
 * accidentally pull the whole store into a prompt or a graph state channel.
 *
 * Conflict resolution: `resolveConflict` always prefers a fresh, verified
 * input over a retrieved record for the same key. A retrieved record only
 * gets a say when the current turn has no fresh opinion on that key at all.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { assertSafeInput } from '../security/guardrails.js';

export interface ConversationTurn<F = unknown, P = unknown> {
  turnId: number;
  timestamp: number;
  findings: F[];
  proposedPatches: P[];
}

export interface MemoryRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
  /** True only for values re-derived from a fresh, directly-inspected source this turn. */
  verified: boolean;
}

export interface MemoryStoreOptions {
  /** File to persist the long-term table to. Omit to keep it in-process only. */
  persistPath?: string;
  /** Ring buffer size per session for short-term turns. Default 20. */
  maxShortTermTurns?: number;
  /** Age past which a long-term record is dropped from retrieval. Default 24h. */
  staleAfterMs?: number;
}

const DEFAULT_MAX_SHORT_TERM_TURNS = 20;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRIEVED_ITEMS = 10;

export class MemoryStore {
  private readonly shortTerm = new Map<string, ConversationTurn[]>();
  private readonly longTerm = new Map<string, Map<string, MemoryRecord>>();
  private readonly maxShortTermTurns: number;
  private readonly staleAfterMs: number;
  private readonly persistPath?: string;
  private turnCounter = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxShortTermTurns = opts.maxShortTermTurns ?? DEFAULT_MAX_SHORT_TERM_TURNS;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.persistPath = opts.persistPath;
    if (this.persistPath) this.load(this.persistPath);
  }

  // ---------------------------------------------------------------------
  // Short-term: this session's conversation graph state
  // ---------------------------------------------------------------------

  /** Append a turn to the session's ring buffer, dropping the oldest once full. */
  recordTurn<F, P>(
    sessionId: string,
    turn: { findings: F[]; proposedPatches: P[] },
    now = Date.now(),
  ): ConversationTurn<F, P> {
    const full: ConversationTurn<F, P> = { ...turn, turnId: ++this.turnCounter, timestamp: now };
    const turns = this.shortTerm.get(sessionId) ?? [];
    turns.push(full as ConversationTurn);
    while (turns.length > this.maxShortTermTurns) turns.shift();
    this.shortTerm.set(sessionId, turns);
    return full;
  }

  /** Every turn still in the ring buffer for this session, oldest first. */
  getShortTerm<F = unknown, P = unknown>(sessionId: string): ConversationTurn<F, P>[] {
    return [...(this.shortTerm.get(sessionId) ?? [])] as ConversationTurn<F, P>[];
  }

  // ---------------------------------------------------------------------
  // Long-term: persistent key/value recall
  // ---------------------------------------------------------------------

  remember(sessionId: string, key: string, value: unknown, opts: { verified?: boolean; now?: number } = {}): void {
    // sessionId ends up as a plain-object key in persist()'s dump — guard it
    // here, the one place a caller-supplied sessionId enters longTerm at all.
    assertSafeInput({ [sessionId]: null }, { label: 'sessionId' });
    const bucket = this.longTerm.get(sessionId) ?? new Map<string, MemoryRecord>();
    bucket.set(key, { key, value, updatedAt: opts.now ?? Date.now(), verified: opts.verified ?? false });
    this.longTerm.set(sessionId, bucket);
    if (this.persistPath) this.persist(this.persistPath);
  }

  recall(sessionId: string, key: string): MemoryRecord | undefined {
    return this.longTerm.get(sessionId)?.get(key);
  }

  /** Targeted, budget-limited retrieval: newest `maxItems` non-stale records for this session. */
  retrieveContext(
    sessionId: string,
    opts: { maxItems?: number; now?: number } = {},
  ): MemoryRecord[] {
    const maxItems = opts.maxItems ?? DEFAULT_MAX_RETRIEVED_ITEMS;
    const now = opts.now ?? Date.now();
    const bucket = this.longTerm.get(sessionId);
    if (!bucket) return [];

    return [...bucket.values()]
      .filter((r) => now - r.updatedAt <= this.staleAfterMs)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxItems);
  }

  // ---------------------------------------------------------------------
  // Conflict resolution
  // ---------------------------------------------------------------------

  /**
   * Pick between a fresh current-turn value and a retrieved memory record for
   * the same key. A verified fresh value always wins; an unverified fresh
   * value still wins over nothing; a retrieved record only speaks when the
   * current turn has no fresh value for that key at all.
   */
  resolveConflict<T>(
    fresh: { value: T; verified: boolean } | undefined,
    retrieved: MemoryRecord<T> | undefined,
  ): T | undefined {
    if (fresh?.verified) return fresh.value;
    if (fresh) return fresh.value;
    return retrieved?.value;
  }

  private persist(path: string): void {
    const dump: Record<string, Record<string, MemoryRecord>> = {};
    for (const [sessionId, bucket] of this.longTerm) dump[sessionId] = Object.fromEntries(bucket);
    writeFileSync(path, JSON.stringify(dump), 'utf8');
  }

  private load(path: string): void {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, MemoryRecord>>;
      for (const [sessionId, records] of Object.entries(raw)) {
        this.longTerm.set(sessionId, new Map(Object.entries(records)));
      }
    } catch {
      // No file yet, or it's unreadable — start empty rather than throw.
    }
  }
}

/**
 * Process-wide default store, in the same singleton style as `cacheAgentGraph`.
 * In-process only (no `persistPath`) — a consumer that needs disk persistence
 * constructs its own `MemoryStore` instead.
 */
export const memoryStore = new MemoryStore();
