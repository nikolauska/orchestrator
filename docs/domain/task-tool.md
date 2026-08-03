# Task tool

The Task tool starts visible OMP workers for one registered project or for research outside every registered project. Each request has exactly one scope.

## Project work

Registered-project work supports two assignment types:

- **Implementation** — makes an authorized change, verifies it, and commits it before completion.
- **Scout** — investigates, plans, audits, or diagnoses without delivering changes.

Workers run in visible tabs. A request can start multiple independent assignments together, with a maximum of 32 workers.

Implementation work is delivered locally by default: a successful committed change advances the registered project's current branch. A request may instead deliver the committed change to a named remote branch.

Local delivery requires the registered project to be clean and on a named branch. If the project becomes changed or switches branches before delivery, delivery stops rather than overwriting local work. When concurrent completed changes can be applied safely, they are reconciled before local delivery; conflicts are retained for recovery.

## Project research

A project scout examines the project's committed state captured when it starts. Existing local changes in the registered project are excluded and disclosed in the report.

Each scout writes a durable report. Scout scratch work is never delivered.

## Independent research

Independent scope supports scouts only. It is for research that does not need a registered project.

Independent scouts receive a separate disposable working directory, have no project revision, and may use public web research by default. Authenticated external systems require explicit instructions. They write a durable report that includes source links and the research date.

## Assignment choices

Each assignment has a descriptive worker name and a clear task. A request may choose an available OMP model role for an assignment; omitting it uses the default model.

Workers do not delegate further work.
