# How Orchestrator works

Orchestrator coordinates software work across Git projects that live on different machines, plus research that needs no project. You talk to one root session (Oh My Pi, or [Claude Code](claude-code-root.md)). It starts visible workers that do the work, supervises them, and reports back.

## Scope

Every request targets exactly one scope: one registered project, or independent research. Never an accidental mix of both.

A registered project is an existing Git repository saved under a stable name on exactly one machine: the local machine or a saved [Herdr](https://herdr.dev) SSH machine. The same repository on two machines is two separately named projects. There are no replicas and no Git transfers between machines. Independent research runs outside every registered project, on the saved default machine (initially local) or a machine chosen for that request.

## Workers

- **Implementation workers** change a project, check the change, and commit it.
- **Scouts** investigate, plan, audit, or diagnose, and write a durable report.

Each project worker runs in its own isolated Treehouse worktree on the project's machine, shown as a Herdr space nested under the project's space. Independent scouts run in disposable directories, as tabs in that machine's shared `research` space. Workers are OMP agents by default, or Claude Code agents on the local machine. They use the approved `.omp/worker-config.yml` on their own host without changing your OMP configuration, and they never delegate further.

When a worker stops to ask something, the question reaches the root session. Answers typed directly in the worker's tab count too.

## Delivery

A finished implementation fast-forwards the project's registered checkout on its own machine. The checkout must be clean and on the expected branch. You can instead hold the work for review and land it later, or explicitly push it to an origin branch. A push never opens a pull request by itself.

Scout reports are collected into the controller's `.omp/reports/` archive with provenance before the scout counts as complete. Collected reports stay readable while their machine is offline or after it is removed.

## Recovery

Dirty checkouts, delivery conflicts, failed launches, connection loss, and uncertain cleanup keep the worker and its work instead of silently discarding it. Worker state lives in the controller's `.omp/orchestrator.db` and survives a restart. Only one session supervises at a time; another can list workers and read their screens.

Offline does not mean dead. Herdr terminal access and the host helper's SSH channel are separate, so one can work while the other is down. Restore the original machine profile, session, and authentication; workers never move to a replacement machine. Lost acknowledgements are checked, not blindly replayed.

## Next

- Setup: [Requirements and platform support](platform-support.md) and [Remote helper provisioning](../remote-helper.md).
- Day-to-day behavior: the tool topics in the [handbook index](../domain.md).
