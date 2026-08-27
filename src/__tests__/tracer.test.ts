/**
 * Telemetry tracer tests.
 *
 * Latency is asserted as "recorded and non-negative", not against a fixed
 * value — real wall-clock timing on a shared CI runner is not something a
 * test should pin to a millisecond.
 */

import { describe, expect, it } from 'vitest';

import { Tracer, formatTraceSummary, getActiveTracer, withTracer } from '../telemetry/tracer.js';

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

describe('Tracer.measure', () => {
  it('records latency and entity count for a successful step', () => {
    const tracer = new Tracer();

    const result = tracer.measure('inspect', () => {
      busyWait(2);
      return { findings: [1, 2, 3] };
    }, { entityCount: (r) => r.findings.length });

    expect(result.findings).toHaveLength(3);

    const [event] = tracer.export().events;
    expect(event.name).toBe('inspect');
    expect(event.status).toBe('success');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.entityCount).toBe(3);
    expect(event.tokenCostUsd).toBe(0);
  });

  it('records a failed step and rethrows', () => {
    const tracer = new Tracer();

    expect(() =>
      tracer.measure('patch', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const [event] = tracer.export().events;
    expect(event.status).toBe('error');
    expect(event.error).toContain('boom');
    expect(event.entityCount).toBeUndefined();
  });
});

describe('Tracer.measureAsync', () => {
  it('records latency for an async step', async () => {
    const tracer = new Tracer();

    await tracer.measureAsync('graph.invoke', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return 'done';
    });

    const [event] = tracer.export().events;
    expect(event.status).toBe('success');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a rejected async step and rethrows', async () => {
    const tracer = new Tracer();

    await expect(
      tracer.measureAsync('graph.invoke', async () => {
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');

    expect(tracer.export().events[0].status).toBe('error');
  });
});

describe('Tracer.record', () => {
  it('logs a manual event with no code to measure', () => {
    const tracer = new Tracer();
    tracer.record('retryable-step', 'retry', { entityCount: 5 });

    expect(tracer.export().events).toEqual([
      {
        name: 'retryable-step',
        status: 'retry',
        durationMs: 0,
        memoryDeltaBytes: 0,
        tokenCostUsd: 0,
        entityCount: 5,
      },
    ]);
  });
});

describe('Tracer.export', () => {
  it('sums durations across every event and always reports $0 cost', () => {
    const tracer = new Tracer();
    tracer.measure('a', () => busyWait(1));
    tracer.measure('b', () => busyWait(1));

    const trace = tracer.export();
    expect(trace.events).toHaveLength(2);
    expect(trace.totalDurationMs).toBeCloseTo(
      trace.events.reduce((sum, e) => sum + e.durationMs, 0),
      6,
    );
    expect(trace.totalTokenCostUsd).toBe(0);
  });
});

describe('getActiveTracer / withTracer', () => {
  it('is a no-op outside any withTracer scope', () => {
    expect(() => getActiveTracer().measure('noop', () => 1)).not.toThrow();
    expect(getActiveTracer().measure('noop', () => 42)).toBe(42);
  });

  it('exposes the active tracer to nested async work via AsyncLocalStorage', async () => {
    const { result, trace } = await withTracer(async () => {
      getActiveTracer().measure('inner', () => busyWait(1));
      await Promise.resolve();
      getActiveTracer().record('note', 'success');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(trace.events.map((e) => e.name)).toEqual(['inner', 'note']);
  });
});

describe('formatTraceSummary', () => {
  it('renders every event and the running total', () => {
    const tracer = new Tracer();
    tracer.measure('inspectDanglingRefs', () => busyWait(1), { entityCount: () => 7 });

    const summary = formatTraceSummary(tracer.export());
    expect(summary).toContain('inspectDanglingRefs');
    expect(summary).toContain('entities=7');
    expect(summary).toContain('cost=$0.00');
    expect(summary).toMatch(/Total: \d+\.\d\dms \| \$0\.00/);
  });
});
