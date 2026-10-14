# Contributing

This repository provides the root OMP orchestrator's visible-worker tools. Keep repository development guidance here; `AGENTS.md` is the runtime job description.

## Structure

```text
.omp/extensions/orchestrator/index.ts               OMP extension discovery shim; re-exports src/adapters/omp.ts
src/core/tool.ts                                   Harness-neutral tool contract and injected harness services
src/adapters/omp.ts                                OMP adapter: tool registration, session events, nextTurn wake
src/tools/index.ts                                 Builds every tool around one shared API object
src/tools/*.ts                                     Tool factories returning harness-neutral specs
src/runtime/shared.ts                             Shared types and helpers
src/runtime/store.ts                              Durable worker registry and supervising-session ownership, backed by SQLite
src/runtime/execution.ts                          Host-owned paths and immutable local/SSH targets
src/runtime/helper-protocol.ts                    Strict versioned helper requests, results, receipts, report frames
src/runtime/project-registry.ts                   Read-only v2 registry normalization and legacy import
src/runtime/host.ts                               Host-local domain dispatcher, ownership ledger, delivery/report receipts
src/runtime/host-paths.ts                         Native filesystem identity and containment (including Windows)
src/runtime/ledger-queue.ts                       Per-host/controller ledger serialization
src/runtime/{remote,remote-helper,helper-entry}.ts SSH transport, import-safe helper implementation and unconditional compiled entry
src/runtime/machines.ts                           Herdr profile discovery, binding validation, preflight, and host OMP contexts
src/runtime/report-transfer.ts                    Controller-local report collection, provenance, and durable receipts
src/runtime/spaces.ts                             Herdr project and research space helpers
src/runtime/{git,herdr,omp,treehouse,session}.ts    CLI and session-file wrappers
.omp/worker-config.yml                             OMP settings overlay passed to every worker
.omp/projects.json                                 Local project registry; ignored, never commit
.omp/model-preferences.json                        Local model preferences; ignored, never commit
.omp/orchestrator.db                               Local worker state; ignored, never commit
.omp/reports/                                      Controller-local report archive; ignored, never commit
docs/domain/                                      Confirmed customer-visible behavior
scripts/build-helper.ts                           Native helper build and stdio hello check
tests/test-helpers.ts                              Shared worker test fixtures
tests/herdr-fixtures.ts                            Host and Herdr test fixtures
tests/task-fixtures.ts                             Task launch test fixtures
tests/helper-build.test.ts                         Compiled helper entry behavior tests
tests/herdr.test.ts                                Target routing and terminal control tests
tests/host.test.ts                                 Host operation and recovery tests
tests/projects.test.ts                             Projects tool behavior tests
tests/machines.test.ts                             Machine/default selection and prerequisite behavior tests
tests/query-readiness.test.ts                      Catalog/usage queries without Herdr readiness
tests/remote.test.ts                               Helper transport and protocol tests
tests/runtime-contracts.test.ts                    Runtime schema, path, registry, and store contracts
tests/reports.test.ts                              Reports tool behavior tests
tests/task.test.ts                                 Task tool behavior tests
tests/workers.test.ts                              Workers tool behavior tests
tests/usage.test.ts                                Usage summary behavior tests
tests/models.test.ts                               Models tool behavior tests
```

## Conventions

