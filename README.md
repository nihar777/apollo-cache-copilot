# apollo-cache-copilot

[![CI](https://github.com/nihar777/apollo-cache-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/nihar777/apollo-cache-copilot/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](#license)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-000000)](https://modelcontextprotocol.io/)

AI copilot and MCP server for diagnosing Apollo `InMemoryCache` normalization
defects — built for React Native, where Apollo DevTools does not exist.

---

## The Problem

Apollo Client normalizes every result into a flat map of `__typename:id`
entities and stores cross-references as `{ "__ref": "Type:id" }` pointers. That
normalization is invisible at write time and only fails at read time — usually
on a screen far away from the mutation that caused it. Three failure classes
dominate, and **all three are silent**:

| Defect | What Apollo does | Symptom |
|---|---|---|
| **Orphaned pointer** — `{ __ref: "User:99" }` with no `User:99` in the store | Returns `undefined` for the field | Blank row, no throw |
| **Missing `__typename` / `id`** | Cannot compute a cache key, stores the object *inline* | Renders fine, then diverges on the second write |
| **Type/key drift** — `keyFields` disagrees with the server payload | Same logical entity under two keys | Duplicated list items, stale reads |

React Native makes every one of them worse:

- **No Apollo DevTools.** The browser extension is the primary cache debugger and
  it does not exist on RN. The fallback is `console.log(JSON.stringify(client.cache.extract()))`
  and reading a multi-megabyte blob by eye.
- **Persisted cache.** `apollo3-cache-persist` + AsyncStorage means a corrupt cache
  **survives app restart** — sticky, and reproducing on the user's device only.
- **Offline-first mutations.** Optimistic responses write partial entities by
  design, which is exactly the shape that trips defects 1 and 2.
- **Long sessions.** Mobile apps stay resident for days, so drift accumulates far
  longer than in a browser tab.

## The Solution

**Detection is deterministic. Explanation is the model's job.**

1. **A cache analyzer** that walks `cache.extract()` output and reports structural
   defects with exact paths (`User:1.avatar → Avatar:99`). Plain graph traversal —
   no model involved, no guessing.
2. **An MCP server** exposing that analyzer to whichever agent the developer is
   already talking to. The agent asks for findings plus the relevant subgraph, so
   it never has to hold the whole cache in context.

Diagnosis moves from "paste a 10MB blob and squint" to a conversation.

---

## Architecture

> Four-figure walkthrough — the defect, the process, the graph, the JSON
> boundary: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

![Architecture: MCP client ⇄ stdio server ⇄ LangGraph pipeline](https://raw.githubusercontent.com/nihar777/apollo-cache-copilot/main/docs/img/architecture.svg)

ASCII, same thing:

```
  MCP client (Claude Desktop, Cursor, any stdio client)
        │  JSON-RPC 2.0  ▲
        ▼   over stdio   │  stdout IS the protocol channel —
  ┌─────────────────────────────────┐   all logs go to stderr
  │ StdioServerTransport            │
  ├─────────────────────────────────┤
  │ tools: inspect_dangling_refs    │  read-only
  │        compare_query_to_cache   │  read-only
  │        patch_cache              │  mutating (dryRun = validate only)
  │        diagnose_cache_graph     │  read-only, plans only
  ├─────────────────────────────────┤
  │ Zod schemas — parse at the edge │
  └───────────────┬─────────────────┘
                  ▼
  ┌─────────────────────────────────────────────────────┐
  │  cacheAgentGraph  (LangGraph, deliberately LLM-free)│
  │                                                     │
  │  INSPECTOR ──────► REASONER ──────► PATCHER         │
  │  walks the store   maps findings    narrates the    │
  │  → findings[]      → patch ops      plan            │
  │      │                  │                           │
  │      │ owns `findings`  │ owns `proposedPatches`    │
  │      ├── no findings ──► END  (skips both)          │
  │      │                  │                           │
  └──────┼──────────────────┼───────────────────────────┘
         ▼                  ▼
  inspectDanglingRefs()   patchCache()
  pure, on a snapshot     cache.modify / evict / gc on a live cache
```

Each graph node owns exactly one state channel — the inspector writes
`findings`, the reasoner writes `proposedPatches`, the patcher writes `messages`.
Only `messages` accumulates; re-running a node re-analyzes the same cache, so
appending elsewhere would duplicate every finding on the second pass.

**Why no LLM in the graph?** Every defect this copilot detects has a mechanical
repair (prune the pointer, evict the orphan). A model would add latency, cost
and nondeterminism to a decision a `switch` already makes correctly. The graph
earns its keep as orchestration; the *model* lives in the MCP client, where it
correlates a finding with the mutation or fragment that wrote it.

---

## Installation

```bash
npm install apollo-cache-copilot
# or, from a checkout
npm install && npm run build
```

Requires Node.js ≥ 20 (`vitest` 4 and `@langchain/core` both require it; CI covers 20 and 22). `@apollo/client` (declared range `^3.8 || ^4.0`), `react`, and
`react-native` are **peer** dependencies — the package uses your app's copies.

**Apollo Client versions — what is actually verified:** the full suite runs against
3.14.x. A separate CI job runs the runtime tests against 4.x. Not verified: 3.8–3.13,
and the TypeScript types under 4.x (`tsc` currently fails against v4's types because
`ApolloCache` is no longer generic), so on v4 treat the type declarations as untested.

---

## Library Usage

ESM only. The package ships types.

### `inspectDanglingRefs` — audit a snapshot

Pure and synchronous. Takes `cache.extract()` output, returns findings + stats.

```ts
import { inspectDanglingRefs } from 'apollo-cache-copilot';

const { findings, stats } = inspectDanglingRefs({
  cache: client.cache.extract(),
  // all optional:
  rootIds: ['ROOT_QUERY', 'ROOT_MUTATION'], // reachability roots
  includeUnreachable: true,                  // report gc candidates
  includeNormalizationGaps: true,            // report un-keyable inline objects
});

console.log(stats);
// { entityCount: 4, refCount: 3, danglingCount: 1, unreachableCount: 1 }

for (const f of findings) {
  console.log(f.kind, f.path, f.danglingRef ?? '');
  // ORPHANED_REF  User:1.avatar  Avatar:99
  // UNREACHABLE_ENTITY  Post:7
}
```

Finding kinds: `ORPHANED_REF`, `UNREACHABLE_ENTITY`, `MISSING_TYPENAME`,
`MISSING_ID`, and (opt-in via `includeIdentityRisk`) `UNSCOPED_IDENTITY_FIELD`.
Every finding carries an exact cache path.

Entities you `cache.retain()` are listed by Apollo under `__META.extraRootIds` in
`extract()` output. They count as reachability roots, so they are not reported as
unreachable, and `__META` itself is not treated as an entity (or counted in
`entityCount`).

### `patchCache` — apply repairs to a live cache

Operations are declarative descriptors so they survive a JSON hop; the tool
rehydrates them into the functions `cache.modify` wants. Ordered, and failures
are *recorded* rather than thrown so a bad key mid-batch cannot strand the cache
half-patched.

```ts
import { patchCache } from 'apollo-cache-copilot';

const { dryRun, results, collected } = patchCache(client.cache, {
  operations: [
    // drop dangling refs from a list field
    { type: 'modify', id: 'User:1', fields: { posts: { action: 'PRUNE_DANGLING_REFS' } } },
    // delete / invalidate / overwrite a field
    { type: 'modify', id: 'User:1', fields: { avatar: { action: 'DELETE' } } },
    { type: 'modify', id: 'User:1', fields: { bio: { action: 'SET', value: 'unset' } } },
    // evict an entity, or one field of it
    { type: 'evict', id: 'Post:7' },
    { type: 'evict', id: 'ROOT_QUERY', fieldName: 'user', args: { id: '1' } },
  ],
  gc: true,       // run cache.gc() once, after everything lands
  dryRun: false,  // true = validate only: nothing is applied and nothing is previewed
});

results.forEach((r) => console.log(r.changed, r.error ?? ''));
console.log('collected:', collected); // keys gc() removed
```

Field actions: `DELETE`, `INVALIDATE`, `SET` (with `value`),
`PRUNE_DANGLING_REFS`.

### `cacheAgentGraph` — inspect → reason → plan

The compiled LangGraph. Returns findings, the patch operations it would apply,
and per-step narration. **It never mutates** — feed `proposedPatches` to
`patchCache` when you have reviewed them.

```ts
import { cacheAgentGraph } from 'apollo-cache-copilot';

const state = await cacheAgentGraph.invoke({ cacheState: client.cache.extract() });

state.messages.forEach((m) => console.log(String(m.content)));
// 2 findings: 1 orphaned ref, 1 unreachable entity.
// ...

// Review, then apply:
patchCache(client.cache, { operations: state.proposedPatches });
```

Also exported: `buildCacheAgentGraph()` (uncompiled builder), the individual
nodes `inspectorNode` / `reasonerNode` / `patcherNode`, `CacheAgentAnnotation`,
every Zod schema (`InspectDanglingRefsInputSchema`, `PatchCacheInputSchema`, …)
and its inferred type, plus the MCP surface (`createServer`,
`startStdioServer`, `runInspectDanglingRefs`, `runPatchCache`,
`runDiagnoseCacheGraph`).

---

## CLI Usage

```
apollo-copilot [mcp]          Start the stdio MCP server (default when no args)
apollo-copilot inspect FILE   Diagnose a JSON cache snapshot and print findings
```

### `apollo-copilot inspect <file>`

Dump the cache from your app, then read it:

```ts
// in the RN app
console.log(JSON.stringify(client.cache.extract()));
```

```bash
npx -y -p apollo-cache-copilot apollo-copilot inspect ./cache-snapshot.json
```

```
━━ Cache Diagnostic ━━

Entities: 4 | Refs: 3 | Dangling: 1 | Unreachable: 1

⚠  ORPHANED_REF (1)
   • User:1.avatar → Avatar:99
     Points at "Avatar:99", which is not in the cache. Reads here return undefined.

🗑  UNREACHABLE_ENTITY (1)
   • Post:7
     No root reaches this entity; cache.gc() would collect it.
```

A clean cache prints `✓ Cache is clean: no findings.`

Exit codes: `0` success, `1` unexpected failure, `2` bad input (missing file,
unreadable file, invalid JSON, unknown command).

#### One real run: find, repair, verify

![Real run: inspect finds 5 findings, cacheAgentGraph + patchCache apply 2 repairs, re-inspect shows dangling 0 and unreachable 0](https://raw.githubusercontent.com/nihar777/apollo-cache-copilot/main/docs/img/real-run.png)

Output of the published 1.3.0 package on a demo snapshot with planted defects.
The orphaned ref and the unreachable entity are repaired by `patchCache`. The
inline objects with no `__typename` / `id` are reported but **not** repairable:
they come from the query or fragment, not from cache corruption.

### `apollo-copilot mcp`

Starts the MCP server on stdio and blocks. Only useful when an MCP client owns
the process — see below. `apollo-copilot-mcp` is a legacy alias for the same
thing.

> **stdout is the protocol channel.** The server writes nothing but JSON-RPC to
> stdout; all diagnostics go to stderr. Never add a `console.log` to this path.

---

## MCP Setup

### Tools exposed

| Tool | Input | Behavior |
|---|---|---|
| `inspect_dangling_refs` | `cache`, optional `rootIds` / `includeUnreachable` / `includeNormalizationGaps` | Read-only. Returns `findings` + `stats`. |
| `diagnose_cache_graph` | `cache` | Read-only. Runs the full graph. Returns `findings`, `proposedPatches`, `narration`. Plans only. |
| `compare_query_to_cache` | `cache`, `query`, optional `variables` / `rootId` / `returnPartialData` | Read-only. Runs the query against the snapshot; returns `complete`, `misses` (with reason) and `satisfiedFields`. |
| `patch_cache` | `cache`, `operations`, `gc`, `dryRun` | Restores the snapshot into a throwaway `InMemoryCache`, patches it, returns `results` + the re-extracted `cache`. `dryRun` validates only; it does not preview what would change. |

`patch_cache` carries the snapshot because a stdio server has no live cache to
hand the patcher — only JSON. Diff the returned `cache` against yours, or
`client.cache.restore()` it.

Every tool returns both a human-readable summary line and machine-readable
`structuredContent`, so clients that don't understand structured output still
get the JSON.

### Claude Desktop

One command — finds the right config path per OS and registers the server:

```bash
npx -y -p apollo-cache-copilot@latest apollo-copilot install-claude
```

Restart Claude Desktop, the four tools appear under the tools menu.

Manual alternative — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "apollo-cache-copilot": {
      "command": "npx",
      "args": ["-y", "-p", "apollo-cache-copilot", "apollo-copilot", "mcp"]
    }
  }
}
```

From a local checkout — build first (`npm run build`), then point at the bin
with an absolute path:

```json
{
  "mcpServers": {
    "apollo-cache-copilot": {
      "command": "node",
      "args": ["/absolute/path/to/apollo-cache-copilot/bin/apollo-copilot.js", "mcp"]
    }
  }
}
```

Restart Claude Desktop. The four tools appear under the tools menu.

### Cursor

One command — registers the server in `~/.cursor/mcp.json` automatically:

```bash
npx -y -p apollo-cache-copilot@latest apollo-copilot install-cursor
```

Add `--project` to write `.cursor/mcp.json` in the current repo instead of the
global config. Restart Cursor (or reload window), then Settings → MCP →
confirm the server is green.

Manual alternative, same file:

```json
{
  "mcpServers": {
    "apollo-cache-copilot": {
      "command": "npx",
      "args": ["-y", "-p", "apollo-cache-copilot", "apollo-copilot", "mcp"]
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "apollo-cache-copilot": {
      "command": "node",
      "args": ["${workspaceFolder}/bin/apollo-copilot.js", "mcp"]
    }
  }
}
```

### Other MCP clients (Windsurf, VS Code, Cline, Zed, ...)

Any client that reads a standard `mcpServers` block takes the same entry —
only the config file path changes:

| Client | Config file |
|---|---|
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `.vscode/mcp.json` in the workspace |
| Cline | VS Code settings → `cline.mcpServers`, or `cline_mcp_settings.json` |
| Zed | `~/.config/zed/settings.json` under `"context_servers"` |

```json
{
  "mcpServers": {
    "apollo-cache-copilot": {
      "command": "npx",
      "args": ["-y", "-p", "apollo-cache-copilot", "apollo-copilot", "mcp"]
    }
  }
}
```

### Then just ask

> "Here's my cache snapshot — why is the avatar blank on the profile screen?"

The agent calls `diagnose_cache_graph`, gets `User:1.avatar → Avatar:99` plus the
proposed `PRUNE_DANGLING_REFS`, and correlates it with the mutation that wrote a
reference without the entity body.

---

## Development

```bash
npm install
npm run build      # tsc -> dist/  (run first: typecheck and tests import dist)
npm run typecheck  # tsc --noEmit -p tsconfig.test.json (includes tests)
npm test           # vitest run
```

`tsconfig.json` is the build and excludes `__tests__` / `__mocks__` so the
published package is just the tools. `tsconfig.test.json` type-checks
everything and emits nothing.

## Success Metrics

These are design targets. No benchmark or measured results are published in this
repository, so none of the figures below is a claim about the current release.

| # | Metric | Target |
|---|---|---|
| 1 | Detection recall on the fixture suite | 100% — every seeded defect found |
| 2 | False positives on a healthy snapshot | 0 |
| 3 | Analyzer runtime on a 10MB `extract()` | < 1s |
| 4 | Findings carrying an exact cache path | 100% |
| 5 | Developer time from symptom to named root cause | < 5 min (vs. hours) |
| 6 | Tokens sent to the model per diagnosis | < 10k — findings + subgraph, never the whole cache |

## Contributing

Contributions welcome. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** — it
covers setup, the seven invariants in this codebase that break *silently*
(stdout is the protocol channel; Apollo 3.x needs explicit `/index.js` imports;
only `messages` accumulates in the graph state), and the seven-step checklist
for adding a new defect kind.

One open starter, small and live in the tree today:

- **The CLI prints a `DANGLING_REF` branch that never fires** —
  `bin/apollo-copilot.js:71` lists a kind `FindingKindSchema` never emits.

Bug reports need a minimal `cache.extract()` snapshot; the
[issue form](.github/ISSUE_TEMPLATE/bug_report.yml) asks for one, because with a
snapshot almost every report is reproducible in a single command.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Do not open a public issue — see
[SECURITY.md](SECURITY.md). Note that a `cache.extract()` snapshot is
production data: scrub it before pasting it anywhere, including into a chat
with a model.

## License

ISC — see [LICENSE](LICENSE).
