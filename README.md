# Orchestrator

Root [Oh My Pi](https://github.com/can1357/oh-my-pi) workspace for coordinating registered-project OMP workers and project-independent scouts in visible [Herdr](https://herdr.dev) tabs.

## Requirements

- `omp` and `herdr` on `PATH`; registered-project work also requires `treehouse` and `git`
- Herdr's OMP integration installed before starting the root session:

```sh
herdr integration install omp
```

## Usage

Start OMP in this repository, register Git roots with the `projects` tool, then delegate project work with `task`. Project workers get a visible Herdr tab and leased Treehouse worktree. Set a task item's `role` (for example, `smol`) to use that configured OMP model role; omit it for OMP's default model.

For research outside every registered project, call `task` with `scope: "independent"` and scout items only. Each scout runs in a unique neutral working directory, writes its durable report under `.omp/reports/_independent/`, may search and read the public web by default, and may use authenticated external systems only when explicitly instructed. Neutrality separates project context; it is not a filesystem, credential, process, or network sandbox.

Project implementation workers commit before completion. By default, successful work fast-forwards the registered project's current branch; a task can instead push to a named remote branch. Dirty checkouts, conflicts, failed launches, and uncertain cleanup retain their work rather than discarding it. Successful independent scouts remove their disposable working directory only after report settlement; failed or blocked scouts retain it with the tab.

See [`AGENTS.md`](AGENTS.md) for orchestration rules and [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and validation.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