- Use TypeScript ESM with `node:` imports.
- Only `src/adapters/` may import a harness package such as `@oh-my-pi/pi-coding-agent`. Tools and runtime use `src/core/tool.ts` types; tool parameter schemas use the harness-injected `zod`, while runtime-internal validation imports `@oh-my-pi/omptype/zod` directly.
- Use `async`/`await` for asynchronous work.
- Keep the existing naming style: kebab-case files, PascalCase classes and types, camelCase functions and variables.
- Match the existing tab indentation.
- Add comments only when they explain why a non-obvious constraint exists.
- Keep tool schemas, runtime validation, and tests synchronized when changing an input or outcome.
- Update the relevant `docs/domain/*.md` when confirmed customer-visible behavior changes. Keep implementation details out of domain documentation.
- Preserve retained worktrees and worker spaces on blocked, dirty, conflicting, or uncertain outcomes. Cleanup must never discard unlanded work.
- SQLite schema v2 migrations rebuild the worker table inside one transaction, preserving worker names, legacy leases/aliases, and the supervisor owner. Unknown schema versions are refused before writes. `WorkerStore.close()` releases the database handle before deleting temporary fixtures, including on Windows.
- `status_changed_at` records lifecycle transitions; `updated_at` records every durable write. Connection updates must not reset lifecycle timers. Partial launches reserve their names without requiring pane, tab, or workspace IDs.
- Legacy worker targets remain `unresolved_local` until a later routing layer verifies their original local binding. They are not executable targets. Resolved targets cannot be changed on a retained record.
- Use `validateHostRequest`, `validateHostReply`, and `validateHostResult` for wire data. Recorded operation results require the original mutation operation keyed by operation ID; standalone shape schemas do not perform that contextual check. Report streams use `ReportStreamValidator` for identity, sequence, byte counts, incremental UTF-8 validation and SHA-256.
- Local and SSH targets support Linux, macOS, and native Windows; the controller is intended to run natively on Windows too. Paths and equality keys belong to the host: do not lowercase keys, expand home paths, or use controller path utilities on remote strings. Controller-local files use native `node:path` operations. Native Windows remote execution has been exercised from WSL; native Windows controller and Linux/macOS SSH proof remain required. Parser tests are not platform proof.
- `readProjectRegistry` normalizes v2 and legacy data in memory, preserving unavailable paths and a nonempty legacy `projects-root`. Authorized project mutations serialize writers, write sorted JSON through an exclusive same-volume temporary file, close handles before atomic rename, and remove the obsolete root file only after successful persistence. Supervisor ownership excludes other processes and the in-process queue serializes calls; no `.omp/projects.lock` directory needs manual recovery after an interrupted registry write. Listing/removal do not probe remote hosts; duplicates are checked by host identity and native root identity, not origin URL.
- A scout cannot enter cleanup without a durable local report receipt unless its terminal outcome records explicit discard authority or a failed legacy local scout is explicitly closed after topology closure and archive absence are proven. The host rechecks absence and original lease guards; explicit close alone never authorizes deleting an uncollectable staged report.
- Herdr wrappers take an explicit `ExecutionTarget`. Remote calls use the saved machine ID; retained local calls use the bound session. Topology queues are keyed with `targetKey`, and host paths are passed unchanged.
- `ensureIntegration` checks the live 0.9.3+ server, endpoint generation 1, protocol 22+ and snapshot surface. Remote installation inspection is not forwarded by Herdr: host preflight supplies `HerdrIntegrationEvidence` with the matching `targetKey` and a `ToolCheck` named `herdr-omp-integration`, available with a numeric version of at least 3. Never replace this evidence with the controller's integration status.
- Herdr mutation failures carry `HostError` semantics through `HerdrError`; unknown effects require reconciliation, not another mutation. Only a parsed `agent_prompt_stalled` response permits one Enter after matching alias, terminal incarnation, pane, cwd and session evidence are rechecked. Generic not-found is not a cleanup receipt.
- Helper runtime/provisioning and exported consumer entry points are documented in [docs/remote-helper.md](docs/remote-helper.md). `bun run helper:build` builds a native launcher and requires its real stdio hello to pass; `--target bun-windows-x64` supports Linux-to-Windows cross-building, with hello required on that target. It never installs/configures a remote machine. Helper-local ledgers do not change the controller's SQLite/registry formats.
- Runtime modules import zod only as `import { zod as z } from "@oh-my-pi/pi-coding-agent"`. The loaded extension must share OMP's own zod; importing `@oh-my-pi/omptype/zod` directly pulls a second copy from `node_modules` and OMP then fails to load the extension. Never import `@oh-my-pi/pi-utils` (or any other `@oh-my-pi/*` package besides `pi-coding-agent`) from a module the extension can reach either: OMP resolves it from this repo's `node_modules`, where its native dependency fails to load, and rejects the whole extension. Only the standalone helper entry (`remote-helper.ts`) may use them. `scripts/build-helper.ts` resolves the zod import to `scripts/helper-agent-shim.ts` for the standalone helper, which cannot bundle the agent package. Load-test the changed checkout with `omp --mode rpc --no-ui </dev/null` and inspect the newest `~/.omp/logs/*.log` for `Failed to load extension`. A worktree load does not prove the delivered main checkout loads; repeat there after delivery when that checkout is available for validation.
- New host allocations require a captured source SHA. Legacy local adoption preserves an unknown original SHA as absent, verifies original lease/agent evidence, and never allocates/resets. Only new allocation results enforce a required `sourceHead`; lookup may expose an adopted legacy resource without it.
- Host fixtures must distinguish machine/session/launch identity, catalogs, accounts, source refs, resources, and receipts. Identical pane IDs on two servers must not route to the same worker. Model lost acknowledgements as an applied effect with a missing response, not a mock that echoes inputs.
- Serialize helper mutations and checkpoint-writing observations by host/controller ledger. A new operation refused before entering the ledger returns typed `LOCK_BUSY` with `effect: none`; controller intents may safely retry it within a bound. Missing IDs become no-effect only after retirement under the host lock, which fences delayed submissions. A recorded failure before any effect is `refused` with `effect: none`; a later attempt needs a fresh operation ID. Applied or uncertain effects require reconciliation; generic missing-resource responses do not authorize replay.
- Executable descriptors use native argv, never shell interpolation. Refuse `.cmd`, `.bat`, and `.ps1` helper shims; use an absolute native runtime plus absolute OMP entry file when needed. Windows paths, junctions, sharing violations, file handles, and ACLs need host-native handling.
- Build C++ host tooling with at most two parallel jobs unless the user explicitly says otherwise: `cmake --build <dir> --parallel 2`, `ninja -j2`, or `make -j2`. Concurrent full-parallel builds have crashed the machine.

