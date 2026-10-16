# Requirements and platform support

## Requirements

The root session can be Oh My Pi (OMP) or Claude Code, and workers can be OMP, Claude Code or Codex.

**Every machine that runs workers**

- Herdr **0.9.3+** with compatible live server capabilities and `worktree open`. Matching client/server version strings are not required.
- Git and Treehouse with durable leases, JSON status, and guarded return for project work. Independent scouts do not require Git or Treehouse.

**For OMP (root session or workers)**

- OMP with the host's own login, model roles, and configuration.
- Herdr's OMP integration, version **3+**: `herdr integration install omp`.

**For Claude Code (root session or workers)**

- Claude Code and Bun on the local machine.
- Herdr's Claude integration: `herdr integration install claude`.
- Claude Code workers run only on the local machine. See [Claude Code as the root session](claude-code-root.md).

**For Codex workers**

- The Codex CLI on the local Linux or macOS machine, signed in under each Codex home you use.
- For remote control, a running, paired remote-control Codex server: `codex remote-control start`, then `codex remote-control pair`.
- Codex workers run only on the local machine. See the [Task tool](task-tool.md#worker-agents).

**For remote machines**

- OMP, because remote workers are always OMP workers.
- User-enrolled Herdr profiles, ordinary noninteractive SSH key authentication, and the manually installed and configured host helper. Herdr terminal routing and helper SSH are separate channels.

The root session must run inside a Herdr pane. A local setup with only Claude Code works, with two gaps: the machine readiness check still looks for OMP and reports the machine as not ready, and the OMP parts of model and usage queries are unavailable.

Orchestrator never installs tools or copies secrets or configuration for you. The [manual provisioning guide](../remote-helper.md) covers enrollment, SSH trust, helper installation, host setup, and the known external OMP/mise Windows background Wait limitation.

## Verification status

Linux, macOS, and native Windows are supported targets; the controller is also intended to run natively on Windows. Support is not the same as completed platform verification:

| Surface                       | Exercised evidence                                                                                                                     | Still required                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Linux local host/runtime      | Existing local behavior tests and recorded compiled-helper stdio, Git/Treehouse delivery, and report-stream checks                     | Integrated real remote-host smoke                                   |
| Remote transport and recovery | Isolated lost-acknowledgement tests; native Windows remote from WSL with rebuilt helper and concurrent scout/implementation settlement | Linux/macOS SSH hosts and remaining real failure/recovery scenarios |
| Native Windows controller     | Platform-aware paths and isolated behavior coverage                                                                                    | Native controller run                                               |

Native Windows remote execution has been exercised from a WSL controller, including report collection/acknowledgement, target-owned delivery and cleanup after the Windows regression fixes. Native Windows controller, native macOS and Linux-SSH remotes remain unexercised. See [CONTRIBUTING.md](../../CONTRIBUTING.md#real-host-acceptance) for the operational proof still required.
