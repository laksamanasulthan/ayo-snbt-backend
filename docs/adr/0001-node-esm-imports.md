# 0001 — Node ESM with NodeNext: relative imports carry the .js extension

- Status: accepted
- Date: 2025 (initial commit; reaffirmed during the soft-delete refactor)

## Context

The project is `"type": "module"` with TypeScript
`moduleResolution: "NodeNext"`. Under Node's ESM resolver, a relative import
must name the ACTUAL file on disk at runtime — the compiled output lives in
`dist/` with `.js` extensions, so every relative import in source must end
in `.js`, not `.ts`.

Forgetting the extension compiles fine (tsc resolves `./x.ts` in source) but
the emitted `dist` file references `./x` — Node ESM throws
`ERR_MODULE_NOT_FOUND` at boot.

## Decision

- All relative imports use `.js`: `import { x } from "../shared/x.js"`.
- Lint/typecheck guard: TS itself errors on missing extensions under
  NodeNext, so `npm run typecheck` is the gate.
- Only relative imports are affected; bare package imports stay extensionless.

## Consequences

- Fast, correct, zero-runtime-surprise ESM; no bundler needed for prod
  (`node dist/server.js`).
- New contributors occasionally write `.ts` out of habit — typecheck catches
  it immediately, and CONTRIBUTING.md calls it out as convention #1.