## Validation

Run from the repository root:

```bash
bun run fmt
bun run fmt -- --check
bun run lint
bun test
omp --mode rpc --no-ui </dev/null
```

After the OMP load check, inspect the newest `~/.omp/logs/*.log` for `Failed to load extension`; command exit alone does not establish extension loading. In native Windows PowerShell, use `cmd /c "omp --mode rpc --no-ui <NUL"` for stdin EOF. On a test failure, rerun `bun test tests/<tool>.test.ts`, then narrow with `-t` to inspect the first failed assertion.

Tests use temporary directories and fake command execution. Keep them deterministic, isolated from real Herdr and Treehouse state, and focused on observable registry, launch, control, delivery, and recovery behavior. They have no production access, so run them freely, fix failures your change causes, and rerun the affected files without pausing. Drive supervision timers with `vi.useFakeTimers()` instead of real sleeps.

## Real-host acceptance

Provisioning instructions live in [docs/remote-helper.md](docs/remote-helper.md). Provisioning belongs to the user: checks never enroll machines, install tools, copy credentials/configuration, or restart servers. Register only disposable repositories approved for the smoke; explicit push/PR checks additionally require publication approval.

Local tests and an extension load check do not prove remote support. A native Windows remote has been exercised from WSL with the rebuilt helper and concurrent scout/implementation settlement, including report archive/provenance/host acknowledgement, Windows checkout delivery and cleanup. Native Windows controller and macOS/Linux SSH remotes remain unexercised; WSL is not native Windows controller proof. Run the following acceptance scenarios on real Linux, macOS, and native Windows SSH hosts, plus a separate native Windows controller run. The Windows smoke does not prove every failure/recovery case. OMP/mise's extensionless Windows background Wait failure remains an external limitation, documented in the helper guide:

1. Record host OS, profile ID/session, helper/OMP/Herdr/Treehouse versions, and observed outputs. Verify ordinary BatchMode SSH separately from Herdr; check missing helper, incorrect overlay bytes, unavailable profile/integration, and disabled machine refusals before allocation.
2. Register a target-only repository containing an unpushed commit. Launch from its HEAD and a selected host-local branch; verify the source SHA, excluded dirty scout files, native paths (including spaces and Unicode), visible worker spaces/tabs, and exact host model/profile.
3. Read, send, answer a blocked question in the tab, interrupt, and relaunch on the same host/directory with changes preserved. Disconnect helper only, Herdr only, and both while another host stays healthy. After more than four minutes offline, confirm no false stalled/dead result, then restore access and restart the controller without replaying the prompt.
4. Interrupt report transfer and confirm staging is retained. Finish collection with matching bytes/SHA-256 and provenance before release; read the local archive offline. Exercise invalid/redirected reports and conflicting archive destinations.
5. Verify default delivery advances only the target checkout, not the controller or origin. Exercise one moved-target rebase, dirty/changed-branch/conflict retention, and held review/land. With explicit approval, exercise push and lost delivery/push acknowledgements without blindly repeating publication.
6. Lose cleanup acknowledgements and confirm receipt-based recovery preserves parent/shared spaces and unrelated leases. Exercise changed profiles/helper identities, recycled pane IDs, Windows junctions/sharing violations, and close of an unfinished uncollectable scout with and without explicit discard.

Report unavailable hosts or missing access as incomplete acceptance. Keep verification claims separate from intended support, and record which scenarios actually ran.
