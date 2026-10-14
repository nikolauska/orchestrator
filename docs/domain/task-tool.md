# Task tool

The Task tool starts visible OMP or Claude Code workers for one registered project or for research outside every registered project. Each request has exactly one scope and one machine. Project work uses the machine saved in its registration; a project request cannot override it.

The tool is named `orchestrator_task`. A project request takes `project`, shared `context`, and `tasks`. An independent request instead takes `scope: "independent"`, shared `context`, `tasks`, and optional `machine`. No request can combine `project` with `scope` or `machine`.

Each task needs `kind`, `name`, and a nonempty `task`; it may set either `role` or `model`, not both, and an optional `agent`. Project implementations also accept `startFrom`, `pushTo`, and `hold`; project scouts accept only `startFrom` in addition to the common fields. Independent scouts accept none of those project options. Worker names are 1–64 ASCII characters, begin with a letter or digit, and contain only letters, digits, `.`, `-`, or `_`. A name that is invalid, repeated within the request, or already used by a retained worker refuses the whole request before any worker starts. The name labels the worker's Herdr space or tab and its report file, so short names stay readable.

```json
{
  "scope": "independent",
  "machine": "workbox",
  "context": "Use public sources only.",
  "tasks": [
    {
      "kind": "scout",
      "name": "audit-guidance",
      "task": "Research current accessibility guidance."
    }
  ]
}
```

## Worker agents

`agent` selects the worker: `omp` (the default) or `claude` for Claude Code. A Claude Code worker:

- runs only on the local machine; a request that would start one on a saved remote machine is refused before anything is allocated;
- takes an optional `model`, either a Claude Code alias such as `opus` or a full model name, with an optional `:low`, `:medium`, `:high`, `:xhigh` or `:max` effort suffix. It does not accept `role`. Without a model it uses the host's Claude Code default;
- starts with the approved `.omp/claude-worker-settings.json`. That file accepts file edits and allows common read, Git and build commands. It denies `git push`, `git remote`, `git config` and subagents. Anything else asks in the worker's tab, and the worker is then reported as blocked;
- requires Claude Code and Herdr's Claude integration on the machine. A batch with only Claude workers does not need OMP's model catalog.

A request can mix OMP and Claude Code workers. Each worker's `agent` appears in its launch and list results.

## Project work

Registered-project work supports two assignment types:

- **Implementation** — makes an authorized change, runs and checks it, fixes what it broke, and commits it before completion.
- **Scout** — investigates, plans, audits, or diagnoses without delivering changes.

A task may select an existing branch on the project's machine as its starting point. The worker starts from that host's exact committed revision, not a controller branch or a copy of the controller checkout. When its starting branch is behind its upstream, the launch result says so; Orchestrator only compares and never fetches or changes the checkout.

Workers run in visible Herdr spaces. Each project worker gets its own space, shown nested under the project's space. A project space that Orchestrator creates is named after the registered project; a space you already had for that repository keeps its name. Worker names show their kind, such as `impl·fix-login` or `scout·audit-auth`. A request can start multiple independent assignments together, with a maximum of 32 workers.

Default implementation delivery belongs to the registered checkout on the project's own machine. It requires a clean checkout on the named starting branch. `pushTo` remains explicit publication from the worker checkout, not a default transfer between machines. A task can instead be held for review until it is landed with the Workers tool.

## Project research

A project scout examines the committed state captured on the project's machine when it starts. Uncommitted changes in that registered checkout are excluded and disclosed, even when the controller has an unrelated checkout.

Each scout writes a durable report. Scout scratch work is never delivered.

## Independent research

Independent scope supports scouts only. It is for research that does not need a registered project.
Independent scouts use the saved independent-machine default, initially `local`. An optional `machine` selects a saved Herdr machine ID or unique label for that request only. Changing the default does not move retained workers.

Independent scouts receive a separate disposable working directory, have no project revision, and may use public web research by default. They run as tabs in a shared `research` space. Authenticated external systems require explicit instructions. They write a durable report that includes source links and the research date.

## Assignment choices

Each assignment has a descriptive worker name and a clear task. A request may choose an OMP role available on its selected host, or an exact available model with an optional thinking level; omitting both uses that host's default. Preflight checks the host's catalog, profile, approved worker settings, helper and Herdr integration before allocating resources. Another registration on that machine with a missing checkout or changed path does not by itself block launch; working locations must still stay separate from registered projects. The selected project's own checkout must remain available and match its registration. The model is checked again in the actual worker directory, since its committed project configuration can differ from the registered checkout. An unavailable choice refuses launch rather than falling back to the controller's catalog.

Workers do not delegate further work. They run with fixed settings that keep them from stopping on interactive prompts meant for your own sessions; your own OMP configuration is not changed.

## Partial starts and report locations

A launch reserves its worker name before acquiring a directory. If allocation, opening, agent start or prompt submission loses its acknowledgement, the worker stays recorded with its launch phase and any acquired resources for recovery. Orchestrator never allocates again or resends the assignment. An idle agent at startup is not evidence that the assignment finished.

A retained partial launch can be explicitly closed once its original host confirms that nothing was created and no work may still be in progress. If only a working location was acquired and no terminal was opened, close can release it after checking ownership and protecting any changes or report. Uncertain outcomes keep the record available for recovery.

Local and remote scouts write to the host staging path named by `report_source_path`. `report_path` is the intended controller-local `.omp/reports/` destination, not proof of collection. Supervision collects and verifies the report and its provenance sidecar before acknowledging it on the host and reporting completion. Same-host relaunch, collection, delivery and cleanup use the worker's original machine and recorded evidence.

Migrated local reports already at their final archive path are validated in place. They remain archive-owned, so worker cleanup never deletes them.
