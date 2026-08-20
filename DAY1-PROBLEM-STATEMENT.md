# Day 1 — Problem Statement

## The Problem

Apollo Client's `InMemoryCache` normalizes every result into a flat map of
`__typename:id` entities, and stores cross-references as `{ __ref: "Type:id" }`
pointers. That normalization is invisible at write time and only fails at read
time — usually in a screen far away from the mutation that caused it.

Three failure classes dominate, and all three are silent:

**1. Orphaned pointers.** A field holds `{ __ref: "User:99" }` but no `User:99`
entity exists in the cache. Apollo returns `undefined` for that field (or the
whole query goes to `MISSING_FIELD_WARNING`), so the UI renders a blank row
instead of throwing. Common cause: a mutation returned a reference in a list
without returning the entity body, or an entity was evicted while a list still
pointed at it.

**2. Missing `__typename` / `id`.** Without both, Apollo cannot compute a cache
key and stores the object *inline* under its parent field instead of as a
normalized entity. The data looks correct on the first render. The second query
for the same object writes a second copy, and the two silently diverge. Cause:
a hand-written `writeQuery`/optimistic response, a fragment missing
`__typename`, or a server field that omits `id`.

**3. Type/key drift.** `keyFields` config disagrees with what the server sends
(e.g. cache keyed on `email`, server started returning `null` email), so the
same logical entity lands under two different cache keys.

## Why React Native makes this worse

- **No Apollo DevTools.** The browser extension is the primary debugging tool
  for cache state, and it does not exist on RN. Developers fall back to
  `console.log(JSON.stringify(client.cache.extract(), null, 2))` and read a
  multi-megabyte blob by eye.
- **Persisted cache.** `apollo3-cache-persist` + AsyncStorage means a corrupt
  cache **survives app restart**. The bug is now sticky and reproduces on the
  user's device but not the developer's.
- **Offline-first mutations.** Optimistic responses and queued mutations write
  partial entities by design, which is exactly the shape that trips (1) and (2).
- **Long sessions.** Mobile apps stay resident for days. Cache drift accumulates
  far longer than in a browser tab.

Net effect: the symptom (blank field, stale row, duplicated list item) appears
hours and several screens away from the cause. Time-to-root-cause is measured
in hours, and the fix is frequently "clear the cache", which hides the defect
rather than fixing it.

## Our Solution

An **AI Copilot over cache state, exposed through MCP**, so the agent the
developer is already talking to can read and reason about the real cache.

Two pieces:

**1. A cache analyzer (deterministic).** Takes `cache.extract()` output and
walks it, reporting structural defects with exact paths:
- every `__ref` that resolves to nothing → orphaned pointer
- every object stored inline that *should* have normalized → missing
  `__typename` or `id`
- entities reachable from no root → garbage that `gc()` would collect
- duplicate entities that appear to be the same logical object

This is plain graph traversal. No model involved. It must be right, fast, and
runnable on a 10MB snapshot.

**2. An MCP server exposing that analyzer as tools.** The developer stays in
their editor and asks "why is the avatar blank on the profile screen?" The
agent calls the MCP tool, gets the structural findings plus the relevant cache
subgraph, and correlates the defect with the mutation or fragment that wrote it.
Diagnosis moves from "paste a 10MB blob and squint" to a conversation.

The split matters: **detection is deterministic, explanation is the model's
job.** The analyzer never guesses, and the model never has to hold the whole
cache in context — it asks for the subgraph it needs.

## Success Metrics

| # | Metric | Target |
|---|--------|--------|
| 1 | Detection recall on the fixture suite (orphaned refs, missing `__typename`/`id`, unreachable entities) | 100% — every seeded defect found |
| 2 | False positives on a known-healthy cache snapshot | 0 |
| 3 | Analyzer runtime on a 10MB `extract()` snapshot | < 1s |
| 4 | Every finding carries an exact cache path (`ROOT_QUERY.user.avatar`) and cache key | 100% of findings |
| 5 | Developer time from symptom to named root cause | < 5 min (vs. hours today) |
| 6 | Tokens sent to the model per diagnosis | < 10k — findings + subgraph, never the whole cache |
| 7 | Works against a real RN app's persisted cache | End-to-end demo on device |

## Day 1 Scope

- [x] This document
- [x] TypeScript in the project; `@apollo/client` / `react` / `react-native` as peer deps
- [x] `src/__mocks__/sampleCacheState.ts` — three fixtures: healthy entity,
      orphaned `__ref`, missing `__typename`/`id`

Explicitly **not** Day 1: the analyzer itself, the MCP server, any RN
integration. Day 1 fixes the problem definition and the test fixtures the
analyzer will be written against.
