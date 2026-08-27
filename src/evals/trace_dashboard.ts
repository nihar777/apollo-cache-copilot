/**
 * Day 9 trace dashboard — runs every case in `dataset.ts` through
 * `runDiagnoseCacheGraph` / `runPatchCache`, collects the `TraceExport` each
 * call already produces (see `src/telemetry/tracer.ts`), and aggregates span
 * latency by name: count, avg, max, total cost. Bottlenecks are whatever
 * spans land in the slowest 20% by avg latency — flagged, not gated; this is
 * a visibility tool, not a pass/fail gate like `runner.ts`.
 *
 * Run with `npm run eval:trace`.
 */

import { runDiagnoseCacheGraph, runPatchCache } from '../mcp/server.js';
import type { TraceEvent, TraceExport } from '../telemetry/tracer.js';
import { EVAL_CASES } from './dataset.js';

interface SpanStats {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  totalCostUsd: number;
}

function collectTraces(traces: TraceExport[]): Map<string, SpanStats> {
  const byName = new Map<string, SpanStats>();

  for (const trace of traces) {
    for (const event of trace.events) {
      const stats = byName.get(event.name) ?? {
        name: event.name,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        errors: 0,
        totalCostUsd: 0,
      };
      stats.count += 1;
      stats.totalMs += event.durationMs;
      stats.maxMs = Math.max(stats.maxMs, event.durationMs);
      stats.errors += event.status === 'error' ? 1 : 0;
      stats.totalCostUsd += event.tokenCostUsd;
      byName.set(event.name, stats);
    }
  }

  return byName;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function padNum(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}

async function main() {
  const diagnoseTraces: TraceExport[] = [];
  const patchTraces: TraceExport[] = [];
  let recordedEvents = 0;
  let unrecordedRuns = 0;

  for (const evalCase of EVAL_CASES) {
    const diagnosis = await runDiagnoseCacheGraph({ cache: evalCase.cache });
    if (diagnosis.trace) {
      diagnoseTraces.push(diagnosis.trace);
      recordedEvents += diagnosis.trace.events.length;
    } else {
      unrecordedRuns += 1;
    }

    if (diagnosis.proposedPatches.length === 0) continue;

    const patched = runPatchCache({
      cache: evalCase.cache,
      operations: diagnosis.proposedPatches,
      gc: true,
      dryRun: false,
    });
    if (patched.trace) {
      patchTraces.push(patched.trace);
      recordedEvents += patched.trace.events.length;
    } else {
      unrecordedRuns += 1;
    }
  }

  const byName = collectTraces([...diagnoseTraces, ...patchTraces]);
  const rows = [...byName.values()].map((s) => ({ ...s, avgMs: s.totalMs / s.count }));
  rows.sort((a, b) => b.avgMs - a.avgMs);

  const bottleneckCount = Math.max(1, Math.ceil(rows.length * 0.2));
  const bottlenecks = new Set(rows.slice(0, bottleneckCount).map((r) => r.name));

  const nameW = Math.max(4, ...rows.map((r) => r.name.length)) + 2;

  console.log('');
  console.log('='.repeat(nameW + 60));
  console.log('  Day 9 Trace Dashboard — Apollo Cache Copilot');
  console.log('='.repeat(nameW + 60));
  console.log('');
  console.log(`Runs: ${EVAL_CASES.length} eval case(s) | ${diagnoseTraces.length + patchTraces.length} trace(s) | ${recordedEvents} span(s) recorded`);
  console.log('');
  console.log(
    `${pad('SPAN', nameW)}${padNum('COUNT', 7)}${padNum('AVG ms', 10)}${padNum('MAX ms', 10)}${padNum('ERRORS', 8)}  BOTTLENECK`,
  );
  console.log('-'.repeat(nameW + 60));

  for (const r of rows) {
    const flag = bottlenecks.has(r.name) ? '⚠ slowest 20%' : '';
    console.log(
      `${pad(r.name, nameW)}${padNum(String(r.count), 7)}${padNum(r.avgMs.toFixed(2), 10)}${padNum(r.maxMs.toFixed(2), 10)}${padNum(String(r.errors), 8)}  ${flag}`,
    );
  }

  console.log('-'.repeat(nameW + 60));
  console.log('');

  if (rows.length === 0) {
    console.error('RESULT: FAIL — no spans recorded across any eval case.');
    process.exitCode = 1;
    return;
  }

  if (unrecordedRuns > 0) {
    console.error(`RESULT: FAIL — ${unrecordedRuns} run(s) produced no trace at all.`);
    process.exitCode = 1;
    return;
  }

  const anyError = rows.some((r) => r.errors > 0);
  console.log(anyError ? 'RESULT: PASS (with span errors — see table above)' : 'RESULT: PASS');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
