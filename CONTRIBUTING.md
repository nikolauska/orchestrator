# Contributing

This repository provides the root OMP orchestrator's visible-worker tools. Keep repository development guidance here; `AGENTS.md` is the runtime job description.

## Structure

```text
.omp/extensions/entrypoint.ts      Extension entrypoint
.omp/extensions/shared.ts          Shared worker state and utilities
.omp/extensions/projects.ts        Projects tool and registry runtime
.omp/extensions/task.ts            Task tool and launch runtime
.omp/extensions/workers.ts         Workers tool and lifecycle runtime
.omp/projects.json                  Local project registry; ignored, never commit
docs/domain/                        Confirmed customer-visible behavior
tests/test-helpers.ts               Shared worker test fixtures
tests/projects.test.ts              Projects tool behavior tests
tests/task.test.ts                  Task tool behavior tests
tests/workers.test.ts               Workers tool behavior tests
```

## Conventions

- Use TypeScript ESM with `node:` imports.
- Use `async`/`await` for asynchronous work.
- Keep the existing naming style: kebab-case files, PascalCase classes and types, camelCase functions and variables.
- Match the existing tab indentation.
- Add comments only when they explain why a non-obvious constraint exists.
- Keep tool schemas, runtime validation, and tests synchronized when changing an input or outcome.
- Update `docs/domain/visible-worker-agents.md` only when confirmed customer-visible behavior changes. Keep implementation details out of domain documentation.
- Preserve retained worktrees and tabs on blocked, dirty, conflicting, or uncertain outcomes. Cleanup must never discard unlanded work.

## Validation

Run from the repository root:

```bash
bun test  # ON FAIL: rerun the failing test file and inspect the first failed assertion.
bun test tests/<tool>.test.ts  # ON FAIL: rerun the failing test file with `-t`.
```

There is no separate install, lint, or build configuration in this repository. Do not invent one; add tooling only when a concrete need justifies it.

Tests use temporary directories and fake command execution. Keep them deterministic, isolated from real Herdr and Treehouse state, and focused on observable registry, launch, control, delivery, and recovery behavior.
