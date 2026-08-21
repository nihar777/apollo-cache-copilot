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

### In scope

- **Crashes or unbounded resource use from a malformed snapshot.** The walker in
  `inspectDanglingRefs` recurses through nested field values, so its stack depth
  follows the snapshot's nesting depth. Zod validates only the outer two levels
  (`Record<string, Record<string, unknown>>`) — everything deeper is narrowed by
  the walker itself. A snapshot crafted to exhaust the stack or hang the process
  is a legitimate report.
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
  hand it. Trimming and scrubbing a snapshot before sharing it — in an issue, or
  in a chat with a model — is the operator's job, and it is the single most
  likely way to leak data while using this tool. Treat every snapshot as
  production data until you have looked at it.
- **`patch_cache` doing what it was told.** It declares `readOnlyHint: false`,
  and the `SET` field action writes a caller-supplied value at a caller-supplied
  key. An agent instructed to corrupt a cache can corrupt a cache. Use `dryRun`
  to review operations first, and treat the tool as the write-capable tool it
  says it is when configuring an MCP client.
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
