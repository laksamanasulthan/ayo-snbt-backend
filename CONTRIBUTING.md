# Contributing to Ayo-SNBT Backend

Thanks for contributing! This guide keeps the codebase maintainable as the team
grows. Please read [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) and
[docs/architecture/API-CONVENTIONS.md](docs/architecture/API-CONVENTIONS.md) before starting.

## Slice anatomy

New features are **vertical slices** under `src/modules/<slice>/`. Each slice
owns its whole vertical: routes, service, repository, schema, jobs, tests.

```
src/modules/courses/
├── index.ts        # re-exports (service, repo, module)
├── routes.ts       # Fastify routes: schema validation, guards, envelope replies
├── service.ts      # business rules + transactions + audit + events
├── repository.ts   # ALL database access (drizzle queries, notDeleted filters)
└── (optional) jobs.ts, processor.ts, templates.ts, shuffle.ts, slug.ts
```

Tests live in `tests/unit` (pure logic) and `tests/integration` (compose
stack). New slices add an `*-edge.test.ts` suite — see
[docs/guides/TESTING.md](docs/guides/TESTING.md).

## Conventions (the 8 rules)

1. **ESM imports with .js extension.** `moduleResolution: NodeNext` requires
   `import { x } from "./y.js"` — never omit the extension
   ([ADR 0001](docs/adr/0001-node-esm-imports.md)).
2. **Reply with the envelope helpers.** `reply.ok(data, meta?)`,
   `reply.created(data)`, `reply.accepted(data)` — never raw `send`.
3. **Throw typed errors with codes.** `BadRequestError("...", "CODE")` from
   `shared/http/errors.ts`; add new codes to the catalog in
   [docs/architecture/API-CONVENTIONS.md](docs/architecture/API-CONVENTIONS.md).
4. **All DB reads through the slice repository.** Repositories apply
   `notDeleted()` filters — direct `getDb()` queries in services must apply
   the same filters manually.
5. **Multi-statement writes use `withTx`.** Read back inside the SAME
   transaction connection (other connections cannot see uncommitted rows).
6. **Ownership checks before mutations.** Creator/owner or admin; admin
   bypasses ownership but the route permission gate (`requirePermission`) is
   the first layer.
7. **Audit + events on mutations.** Call `audit({ action, resourceType, … })`
   and emit domain events via `eventBus` (cache invalidation subscribes
   automatically).
8. **Tests with every change.** Unit tests for pure logic, integration tests
   for flows; edge-case suites cover normal AND failure paths
   ([docs/guides/TESTING.md](docs/guides/TESTING.md)).

## PR checklist

Before opening a PR, verify:

- [ ] `npm run lint` — 0 errors
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run build` — passes
- [ ] `npm test` — unit suite green
- [ ] `npm run test:integration` — integration suite green (compose stack up)
- [ ] `npm run docs:check` — docs links + prettier green
- [ ] New behavior documented (domain doc updated, error codes catalog updated)
- [ ] Non-obvious decisions recorded as an ADR when warranted
- [ ] No secrets, no dev defaults in prod paths, `assertSecureInProduction`
      still holds

## Working with the stack

```bash
docker compose -f compose.dev.yml up -d postgres pgbouncer redis mongo minio minio-init mailpit
npm run db:migrate && npm run db:seed
npm run dev            # API (tsx watch)
npm run dev:worker     # BullMQ worker (tsx watch)
```

Gotchas (full list in [docs/guides/GETTING-STARTED.md](docs/guides/GETTING-STARTED.md)):

- `.npmrc` sets `ignore-scripts=true` — after `npm install`, run
  `node node_modules/ffmpeg-static/install.js` once.
- Regenerate `package-lock.json` with npm 10 (Docker uses it):
  `docker run --rm -v "$PWD:/app" -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund`.
- Integration tests share the compose DB and run sequentially — never run
  them against a database with real data.

## ADR process

1. Create `docs/adr/XXXX-title.md` following the template in
   [docs/adr/README.md](docs/adr/README.md).
2. Get explicit sign-off in the PR review.
3. Reference the ADR in code comments where the decision bites.

## Code review expectations

- Reviewers verify the 8 conventions and the PR checklist, not just behavior.
- Large slices are reviewed in vertical order (routes → service → repository).
- Security-sensitive changes (auth, payments, webhooks, CSRF, rate limits)
  get an extra reviewer pass per [docs/architecture/SECURITY.md](docs/architecture/SECURITY.md).
