# Orchestrator

Orchestrator is a root [Oh My Pi](https://github.com/can1357/oh-my-pi) workspace for safely coordinating work across local Git projects and project-independent research.

It exists so parallel OMP work stays visible and recoverable: each worker runs in a visible [Herdr](https://herdr.dev) tab, project work uses an isolated Treehouse worktree, research produces a durable report, and blocked or failed work is retained rather than silently discarded.

## Why use it

- **One clear scope per request.** Work targets one registered project or independent research, never an accidental mix of both.
- **Safe project changes.** Implementation workers commit and, by default, fast-forward the registered project's current branch only after successful completion.
- **Research that survives the session.** Scouts write durable reports that remain available after their disposable workspaces close.
- **Evidence retained for recovery.** Dirty checkouts, delivery conflicts, failed launches, and uncertain cleanup keep their worker tab and working directory for inspection.

## Requirements

- `omp` and `herdr` on `PATH`
- `treehouse` and `git` on `PATH` for registered-project work
- Herdr's OMP integration installed before starting the root session:

```sh
herdr integration install omp
```

## Quick start

1. Start an OMP session in this repository.
2. Tell Orchestrator where a project lives. For example:

   > Register the Git repository at `/path/to/my-app` as `my-app`.

3. Then describe the outcome you want in plain language. For example:

   > Investigate why the checkout flow is slow in `my-app` and report the likely cause.

   > Update `my-app` to show a clear error when a checkout is declined.

   > Research the current accessibility guidance for checkout forms. Do not use a project.

4. Ask Orchestrator to keep you informed or recover work when needed:

   > Show the active workers.

   > Find the report from the checkout accessibility research.

Orchestrator chooses the appropriate worker and scope from your request. Independent research runs outside registered projects in a separate disposable directory; authenticated external access requires explicit instructions.

## Delivery and recovery

Project implementation workers commit before completion. Successful work fast-forwards the registered project's current branch by default; a task may instead deliver to a named remote branch.

Orchestrator does not discard uncertain work. A dirty checkout, conflict, failed launch, blocked worker, uncommitted implementation change, or unresolved scout-report cleanup retains the relevant tab and working location for recovery.

## Development

See [`AGENTS.md`](AGENTS.md) for orchestration rules and [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository structure and development conventions.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
