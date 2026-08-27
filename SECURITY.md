# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

Fixes land on the latest minor. There are no backport branches.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:

**[Open a private security advisory →](https://github.com/nihar777/apollo-cache-copilot/security/advisories/new)**

Advisories are visible only to maintainers, and give us a place to work on a
fix and coordinate disclosure before anything is public.

Please include: what an attacker controls, what they get, and a minimal
reproduction — for this tool, that is usually a small cache snapshot plus the
command you ran. Scrub real user data from it first; the shape of the input is
what matters, not the contents.

Expect an initial response within a few days. This is a single-maintainer
project, so the honest commitment is best effort rather than a fixed SLA. If a
report goes unanswered for two weeks, ping [@nihar777](https://github.com/nihar777).

## Before you report: what this tool is

`apollo-cache-copilot` is a local developer tool. It runs on a developer's
machine or in their editor, over stdio, and reads a serialized Apollo cache
snapshot. It opens no network sockets, listens on no port, and has no
authentication or authorization surface of its own.

That shapes what counts as a vulnerability here.

## What the tool guards, and what it does not

Since 1.1.0 there are guardrails at the MCP boundary, in
`src/security/guardrails.ts`. Knowing what they do and do not promise is the
difference between a report worth filing and one that isn't.

**Input sanitization.** Every tool payload is walked before anything else
touches it. Keys named `__proto__`, `constructor`, or `prototype` are refused
outright — `JSON.parse` preserves these as ordinary own properties, and
`cache.restore()` is an assignment site downstream. The same walk caps nesting
at 64 levels, which bounds the recursion depth of the `inspectDanglingRefs`
walker. Payloads are refused, never silently rewritten.

**Secrets redaction — best effort, not a guarantee.** Findings, narration,
trace events, and per-operation error strings are scrubbed for common secret
shapes (JWTs, `Bearer` credentials, AWS/GitHub/Stripe/Slack/Google key
prefixes) and for values sitting under names like `password`, `client_secret`,
or `authToken`. This exists because those derived strings are what an agent
reads into a model's context, and an Apollo store key can embed a token
verbatim: `me({"authToken":"eyJ..."})`.

It is pattern matching. It will miss a secret that looks like ordinary data — a
bare session ID, an internal token with no recognizable prefix, a password
under a field name nobody thought of. **Do not treat a redacted output as safe
to publish.** The guard reduces accidental leakage into a model transcript; it
does not sanitize a snapshot for sharing.

Redaction is deliberately **not** applied to the cache payload `patch_cache`
returns, nor to the operations it echoes back. That store is the caller's own,
on its way to their `cache.restore()`, and a `[REDACTED]` written into it is
data corruption rather than a safety win. If you need a scrubbed snapshot,
call the exported `redactSecrets()` yourself — with the caveat above.

**Tool and operation allowlist.** Unknown tool names and unknown patch actions
are always refused. Operators can narrow further:

```bash
# Register the MCP server read-only — patch_cache refuses to run at all.
APOLLO_COPILOT_ALLOWED_TOOLS=inspect_dangling_refs,diagnose_cache_graph

# Allow repairs but forbid arbitrary writes.
APOLLO_COPILOT_ALLOWED_PATCH_ACTIONS=DELETE,INVALIDATE,PRUNE_DANGLING_REFS
```

Both are read per call, so a wrapper script can set them. Unset means the full
known set, so upgrading changes no existing configuration's behaviour.

An operator can also set `APOLLO_COPILOT_ROLE` (`readonly` / `operator` /
`admin`) as a single-flag preset instead of naming both allowlists by hand —
`readonly` grants no tools but the two read-only ones, `operator` adds
`patch_cache` restricted to the non-destructive actions (`INVALIDATE`,
`PRUNE_DANGLING_REFS`), `admin` is the full known set. An explicit allowlist,
if set, always overrides the role.

**Untrusted-content boundary.** Findings, narration and trace text can embed
attacker-controlled substrings verbatim — a store key like
`me({"note":"ignore prior instructions"})` — and that text is what an MCP
client's model reads back as context. Before it goes out, that text is walked
for hidden Unicode (zero-width spaces, bidi-override controls, the invisible
Unicode Tag block used for "ASCII smuggling") and any literal `<user_input>` /
`</user_input>` the payload itself contains is neutralized to `[user_input]` /
`[/user_input]`, so a crafted cache key can't forge a boundary and stage a fake
system turn after it. The whole JSON response is then wrapped in
`<user_input>...</user_input>` before being handed to the client, so a model
reading it has an explicit signal that this is data to inspect, not
instructions to follow. This is a hardening measure against a model
misreading tool output as directives — it is not, and cannot be, a guarantee
that every client-side model resists it.

**Human-in-the-loop approval for high-risk writes.** `patch_cache` declares
`destructiveHint: true` so an MCP client that gates destructive tools behind
its own approval UI does so. Server-side, `APOLLO_COPILOT_REQUIRE_APPROVAL=true`
additionally refuses any `SET` or `DELETE` field action — the two that
overwrite or remove live data outright — unless the request sets
`"approved": true`. `dryRun` calls, and the non-destructive actions
(`INVALIDATE`, `PRUNE_DANGLING_REFS`), are never gated. Off by default, same as
the allowlists: an operator opts in.

### In scope

- **Crashes or unbounded resource use from a malformed snapshot.** The walker in
  `inspectDanglingRefs` recurses through nested field values, so its stack depth
  follows the snapshot's nesting depth. Zod validates only the outer two levels
  (`Record<string, Record<string, unknown>>`) — everything deeper is narrowed by
  the walker itself. The 64-level depth cap above is the mitigation; a snapshot
  that still exhausts the stack or hangs the process — by evading the cap, or by
  reaching a walker the cap does not cover — is a legitimate report.
- **A payload that reaches a prototype-write, an assignment sink, or
  `cache.restore()` despite the key check** — including any encoding or nesting
  that slips a pollution key past `assertSafeInput`.
- **An allowlist bypass** — `patch_cache` running while
  `APOLLO_COPILOT_ALLOWED_TOOLS` excludes it, or a patch action applying while
  `APOLLO_COPILOT_ALLOWED_PATCH_ACTIONS` excludes it. Same for a role: a tool or
  action running that `APOLLO_COPILOT_ROLE` should have refused.
- **An approval bypass** — a `SET` or `DELETE` field action landing while
  `APOLLO_COPILOT_REQUIRE_APPROVAL=true` and the request did not set
  `"approved": true`.
- **A boundary-marker escape.** Untrusted text (a cache key, a finding message)
  that survives into the wrapped tool response still carrying a literal,
  unneutralized `<user_input>` or `</user_input>`, or hidden Unicode that
  `stripHiddenUnicode` should have removed.
- **A redaction gap with a realistic secret shape.** A recognizable
  credential — a JWT, a prefixed vendor key, a value under an obviously
  sensitive field name — surviving into `findings`, `narration`, or `trace` is
  a bug worth reporting. Send the shape, not the credential.
- **Path traversal or arbitrary file reads** via the CLI's snapshot argument.
- **Anything written to stdout by the MCP server.** stdout is the JSON-RPC
  channel; a payload that induces a write there corrupts the protocol frame and
  is a real bug, not just a cosmetic one.
- **A `patch_cache` operation that mutates outside the entity keys it names**, or
  that ignores `dryRun`.
- **Supply chain issues** — a compromised dependency, or a published artifact
  that does not match this repository.

### Not in scope

- **Snapshots containing user data.** `cache.extract()` output is whatever your
  app cached: names, emails, tokens if you cached them. The tool reads what you
  hand it. Output redaction narrows this — see above — but it is a backstop, not
  a boundary: it scrubs derived text for recognizable secret shapes and leaves
  the snapshot itself untouched. Trimming and scrubbing a snapshot before
  sharing it — in an issue, or in a chat with a model — is still the operator's
  job, and it is still the single most likely way to leak data while using this
  tool. Treat every snapshot as production data until you have looked at it.
  A secret with no recognizable shape passing through is a limitation of pattern
  matching, not a vulnerability; a *recognizable* one passing through is a bug,
  and belongs in the "in scope" list above.
- **`patch_cache` doing what it was told, within an allowlist that permits it.**
  It declares `readOnlyHint: false`, and the `SET` field action writes a
  caller-supplied value at a caller-supplied key. An agent instructed to corrupt
  a cache can corrupt a cache. Use `dryRun` to review operations first, narrow
  `APOLLO_COPILOT_ALLOWED_PATCH_ACTIONS` if `SET` is more than your workflow
  needs, and treat the tool as the write-capable tool it says it is when
  configuring an MCP client. An operation the allowlist *permits* behaving as
  documented is not a vulnerability; one it forbids running anyway is.
- **Vulnerabilities in `@apollo/client`, `@langchain/*`, `zod`, or the MCP SDK.**
  Report those upstream; open an advisory here only if this package's usage
  makes an upstream issue exploitable in a way it otherwise would not be.
- **Findings that require an attacker to already run code on the developer's
  machine.**

## Verifying what you installed

Releases are published from `.github/workflows/publish.yml` with
`npm publish --provenance`, so every version carries a Sigstore attestation
tying the tarball to the workflow run and commit that produced it.

```bash
npm audit signatures                      # verifies registry signatures + provenance
npm view apollo-cache-copilot dist.integrity
```

The publish workflow also refuses to run when the git tag and the `package.json`
version disagree, so a tag can never ship a version it does not name.

If `npm audit signatures` reports a missing or invalid attestation for a version
of this package, that is worth an advisory on its own.
