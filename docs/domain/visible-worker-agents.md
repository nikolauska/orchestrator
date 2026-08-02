# Visible worker agents

The root orchestrator manages named local projects and remains the operator's default point of contact. It answers from established evidence or delegates one explicit kind of assignment to a visible, isolated OMP worker.

## Roles

- **Root orchestrator** — resolves the target project, answers directly when established evidence is sufficient, selects worker assignments, relays changes, and presents outcomes.
- **Registered project** — an existing local Git repository known by a stable name. Unregistering it removes only that name; it never changes the repository or deletes retained reports.
- **Implementation worker** — performs an authorized project change directly, verifies it, and commits it for delivery.
- **Scout** — investigates, plans, audits, or diagnoses without delivering project changes. Material uncertainty also leads the root to use a scout rather than guess.

Workers run in visible Herdr tabs and do not delegate to subagents.

## Selecting work

The root answers informational requests directly when the conversation, a prior authoritative report, or other established evidence already resolves them. It launches scouts for explicit investigation, planning, audits, diagnosis, or material uncertainty. Recommendations in a scout report do not authorize implementation; any later implementation requires a fresh, separately authorized assignment.

Every launched assignment explicitly identifies itself as implementation or scout. A scout cannot request a branch push, so it cannot accidentally enter an implementation delivery path.

An assignment may select an OMP model role such as `smol`. The worker uses that configured role's model; assignments without a role keep OMP's default model.

## Workspace and revision

Every worker receives a disposable Treehouse worktree. An implementation worker follows the project's delivery safeguards.

A scout researches the exact committed `HEAD` captured at launch. It can launch while the registered checkout has local changes or a detached `HEAD`. Local changes are excluded from the scout worktree and disclosed to the scout, while the exact commit remains identified. The scout may make scratch edits or commits inside its disposable worktree to support research; none of that work is delivered to the registered project or a remote branch.

## Scout report

Each scout writes a durable standalone Markdown report in the Orchestrator's ignored operational state outside the registered project. The report is authoritative and flexibly covers the useful investigation, findings, evidence, recommendations, and unresolved decisions without required headings or a fixed template. The scout also returns a concise terminal conclusion.

Successful settlement records `completed_with_report`; the root presents this to the user as **Completed with report**, returning both the report and concise conclusion. Unresolved decisions remain part of the completed report and are surfaced by the root without a separate decision record.

Reports are never deleted automatically, including when their registered project is unregistered.

## Implementation delivery

Local delivery remains the default for implementation workers. The worker commits its changes and the registered project branch fast-forwards to that commit. If another implementation worker advances the branch first, completed work rebases onto the new head before the fast-forward. A conflict stops delivery without changing the registered checkout.

An implementation assignment may instead request a branch push. Its committed work is pushed to the requested branch on `origin`, and the registered checkout is unchanged. This does not create a pull request.

## Completion, failures, and recovery

A successful implementation worker or scout closes its tab and returns its disposable worktree. Scout scratch changes do not prevent this cleanup because they are never delivery candidates.

A scout fails settlement when its report is missing, empty, unreadable, or not a regular file. The failed scout's exact Herdr tab and Treehouse worktree remain available for recovery. Blocked workers, failed launches after OMP may have started, uncommitted implementation changes, delivery conflicts, and uncertain cleanup are retained the same way.

Worker control belongs to the current root OMP process. If the root restarts, workers and leases remain safe and visible, but watcher and messaging state is not reconstructed automatically.
