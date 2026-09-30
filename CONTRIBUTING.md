# Contributing

This repository provides the root OMP orchestrator's visible-worker tools. Keep repository development guidance here; `AGENTS.md` is the runtime job description.

## Structure

```text
.omp/extensions/orchestrator/index.ts  Extension entry that registers every tool
.omp/extensions/orchestrator/*.ts      Tool factories
.omp/runtime/shared.ts                 Shared types and helpers
.omp/runtime/store.ts                  Durable worker registry and supervising-session ownership, backed by SQLite
.omp/runtime/spaces.ts                 Herdr project and research space helpers
.omp/runtime/{git,herdr,omp,treehouse,session}.ts  CLI and session-file wrappers
.omp/worker-config.yml                 OMP settings overlay passed to every worker
.omp/projects.json                     Local project registry; ignored, never commit
.omp/model-preferences.json            Local model preferences; ignored, never commit
.omp/orchestrator.db                   Local worker state; ignored, never commit
docs/domain/                           Confirmed customer-visible behavior
tests/test-helpers.ts                  Shared worker test fixtures
tests/projects.test.ts                 Projects tool behavior tests
tests/reports.test.ts                  Reports tool behavior tests
tests/task.test.ts                     Task tool behavior tests
tests/workers.test.ts                  Workers tool behavior tests
tests/usage.test.ts                    Usage summary behavior tests
tests/models.test.ts                   Models tool behavior tests
```

## Conventions

- Use TypeScript ESM with `node:` imports.
- Use `async`/`await` for asynchronous work.
- Keep the existing naming style: kebab-case files, PascalCase classes and types, camelCase functions and variables.
- Match the existing tab indentation.
- Add comments only when they explain why a non-obvious constraint exists.
- Keep tool schemas, runtime validation, and tests synchronized when changing an input or outcome.
- Update the relevant `docs/domain/*.md` when confirmed customer-visible behavior changes. Keep implementation details out of domain documentation.
- Preserve retained worktrees and worker spaces on blocked, dirty, conflicting, or uncertain outcomes. Cleanup must never discard unlanded work.

## Validation

Run from the repository root:

```bash
bun run lint  # Check the source and tests with Oxlint.
bun run fmt -- --check  # Verify formatting without changing files.
bun test  # ON FAIL: rerun the failing test file and inspect the first failed assertion.
bun test tests/<tool>.test.ts  # ON FAIL: rerun the failing test file with `-t`.
```

Run `bun run fmt` to apply formatting changes before committing.

Tests use temporary directories and fake command execution. Keep them deterministic, isolated from real Herdr and Treehouse state, and focused on observable registry, launch, control, delivery, and recovery behavior. They have no production access, so run them freely, fix failures your change causes, and rerun the affected files without pausing. Drive supervision timers with `vi.useFakeTimers()` instead of real sleeps.
