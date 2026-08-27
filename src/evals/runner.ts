/**
 * Day 8 eval runner — executes `runDiagnoseCacheGraph` + `runPatchCache`
 * across every case in `dataset.ts` and grades three things:
 *
 *   - Task Success Rate: did diagnosis find exactly the expected findings?
 *   - Zero-Error Patch Execution: did every proposed patch op apply cleanly?
 *   - Rule Safety Rate: after patching, are the fixable defects (dangling
 *     refs, unreachable entities) actually gone, with nothing new broken?
 *
 * Run with `npm run eval`.
 */

import { inspectDanglingRefs } from '../tools/inspectDanglingRefs.js';
import { runDiagnoseCacheGraph, runPatchCache } from '../mcp/server.js';
import type { Finding, FindingKind } from '../schemas/tools.js';
import { EVAL_CASES, type EvalCase } from './dataset.js';

const FINDING_KINDS: FindingKind[] = [
  'ORPHANED_REF',
  'MISSING_TYPENAME',
  'MISSING_ID',
  'UNREACHABLE_ENTITY',
  'UNSCOPED_IDENTITY_FIELD',
];

const FIXABLE_KINDS = new Set<FindingKind>(['ORPHANED_REF', 'UNREACHABLE_ENTITY']);

function countByKind(findings: Finding[]): Partial<Record<FindingKind, number>> {
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

function countsMatch(
  actual: Partial<Record<FindingKind, number>>,
  expected: Partial<Record<FindingKind, number>>,
): boolean {
  return FINDING_KINDS.every((kind) => (actual[kind] ?? 0) === (expected[kind] ?? 0));
}

interface CaseResult {
  evalCase: EvalCase;
  taskSuccess: boolean;
  actualCounts: Partial<Record<FindingKind, number>>;
  patchOpCount: number;
  patchErrorCount: number;
  ruleSafe: boolean;
  note?: string;
}

async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  const diagnosis = await runDiagnoseCacheGraph({ cache: evalCase.cache });
  const actualCounts = countByKind(diagnosis.findings);
  const taskSuccess = countsMatch(actualCounts, evalCase.expectedFindingCounts);

  if (diagnosis.proposedPatches.length === 0) {
    return { evalCase, taskSuccess, actualCounts, patchOpCount: 0, patchErrorCount: 0, ruleSafe: true };
  }

  const patched = runPatchCache({
    cache: evalCase.cache,
    operations: diagnosis.proposedPatches,
    gc: true,
    dryRun: false,
  });

  const patchErrorCount = patched.results.filter((r) => r.error).length;
  const zeroErrorPatch = patchErrorCount === 0;

  const postFindings = inspectDanglingRefs({ cache: patched.cache }).findings;
  const remainingFixable = postFindings.filter((f) => FIXABLE_KINDS.has(f.kind)).length;

  const ruleSafe = zeroErrorPatch && remainingFixable === 0;
  const note = !ruleSafe
    ? `${patchErrorCount} patch error(s), ${remainingFixable} fixable finding(s) survived`
    : undefined;

  return {
    evalCase,
    taskSuccess,
    actualCounts,
    patchOpCount: diagnosis.proposedPatches.length,
    patchErrorCount,
    ruleSafe,
    note,
  };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function pct(n: number, d: number): string {
  return d === 0 ? '100.0%' : `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const results: CaseResult[] = [];
  for (const evalCase of EVAL_CASES) {
    results.push(await runCase(evalCase));
  }

  const total = results.length;
  const successes = results.filter((r) => r.taskSuccess).length;
  const safe = results.filter((r) => r.ruleSafe).length;
  const totalPatchOps = results.reduce((sum, r) => sum + r.patchOpCount, 0);
  const totalPatchErrors = results.reduce((sum, r) => sum + r.patchErrorCount, 0);

  const nameW = Math.max(...results.map((r) => r.evalCase.name.length)) + 2;
  const catW = 12;

  console.log('');
  console.log('='.repeat(nameW + catW + 24));
  console.log('  Day 8 Eval Suite — Apollo Cache Copilot');
  console.log('='.repeat(nameW + catW + 24));
  console.log('');
  console.log(`${pad('CASE', nameW)}${pad('CATEGORY', catW)}${pad('DIAGNOSIS', 12)}${pad('PATCH SAFETY', 14)}`);
  console.log('-'.repeat(nameW + catW + 26));

  for (const r of results) {
    const diagCol = r.taskSuccess ? 'PASS' : 'FAIL';
    const safeCol = r.ruleSafe ? 'PASS' : 'FAIL';
    console.log(`${pad(r.evalCase.name, nameW)}${pad(r.evalCase.category, catW)}${pad(diagCol, 12)}${pad(safeCol, 14)}`);
    if (!r.taskSuccess) {
      console.log(
        `${' '.repeat(nameW)}  expected ${JSON.stringify(r.evalCase.expectedFindingCounts)}, got ${JSON.stringify(r.actualCounts)}`,
      );
    }
    if (r.note) {
      console.log(`${' '.repeat(nameW)}  ${r.note}`);
    }
  }

  console.log('-'.repeat(nameW + catW + 26));
  console.log('');
  console.log('Metrics:');
  console.log(`  Task Success Rate           : ${successes}/${total} (${pct(successes, total)})  [target >= 95%]`);
  console.log(`  Rule Safety Rate            : ${safe}/${total} (${pct(safe, total)})`);
  console.log(
    `  Zero-Error Patch Execution  : ${totalPatchOps - totalPatchErrors}/${totalPatchOps} (${pct(totalPatchOps - totalPatchErrors, totalPatchOps)})`,
  );
  console.log('');

  // Only Task Success Rate has a spec'd threshold. Rule Safety and Zero-Error
  // Patch Execution are reported, not gated — a below-100% safety rate means
  // the reasoner has a known repair gap (see dataset.ts / notes above), which
  // is exactly the kind of thing this suite exists to surface, not hide.
  const taskSuccessRate = total === 0 ? 1 : successes / total;
  const passed = taskSuccessRate >= 0.95;

  console.log(passed ? 'RESULT: PASS' : 'RESULT: FAIL');
  console.log('');

  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
