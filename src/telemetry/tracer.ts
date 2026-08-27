/**
 * Telemetry tracer — per-run latency/memory/entity-count spans.
 *
 * Zero-LLM engine, so `tokenCostUsd` is always 0; it's tracked anyway so the
 * trace shape matches what a future LLM-backed node would need to report.
 *
 * Node functions (`inspectorNode` / `reasonerNode` / `patcherNode`) call
 * `getActiveTracer()` and record through whatever tracer is live on the
 * `AsyncLocalStorage` context — that's what lets a single `cacheAgentGraph`
 * built once (module load) still get per-run, per-node spans without wiring a
 * tracer through `CacheAgentState` as a new channel. Outside a `withTracer`
 * scope, `getActiveTracer()` returns a no-op so unit tests that call the node
 * functions directly (no tracer scope) are unaffected.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type StepStatus = 'success' | 'error' | 'retry';

export interface TraceEvent {
  name: string;
  status: StepStatus;
  durationMs: number;
  memoryDeltaBytes: number;
  /** Always 0 — this engine has no LLM calls to meter. */
  tokenCostUsd: number;
  entityCount?: number;
  error?: string;
}

export interface TraceExport {
  events: TraceEvent[];
  totalDurationMs: number;
  totalTokenCostUsd: number;
}

interface MeasureOptions<T> {
  /** Derive the processed-entity count from a successful result. */
  entityCount?: (result: T) => number;
}

export class Tracer {
  private readonly events: TraceEvent[] = [];

  /** Wrap a synchronous step. Records success/error, rethrows on failure. */
  measure<T>(name: string, fn: () => T, opts: MeasureOptions<T> = {}): T {
    const startNs = process.hrtime.bigint();
    const startMem = process.memoryUsage().heapUsed;
    try {
      const result = fn();
      this.push(name, 'success', startNs, startMem, opts.entityCount?.(result));
      return result;
    } catch (err) {
      this.push(name, 'error', startNs, startMem, undefined, String(err));
      throw err;
    }
  }

  /** Wrap an asynchronous step. Same recording semantics as `measure`. */
  async measureAsync<T>(name: string, fn: () => Promise<T>, opts: MeasureOptions<T> = {}): Promise<T> {
    const startNs = process.hrtime.bigint();
    const startMem = process.memoryUsage().heapUsed;
    try {
      const result = await fn();
      this.push(name, 'success', startNs, startMem, opts.entityCount?.(result));
      return result;
    } catch (err) {
      this.push(name, 'error', startNs, startMem, undefined, String(err));
      throw err;
    }
  }

  /** Log an event with no code to measure around, e.g. a manually-observed retry. */
  record(name: string, status: StepStatus, meta: { entityCount?: number; error?: string } = {}): void {
    this.events.push({
      name,
      status,
      durationMs: 0,
      memoryDeltaBytes: 0,
      tokenCostUsd: 0,
      ...meta,
    });
  }

  export(): TraceExport {
    return {
      events: [...this.events],
      totalDurationMs: this.events.reduce((sum, e) => sum + e.durationMs, 0),
      totalTokenCostUsd: 0,
    };
  }

  private push(
    name: string,
    status: StepStatus,
    startNs: bigint,
    startMem: number,
    entityCount: number | undefined,
    error?: string,
  ): void {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const memoryDeltaBytes = process.memoryUsage().heapUsed - startMem;
    this.events.push({
      name,
      status,
      durationMs,
      memoryDeltaBytes,
      tokenCostUsd: 0,
      ...(entityCount !== undefined && { entityCount }),
      ...(error !== undefined && { error }),
    });
  }
}

/** No-op stand-in so node functions can call `getActiveTracer()` unconditionally. */
const noopTracer: Pick<Tracer, 'measure' | 'measureAsync' | 'record'> = {
  measure: (_name, fn) => fn(),
  measureAsync: (_name, fn) => fn(),
  record: () => {},
};

const tracerStorage = new AsyncLocalStorage<Tracer>();

/** The tracer for the current async context, or a no-op outside any `withTracer` scope. */
export function getActiveTracer(): Pick<Tracer, 'measure' | 'measureAsync' | 'record'> {
  return tracerStorage.getStore() ?? noopTracer;
}

/** Run `fn` with a fresh tracer active for its whole async call chain, then export it. */
export async function withTracer<T>(fn: () => Promise<T>): Promise<{ result: T; trace: TraceExport }> {
  const tracer = new Tracer();
  const result = await tracerStorage.run(tracer, fn);
  return { result, trace: tracer.export() };
}

// ---------------------------------------------------------------------------
// CLI formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '+';
  const kb = Math.abs(bytes) / 1024;
  return `${sign}${kb.toFixed(1)}KB`;
}

/** Pure formatter — callers decide where the string goes (stdout, stderr, nowhere). */
export function formatTraceSummary(trace: TraceExport): string {
  const lines = ['━━ Telemetry ━━', ''];

  for (const e of trace.events) {
    const icon = e.status === 'success' ? '✓' : e.status === 'retry' ? '↻' : '✗';
    const entities = e.entityCount !== undefined ? ` entities=${e.entityCount}` : '';
    lines.push(
      `  ${icon} ${e.name}  ${e.durationMs.toFixed(2)}ms  mem${formatBytes(e.memoryDeltaBytes)}` +
        `${entities}  cost=$${e.tokenCostUsd.toFixed(2)}` +
        (e.error ? `  (${e.error})` : ''),
    );
  }

  lines.push('', `Total: ${trace.totalDurationMs.toFixed(2)}ms | $${trace.totalTokenCostUsd.toFixed(2)}`);
  return lines.join('\n');
}
