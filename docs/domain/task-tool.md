# Task tool

The Task tool starts visible OMP workers for one registered project or for research outside every registered project. Each request has exactly one scope.

## Project work

Registered-project work supports two assignment types:

- **Implementation** — makes an authorized change, verifies it, and commits it before completion.
- **Scout** — investigates, plans, audits, or diagnoses without delivering changes.

A task may select an existing local branch as its starting point. This lets work and research use a branch other than the registered project's currently checked-out branch.

Workers run in visible Herdr spaces. Each project worker gets its own space, shown nested under the project's space. A project space that Orchestrator creates is named after the registered project; a space you already had for that repository keeps its name. Worker names show their kind, such as `impl·fix-login` or `scout·audit-auth`. A request can start multiple independent assignments together, with a maximum of 32 workers.

Implementation work is delivered locally by default: a successful committed change advances the registered project's current branch. A task that starts from a selected branch can be delivered locally only when that branch is currently checked out; otherwise it can use a named remote delivery branch.

## Project research

A project scout examines the project's committed state captured when it starts. Existing local changes in the registered project are excluded and disclosed in the report.

Each scout writes a durable report. Scout scratch work is never delivered.

## Independent research

Independent scope supports scouts only. It is for research that does not need a registered project.

Independent scouts receive a separate disposable working directory, have no project revision, and may use public web research by default. They run as tabs in a shared `research` space. Authenticated external systems require explicit instructions. They write a durable report that includes source links and the research date.

## Assignment choices

Each assignment has a descriptive worker name and a clear task. A request may choose an available OMP model role for an assignment; omitting it uses the default model.

Workers do not delegate further work.
