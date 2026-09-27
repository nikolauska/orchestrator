# Orchestrator

Orchestrator is a root [Oh My Pi](https://github.com/can1357/oh-my-pi) workspace for safely coordinating work across local Git projects and project-independent research.

It exists so parallel OMP work stays visible and recoverable: each project gets its own [Herdr](https://herdr.dev) space with every active worker's isolated Treehouse worktree nested under it, independent research runs in a shared research space, research produces a durable report, worker state survives an OMP restart, and blocked or failed work is retained rather than silently discarded.

## Why use it

- **One clear scope per request.** Work targets one registered project or independent research, never an accidental mix of both.
- **Safe project changes.** Implementation workers commit and, by default, fast-forward the registered project's current branch only after successful completion.
- **Research that survives the session.** Scouts write durable reports that remain available after their disposable worktree spaces or research tabs close.
- **Evidence retained for recovery.** Dirty checkouts, delivery conflicts, failed launches, and uncertain cleanup keep their worker space and working directory for inspection.

## Requirements

- `omp` and `herdr` with `worktree open` support on `PATH` (verified with Herdr 0.9.1)
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

   > Close the `fix-login` worker.

   > What is `fix-login` doing right now?

   > Fix the login timeout in `my-app`, but hold it so I can review before it lands.

   > Find the report from the checkout accessibility research.

   > How much Claude usage is left this week?

   > Run the audit on `openai-codex/gpt-5.5:high`.

Orchestrator chooses the appropriate worker and scope from your request. Independent research runs outside registered projects in a separate disposable directory; authenticated external access requires explicit instructions.

## Delivery and recovery

Project implementation workers commit before completion. Successful work fast-forwards the registered project's current branch by default. A task may instead push to a named remote branch, optionally opening a draft pull request (requires an authenticated `gh`), or be held for review until you ask Orchestrator to land it. A launch warns when a worker starts from a branch that is behind its remote.

Orchestrator does not discard uncertain work. A dirty checkout, conflict, failed launch, blocked worker, uncommitted implementation change, or unresolved scout-report cleanup retains the relevant worker space and working location for recovery. Closing a worker that still has undelivered work is refused unless you explicitly ask to discard it.

Worker state lives in `.omp/orchestrator.db`, so workers survive an OMP restart: the next session reconnects to running workers and finishes delivery for any that completed meanwhile. Only one OMP session supervises workers at a time; another session opened in this repository can list workers and read their screens, and takes over once the supervising session exits.

Workers start with the settings overlay in [`.omp/worker-config.yml`](.omp/worker-config.yml), which keeps unattended workers off interactive prompts without changing your own OMP configuration. A blocked worker's question reaches the root session with its screen, and supervision continues if you answer it directly in the worker's tab.

## Models and usage

Each worker runs on an OMP model role or on an exact model from `omp models`, optionally with a thinking level. Before launching larger work, Orchestrator checks provider usage with `omp usage`, which covers every account OMP itself signs in with. When a role's provider is running low, it moves the work to an equally strong model on a provider with room and tells you; it never quietly switches to a weaker model.

## Development

See [`AGENTS.md`](AGENTS.md) for orchestration rules and [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository structure and development conventions.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
