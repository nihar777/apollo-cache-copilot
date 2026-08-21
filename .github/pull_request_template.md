## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Why

<!-- The defect, the report, or the constraint that prompted it. -->

## Checks

- [ ] `npm run build && npm run typecheck && npm test` pass locally
- [ ] A test fails without this change and passes with it
- [ ] No `console.log` reachable from `src/mcp/` or `bin/` — stdout is the protocol channel
- [ ] New `@apollo/client` subpath imports end in `/index.js`
- [ ] Public API changes are exported from `src/index.ts`
- [ ] `docs/ARCHITECTURE.md` updated if the flow changed

<!-- Adding a defect kind? All seven steps in CONTRIBUTING.md, including the
     bin/apollo-copilot.js kinds array — nothing enforces that one. -->
