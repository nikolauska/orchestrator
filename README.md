# Orchestrator

Root [Oh My Pi](https://github.com/can1357/oh-my-pi) workspace for coordinating project-specific OMP workers in visible [Herdr](https://herdr.dev) tabs and isolated Treehouse worktrees.

## Requirements

- `omp`, `herdr`, `treehouse`, and `git` on `PATH`
- Herdr's OMP integration installed before starting the root session:

```sh
herdr integration install omp
```

## Usage

Start OMP in this repository, register Git roots with the `projects` tool, then delegate work with `task`. Each worker gets a visible Herdr tab and a leased Treehouse worktree. Set a task item's `role` (for example, `smol`) to use that configured OMP model role; omit it for OMP's default model.

Workers commit their changes before completion. By default, successful work fast-forwards the registered project's current branch; a task can instead push to a named remote branch. Dirty checkouts, conflicts, failed launches, and uncertain cleanup retain their worktrees rather than discarding work.

See [`AGENTS.md`](AGENTS.md) for orchestration rules and [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and validation.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
