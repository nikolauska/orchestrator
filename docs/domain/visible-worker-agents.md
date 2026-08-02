# Visible worker agents

The root orchestrator manages named local projects and delegates their work to separate OMP worker agents. Workers run in visible Herdr tabs while the root remains the operator's default point of contact.

## Roles

- **Root orchestrator** — the OMP agent that manages project registrations, divides work, launches workers, relays plan changes, and receives outcomes.
- **Registered project** — an existing local Git repository known to the root by a stable name. Unregistering a project removes only that name; it never deletes or changes the repository.
- **Worker agent** — a full OMP agent that performs one assignment directly. A worker does not delegate to subagents.

## Workflow

1. The user registers a local Git repository once, then refers to it by name in later work.
2. The root selects one registered project and may launch several workers for it at once.
3. Every worker receives its own Treehouse worktree, preventing concurrent workers from editing the same checkout.
4. Workers use the project's normal OMP rules, tools, model, and approval settings.
5. The user continues working with the root. When a plan changes, the root messages only the affected workers. The operator can still interact with a worker's Herdr tab when direct recovery or inspection is useful.
6. A finished, blocked, or failed worker wakes the root automatically with its outcome. The root can continue coordinating without the user polling worker tabs.

## Delivery

Local delivery is the default. A worker commits its changes; the registered project branch fast-forwards to that commit. If another worker has advanced the branch, the completed work is rebased onto the new head and then fast-forwarded. A conflict stops delivery without changing the registered checkout.

A task may instead request a branch push. Its committed work is pushed to the requested branch on `origin`, and the registered checkout is not changed. This does not create a pull request.

Successful worker tabs close and their Treehouse leases return to the pool. A successful worker that made no changes also closes cleanly.

## Failures and recovery

A blocked worker, failed launch after OMP may have started, uncommitted change, integration conflict, or uncertain cleanup keeps its exact Herdr tab and Treehouse worktree. The root reports those locations and can send new instructions to a retained worker. Direct tab interaction remains available when root-mediated recovery is insufficient.

Worker control is scoped to the current root OMP process. If the root restarts, workers and leases remain safe and visible, but watcher and messaging state is not reconstructed automatically.
