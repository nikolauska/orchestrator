# Orchestrator

Orchestrator is a root [Oh My Pi](https://github.com/can1357/oh-my-pi) workspace for coordinating work across machine-bound Git projects and project-independent research. Projects can live locally or on saved [Herdr](https://herdr.dev) SSH machines.

Each project worker runs in an isolated Treehouse worktree on the project's machine, visible in a Herdr space nested under the project's space. Independent scouts run in disposable directories as tabs in that machine's shared research space. Worker state survives a controller restart; blocked, failed, offline, or uncertain work stays recorded for recovery.

## Why use it

- **One clear scope per request.** Work targets one registered project or independent research, never an accidental mix of both.
- **Machine-owned project changes.** A project belongs to exactly one machine. Implementation workers commit and, by default, fast-forward that machine's registered checkout. There are no replicas or cross-host Git transfers.
- **Research that survives the session.** Remote reports are collected into the controller's durable archive with provenance before successful completion. Collected reports remain readable offline.
- **Evidence retained for recovery.** Dirty checkouts, delivery conflicts, failed launches, connection loss, and uncertain cleanup retain work instead of silently discarding it.

## Requirements and verification status

- Herdr **0.9.3+** on the controller and execution hosts, with compatible live server capabilities, `worktree open`, and OMP integration version **3+**. Matching client/server version strings are not required.
- OMP on the controller and each worker host, with the host's own login, model roles, and configuration.
- Git and Treehouse with durable leases, JSON status, and guarded return for project work. Independent scouts do not require Git or Treehouse.
- For remote work: user-enrolled Herdr profiles, ordinary noninteractive SSH key authentication, and the manually installed/configured host helper. Herdr terminal routing and helper SSH are separate channels.

Linux, macOS, and native Windows are supported targets; the controller is also intended to run natively on Windows. Support is not the same as completed platform verification:

| Surface                       | Exercised evidence                                                                                                                     | Still required                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Linux local host/runtime      | Existing local behavior tests and recorded compiled-helper stdio, Git/Treehouse delivery, and report-stream checks                     | Integrated real remote-host smoke                                   |
| Remote transport and recovery | Isolated lost-acknowledgement tests; native Windows remote from WSL with rebuilt helper and concurrent scout/implementation settlement | Linux/macOS SSH hosts and remaining real failure/recovery scenarios |
| Native Windows controller     | Platform-aware paths and isolated behavior coverage                                                                                    | Native controller run                                               |

Native Windows remote execution has been exercised from a WSL controller, including report collection/acknowledgement, target-owned delivery and cleanup after the Windows regression fixes. Native Windows controller, native macOS and Linux-SSH remotes remain unexercised. See [CONTRIBUTING.md](CONTRIBUTING.md) for the operational proof still required. The [manual provisioning guide](docs/remote-helper.md) covers enrollment, SSH trust, helper installation, host setup, and the known external OMP/mise Windows background Wait limitation; Orchestrator never installs remote tools or copies secrets/configuration for you.

Before starting a local root session, install Herdr's OMP integration yourself:

```sh
herdr integration install omp
```

## Quick start

1. Start an OMP session in this repository, or a Claude Code session as described in [Claude Code as the root session](#claude-code-as-the-root-session).
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

   > From now on, use `openai-codex/gpt-5.6:xhigh` for reviews.

   > Run the audit on `openai-codex/gpt-5.5:high`.

Orchestrator chooses the appropriate worker and scope from your request. Independent research runs outside registered projects in a separate disposable directory; authenticated external access requires explicit instructions.

### Remote projects and independent research

Provision the host first using [docs/remote-helper.md](docs/remote-helper.md), then ask:

> List saved machines and check the prerequisites on `workbox`.

> Register `/srv/projects/my-app` on machine `workbox` as `my-app-workbox`. It exists only on that host.

> Register `C:\Users\Niko\src\my-app` on machine `windows-host` as `my-app-windows`.

> Fix the login timeout in `my-app-workbox`, but hold the work for review on its host.

> Use `workbox` as the default machine for future independent research.

> Run this independent research on `windows-host` for this launch only.

Project launches always use their registration's machine; they have no machine override. Independent scouts use the saved default (initially `local`) or a per-launch `machine`. The same repository on two machines is two separately named projects. Never register one physical checkout twice through WSL `/mnt/c/...` and Windows `C:\...`: those environments have different helper identities, so duplicate detection cannot protect that case.

## Delivery and recovery

Project implementation workers commit before completion. Default delivery advances only the registered checkout on the project's machine, with a clean checkout on the expected named branch. `startFrom` names a committed branch on that host; default delivery requires it to be checked out. A moved target permits one rebase and another fast-forward attempt; conflicts, dirtiness, or branch changes retain work.

`hold: true` stops changed work at `ready`; review its diff on the worker's host and request `workers land` when ready. `pushTo` explicitly publishes from that host's worker checkout to an origin branch instead of advancing the registered checkout. It is never an implicit cross-host transfer or authorization to open a pull/merge request. A launch warns if its source is behind its upstream without fetching.

Offline does not mean dead. Herdr can remain reachable while helper SSH is unavailable, or vice versa. Restore the original profile, session, helper identity, and authentication; relaunch stays on the same machine and directory. Lost prompt, delivery, or push acknowledgements are reconciled, not blindly replayed. Closing unfinished work requires explicit authority; `discard: true` cannot safely release an offline host and never deletes collected reports.

Worker state lives in the controller's `.omp/orchestrator.db`. The next supervising session reconnects to retained workers and resumes from recorded evidence. Only one session supervises; another can list workers and read fresh screens. An unavailable screen is reported as unavailable, not treated as stalled progress.

Without a manual helper configuration, local execution keeps per-user state under `~/.omp/orchestrator/`: `host-id` holds the persistent local host identity, `host-runtime/` holds operation records and staged local scout reports, and `independent-workers/` holds disposable independent working directories. A controller-host `~/.omp/orchestrator/helper.json` (or the file selected by `OMP_ORCHESTRATOR_HELPER_CONFIG`) instead defines the `local` identity, runtime and working roots, query settings, and approved project roots. Do not add, remove, or change that configuration while local workers are retained; changing their host identity or roots can prevent recovery. See the [helper guide](docs/remote-helper.md#local-runtime-state) for paths and details.

Workers use the approved [`.omp/worker-config.yml`](.omp/worker-config.yml) bytes on their own host, without changing your OMP configuration. Blocked questions reach the controller, and answers typed directly in the worker's tab remain authoritative.

Local and remote scouts write to host staging at `report_source_path`. Supervision collects and acknowledges reports under controller-local `.omp/reports/<project>/` or `.omp/reports/_independent/`, with a `<report-stem>.meta.json` provenance sidecar, before completion and release. Ordinary close retains an uncollectable unfinished report unless you explicitly authorize discard. Migrated local reports are validated in place and remain archive-owned.

## Claude Code as the root session

Claude Code can run the root session instead of OMP. Workers are still OMP agents, so the requirements above still apply. Start it from this repository:

```sh
bun run claude
```

This loads the orchestrator MCP server from `mcp/claude-code.json` and enables it as a Claude Code [channel](https://code.claude.com/docs/en/channels-reference), which is how worker results wake an idle session. Channels are a research preview: a custom channel needs `--dangerously-load-development-channels`, which asks for confirmation at startup, and Team or Enterprise organizations must enable channels. The flag has no effect with `claude -p`. Without the channel, the tools still work but nothing wakes the session; read missed results with `workers events`.

Workers can also be Claude Code agents: ask for one, for example "use a Claude Code worker on opus". Claude Code workers currently run only on the local machine and need Herdr's Claude integration (`herdr integration install claude`). They start with the approved permission settings in `.omp/claude-worker-settings.json`. See the [Task tool](docs/domain/task-tool.md#worker-agents) for details.

The server is deliberately not in a project `.mcp.json`: OMP also loads that file, and an OMP session would then start a second supervisor.

## Models and usage

Each worker uses a role or an exact model from its selected host's OMP catalog, optionally with a thinking level. Model preferences live in one controller-local `.omp/model-preferences.json` map, not a map per host. `models` and `usage` accept either `project` or `machine`; neither means local, not the independent default. Query the project before project launches, or the chosen machine before independent launches. Accounts and roles belong to that host/profile/worker configuration; quota is never added across machines. An unavailable host or model is not a reason to fall back to the controller. A model named for one task wins over remembered preferences; a quota-driven swap must stay equally strong and be explained.

Claude Code workers have their own entries: `models` lists Claude Code preferences with `agent: "claude"`, and local `usage` adds a `claude_code` section read through the pinned `quota-axi` dependency, run with Bun.

Catalog and usage queries use the local runtime or remote helper without Herdr launch preflight. They work while the terminal server is unavailable, provided the selected host's OMP, approved settings and helper channel are available. Worker launches still require Herdr.

## Development

See [`docs/domain.md`](docs/domain.md) for tool behavior, [`AGENTS.md`](AGENTS.md) for orchestration rules, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository structure, validation, and the remaining real-host acceptance checks.

## Test

```sh
bun test
```

## License

[MIT](LICENSE)
