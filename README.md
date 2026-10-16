# Orchestrator

Orchestrator is a root agent workspace, run from [Oh My Pi](https://github.com/can1357/oh-my-pi) or Claude Code, for coordinating work across machine-bound Git projects and project-independent research. Projects can live locally or on saved [Herdr](https://herdr.dev) SSH machines. You describe what you want; Orchestrator starts visible workers, supervises them, and reports back.

- **One clear scope per request.** Work targets one registered project or independent research, never an accidental mix of both.
- **Machine-owned project changes.** A project belongs to exactly one machine, and implementation workers deliver to that machine's checkout. There are no replicas or cross-host Git transfers.
- **Research that survives the session.** Scout reports are collected into a durable local archive that stays readable offline.
- **Evidence retained for recovery.** Conflicts, failures, and connection loss keep work instead of silently discarding it.

Read [How Orchestrator works](docs/domain/overview.md) for the full picture.

## Requirements

Herdr 0.9.3+ plus either OMP or Claude Code, with Herdr's integration for whichever you use. Codex workers also need the Codex CLI. Project work also needs Git and Treehouse. Remote machines need OMP and the manually provisioned helper. See [Requirements and platform support](docs/domain/platform-support.md) for exact versions and which platforms have actually been tested.

## Quick start

1. Install Herdr's integration for your agent: `herdr integration install omp` or `herdr integration install claude`.
2. Start an OMP session in this repository, or run `bun run claude` for a [Claude Code root session](docs/domain/claude-code-root.md).
3. Register a project:

   > Register the Git repository at `/path/to/my-app` as `my-app`.

4. Describe the outcome you want:

   > Investigate why the checkout flow is slow in `my-app` and report the likely cause.

   > Fix the login timeout in `my-app`, but hold it so I can review before it lands.

   > Research the current accessibility guidance for checkout forms. Do not use a project.

   > Register `/srv/projects/my-app` on machine `workbox` as `my-app-workbox`.

   > Show the active workers.

## Documentation

- [Domain handbook](docs/domain.md): how each tool behaves.
- [Remote helper provisioning](docs/remote-helper.md): manual host setup and recovery.
- [AGENTS.md](AGENTS.md): orchestration rules for the root session.
- [CONTRIBUTING.md](CONTRIBUTING.md): repository structure, validation, and real-host acceptance checks.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
