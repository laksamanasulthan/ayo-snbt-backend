# Architecture Decision Records

Decisions that shape the codebase, recorded for future maintainers. Read the
relevant ADR before refactoring the areas they cover.

| #                                           | Decision                                                            | Status   |
| ------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](./0001-node-esm-imports.md)          | Node ESM + NodeNext: every relative import uses the `.js` extension | Accepted |
| [0002](./0002-cursor-pagination.md)         | Opaque base64url keyset cursors over offset pagination              | Accepted |
| [0003](./0003-transactions-soft-deletes.md) | `withTx` transactions + soft-delete via `deleted_at` + audit        | Accepted |
| [0004](./0004-idempotency-keys.md)          | `Idempotency-Key` header with Redis replay store                    | Accepted |

## Template

```markdown
# NNNN-title

- Status: proposed | accepted | superseded by XXXX
- Date: YYYY-MM-DD

## Context

…

## Decision

…

## Consequences

…
```

New ADRs: copy the template, get sign-off in the PR review, and reference the
ADR in code comments where the decision bites (see CONTRIBUTING.md).
