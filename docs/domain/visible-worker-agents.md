# Visible worker agents

The root orchestrator remains the operator's default point of contact. It answers from established evidence or delegates one explicit assignment to a visible OMP worker. Work is either scoped to one registered project or explicitly project-independent.

## Roles

- **Root orchestrator** — resolves the assignment scope, answers directly when established evidence is sufficient, selects worker assignments, relays changes, and presents outcomes.
- **Registered project** — an existing local Git repository known by a stable name. Unregistering it removes only that name; it never changes the repository or deletes retained reports.
- **Implementation worker** — performs an authorized registered-project change directly, verifies it, and commits it for delivery.
- **Registered-project scout** — investigates, plans, audits, or diagnoses against one project's captured revision without delivering project changes.
- **Project-independent scout** — researches outside registered-project scope without a project checkout or revision.

Workers run in visible Herdr tabs and do not delegate to subagents.

## Selecting scope and work

The root answers informational requests directly when the conversation, a prior authoritative report, or other established evidence already resolves them. It launches scouts for explicit investigation, planning, audits, diagnosis, or material uncertainty. Recommendations in a scout report do not authorize implementation; any later implementation requires a fresh, separately authorized assignment.

An explicitly named project selects registered-project scope. Explicit project-independent research selects independent scope. A clear follow-up keeps independent scope until a project is named or repository evidence becomes necessary. The root asks one concise question when that transition is ambiguous.

Each launch has one scope. Registered-project scope accepts implementation and scout assignments. Independent scope accepts scouts only and rejects implementation, branch delivery, malformed scope, and mixed scope before allocating worker resources. Every assignment explicitly identifies itself as implementation or scout.

An assignment may select an OMP model role such as `smol`. The worker uses that configured role's model; assignments without a role keep OMP's default model.

## Working location and provenance

Registered-project workers receive disposable Treehouse worktrees. An implementation worker follows the project's delivery safeguards.

A registered-project scout researches the exact committed `HEAD` captured at launch. It can launch while the registered checkout has local changes or a detached `HEAD`. Local changes are excluded from the scout worktree and disclosed to the scout, while the exact commit remains identified. The scout may make scratch edits or commits inside its disposable worktree; none are delivered.

Each project-independent scout receives a unique neutral working directory under stable Orchestrator operational state, outside the Orchestrator repository and registered projects. It uses the current Herdr workspace and the same visible-tab and supervision lifecycle, without Treehouse, project Git operations, or a project revision. Its scratch files are disposable and are never delivered.

Neutrality provides project-context separation, not filesystem, credential, process, or network sandboxing. Global and user OMP instructions still apply.

## External research

Project-independent scouts may search the public web and read public URLs by default. Access to authenticated external systems requires explicit assignment instructions.

## Scout report

Each scout writes a durable standalone Markdown report in the Orchestrator's operational state outside registered projects. Project-independent reports use a reserved independent namespace. The report is authoritative and flexibly covers useful investigation, findings, evidence, recommendations, and unresolved decisions without required headings or a fixed template. Independent reports include source URLs and the research date. The scout also returns a concise terminal conclusion.

Successful settlement records `completed_with_report`; the root presents this to the user as **Completed with report**, returning both the report and concise conclusion. Unresolved decisions remain part of the completed report and are surfaced by the root without a separate decision record.

Reports are never deleted automatically, including when a registered project is unregistered or an independent scout's working directory is removed.

## Implementation delivery

Local delivery remains the default for implementation workers. The worker commits its changes and the registered project branch fast-forwards to that commit. If another implementation worker advances the branch first, completed work rebases onto the new head before the fast-forward. A conflict stops delivery without changing the registered checkout.

An implementation assignment may instead request a branch push. Its committed work is pushed to the requested branch on `origin`, and the registered checkout is unchanged. This does not create a pull request.

## Completion, failures, and recovery

A successful registered-project worker closes its tab and returns its disposable worktree. Registered-project scout scratch changes do not prevent cleanup because they are never delivery candidates.

A successful project-independent scout closes its tab and removes its neutral working directory only after its report settles. Completion records identify independent scope and the working directory without project, worktree, revision, or lease details that do not exist.

A scout fails settlement when its report is missing, empty, unreadable, or not a regular file. Its exact Herdr tab and worktree or neutral working directory remain available for recovery. Blocked workers, failed launches after OMP may have started, uncommitted implementation changes, delivery conflicts, and uncertain cleanup are retained the same way.

Worker control belongs to the current root OMP process. If the root restarts, worker resources remain safe and visible, but watcher and messaging state is not reconstructed automatically.
