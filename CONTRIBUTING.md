# Contributing

Thanks for looking. This is a small, sharply-scoped tool: it finds structural
defects in a serialized Apollo `InMemoryCache` and proposes mechanical repairs.
Contributions that keep that scope tight are the most welcome kind.

- **[Setup](#setup)** · **[The loop](#the-loop)** · **[Invariants](#invariants-that-break-silently)**
- **[Adding a defect kind](#adding-a-new-defect-kind)** · **[Tests](#tests)** · **[PRs](#opening-a-pull-request)**
- **[Good first issues](#good-first-issues)** · **[Releases](#releases)**

Architecture, in four diagrams: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
Read it before a first non-trivial change — it will save you an hour.

---

## Setup

Node **20 or newer**. CI runs 20.x and 22.x; Node 18 is deliberately excluded
(vitest 4 declares `^20 || ^22 || >=24`, `@langchain/core` declares `>=20`).

```bash
git clone https://github.com/nihar777/apollo-cache-copilot.git
cd apollo-cache-copilot
npm ci
npm run build      # do this first — see below
```

**Build before you test.** The integration and E2E suites, and
`tsconfig.test.json`, all resolve `dist/`. Against an absent build, typecheck
and vitest fail for reasons that have nothing to do with your change. CI runs
build → typecheck → test in that order for exactly this reason.

## The loop

```bash
npm run build       # tsc, emits dist/
npm run typecheck   # tsc --noEmit over src + tests + fixtures
npm test            # vitest run
npx vitest          # watch mode, while you work
```

Try it against a real cache without any MCP client:

```bash
node bin/apollo-copilot.js inspect path/to/snapshot.json
```

Any `JSON.stringify(client.cache.extract())` output works as the input file.

## Invariants that break silently

These are the ones that cost time. None of them fail loudly.

**1. stdout is the protocol channel.** In `src/mcp/server.ts` and `bin/*.js`, a
single `console.log` corrupts the JSON-RPC frame and the client disconnects with
no useful error. Diagnostics go to `console.error`. Always.

**2. Apollo 3.x ships no `exports` map.** Import with an explicit `/index.js` —
`@apollo/client/cache/index.js`, not `@apollo/client/cache`. The bare subpath is
a directory import: bundlers resolve it, real Node ESM rejects it, and only the
stdio binary notices. Nothing in the test suite will catch this for you.

**3. Only `messages` accumulates.** Every other channel in
[`src/agent/state.ts`](src/agent/state.ts) uses `(_prev, next) => next`.
Re-running a node re-analyzes the *same* cache, so an appending reducer on
`findings` duplicates every finding on the second pass.

**4. Modifies come before evicts.** In `reasonerNode`, prune-the-pointer
operations must be ordered ahead of evict-the-target operations. Reverse them
and you evict an entity while a live `__ref` still points at it.

**5. Return the original array when a prune drops nothing.** A fresh array is a
new identity, and Apollo broadcasts a no-op update to every watcher of that
field. See the `PRUNE_DANGLING_REFS` case in
[`src/tools/patchCache.ts`](src/tools/patchCache.ts).

**6. Entity keys are `Type:id` and never dotted.** `parseFieldPath` splits at
the **first** `.`; trailing numeric segments are list indices from the walker,
and everything else belongs to the field name. That is what keeps ROOT_QUERY
arg-keys like `user({"id":"1.5"})` intact.

**7. The graph has no LLM, on purpose.** Every defect currently detected has a
mechanical repair, so a model would add latency, cost and nondeterminism to a
decision a `switch` already makes correctly. A PR that introduces a model call
into `src/agent/` needs to argue for a defect class that *cannot* be repaired
mechanically — that argument is welcome, the code without it is not.

## Adding a new defect kind

This is the main extension seam, and it touches seven places. Miss one and the
failure is quiet, so work down the list:

| # | File | Change |
|---|---|---|
| 1 | `src/schemas/tools.ts` | add the kind to `FindingKindSchema` |
| 2 | `src/schemas/tools.ts` | add a `stats` counter to `InspectDanglingRefsOutputSchema` if it needs one |
| 3 | `src/tools/inspectDanglingRefs.ts` | emit the finding from the walker |
| 4 | `src/agent/graph.ts` | handle it in `reasonerNode`'s `switch` — either a repair, or an explicit skip with a comment saying why |
| 5 | `src/agent/graph.ts` | add it to `summarize()` so the narration counts it |
| 6 | `bin/apollo-copilot.js` | add it to the `kinds` array and the icon map, or the CLI silently omits it |
| 7 | `src/__mocks__/sampleCacheState.ts` | add a fixture with `expectedFindings` |

Step 4 is the one TypeScript helps with: the `switch` is exhaustive over
`Finding['kind']`, so a missing case is a typecheck error. Steps 5 and 6 are
plain arrays — nothing will remind you.

**If the defect is not mechanically repairable**, say so in a comment at step 4
and skip it there, the way `MISSING_TYPENAME` and `MISSING_ID` are skipped. Those
are query and fragment defects: evicting just re-fetches the same broken shape.

## Tests

`vitest`, colocated in `__tests__` directories, fixtures in `__mocks__`.

| Suite | Covers |
|---|---|
| `src/tools/__tests__/tools.test.ts` | the analyzer and the patcher, against fixtures |
| `src/agent/__tests__/agent.test.ts` | node behavior, channel ownership, the short-circuit |
| `src/mcp/__tests__/server.test.ts` | tool bodies, without a transport |
| `src/__tests__/integration.test.ts` | the wired server against `dist/` |
| `src/__tests__/e2e.test.ts` | diagnose → patch → re-inspect round trip |

**Assert against fixtures, not hand-copied lists.** Every fixture in
`src/__mocks__/sampleCacheState.ts` ships its own `expectedFindings`, so a
change in analyzer output updates in one place instead of drifting across five
test files. New defect kind, new fixture — same pattern.

The build must stay clean of tests: CI fails if anything matching `__tests__` or
`__mocks__` lands in `dist/`, which would mean `tsconfig.json`'s `exclude`
regressed.

## Opening a pull request

Small and focused beats large and thorough. One concern per PR.

Before you push:

- [ ] `npm run build && npm run typecheck && npm test` all pass locally
- [ ] a test fails without your change and passes with it
- [ ] no `console.log` anywhere reachable from `src/mcp/` or `bin/`
- [ ] new imports from `@apollo/client` subpaths end in `/index.js`
- [ ] public API changes are exported from `src/index.ts`
- [ ] `docs/ARCHITECTURE.md` updated if you changed the flow, not just the code

Commit messages: a short imperative subject, then a body explaining *why* — the
code already says what. Match the existing history.

CI runs on every PR against Node 20 and 22, and additionally verifies the build
outputs, that both entry points load, and `npm pack --dry-run`. A red matrix
cell is a real failure; `fail-fast` is off so you see all of them at once.

## Good first issues

Two real ones, both small and both currently in the tree:

**`compareQueryToCache` is declared but not implemented.**
`CompareQueryToCacheInputSchema` / `OutputSchema` and the `CacheMiss` type exist
in `src/schemas/tools.ts` and are exported from `src/index.ts`, but no tool
implements them. The contract is already designed: take a cache, a query
document and variables, and report which requested fields the cache cannot
satisfy and why (`MISSING_FIELD` / `DANGLING_REF` / `NOT_NORMALIZED`).

**The CLI prints a `DANGLING_REF` branch that never fires.**
`bin/apollo-copilot.js:71` lists `DANGLING_REF` in its `kinds` array and icon
map, but `FindingKindSchema` never emits that kind — the analyzer reports
`ORPHANED_REF`. Either remove the dead branch, or decide the two are distinct
and follow the seven-step checklist above.

Comment on an issue before starting something larger, so two people don't build
the same thing.

## Releases

Maintainers only. `.github/workflows/publish.yml` fires on a `v*` tag and
refuses to publish when the tag and `package.json` version disagree.

```bash
npm version patch    # or minor / major
git push && git push --tags
```

Published with `--provenance`, so the npm registry carries a Sigstore
attestation tying the artifact to the workflow run that built it.

## Conduct

By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Short version: be decent, assume good
faith, keep review about the code.
