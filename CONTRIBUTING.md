# Contributing

This repository provides the orchestrator's visible-worker tools for an OMP or Claude Code root session. Development guidance lives here; `AGENTS.md` is the root session's job description, and [docs/domain.md](docs/domain.md) describes user-visible behavior.

## Layout

| Path                                    | What it holds                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/core/tool.ts`                      | Harness-neutral tool contract and injected harness services                                     |
| `src/adapters/`                         | OMP extension adapter and the MCP adapter for Claude Code; the only harness-specific code       |
| `src/tools/`                            | One factory per tool, built around one shared API object in `index.ts`                          |
| `src/runtime/`                          | Worker store, host runtime and helper protocol, SSH transport, Herdr/Git/Treehouse/OMP wrappers |
| `scripts/build-helper.ts`               | Native helper build and stdio hello check                                                       |
| `tests/`                                | One `<tool>.test.ts` per tool plus runtime, transport and adapter tests, with shared fixtures   |
| `.omp/extensions/orchestrator/index.ts` | OMP extension discovery shim                                                                    |
| `mcp/claude-code.json`                  | Claude Code MCP config; never a project `.mcp.json`, which OMP also loads                       |
| `.omp/worker-config.yml`                | Approved OMP settings overlay for every worker                                                  |
| `.omp/claude-worker-settings.json`      | Approved permission settings for Claude Code workers                                            |
| `src/runtime/codex.ts`                  | Codex worker model names, efforts, home and model cache                                         |
| `docs/domain/`                          | Confirmed user-visible behavior                                                                 |
| `docs/remote-helper.md`                 | Helper provisioning, runtime contract and entry points                                          |

`.omp/projects.json`, `.omp/model-preferences.json`, `.omp/orchestrator.db` and `.omp/reports/` are controller-local state. They are ignored; never commit them.

## Rules

- **Style.** TypeScript ESM with `node:` imports and `async`/`await`. Kebab-case files, PascalCase classes and types, camelCase functions and variables. Comments explain why a non-obvious constraint exists, not what the code does.
- **Harness boundary.** Only `src/adapters/` imports a harness package such as `@oh-my-pi/pi-coding-agent`. Tool parameter schemas use the harness-injected `zod`; runtime validation imports `@oh-my-pi/omptype/zod`. Never import `@oh-my-pi/pi-utils` from anything the OMP extension can reach: OMP resolves it from this repo's `node_modules`, its native dependency fails to load, and the whole extension is rejected. Only the standalone helper (`src/runtime/remote-helper.ts`) may use it.
- **Keep contracts in sync.** Change tool schemas, runtime validation, tests and the relevant `docs/domain/*.md` together. Keep implementation details out of domain docs.
- **Never discard work.** Blocked, dirty, conflicting or uncertain outcomes keep their worktree and worker space. Cleanup never removes unlanded work or an uncollected scout report without explicit discard authority.
- **Uncertain effects are reconciled, not replayed.** A mutation whose outcome is unknown needs reconciliation before anything else. Generic not-found or missing-resource responses are not receipts and don't authorize a retry. Helper mutations are serialized through the host/controller ledger; only a typed `LOCK_BUSY` with `effect: none` may be retried.
- **Paths and targets belong to their host.** Linux, macOS and native Windows are all targets. Don't lowercase keys, expand home paths, or run controller path utilities on remote strings; controller-local files use native `node:path`. Herdr wrappers take an explicit `ExecutionTarget`. A resolved target never changes on a retained record.
- **Validate wire data** with `validateHostRequest`, `validateHostReply` and `validateHostResult`; report streams go through `ReportStreamValidator`.
- **No shell interpolation.** Executables use native argv. Refuse `.cmd`, `.bat` and `.ps1` shims; use an absolute native runtime plus an absolute entry file instead.
- **C++ builds** use at most two parallel jobs (`cmake --build <dir> --parallel 2`, `ninja -j2`, `make -j2`) unless the user says otherwise. Full-parallel builds have crashed the machine.

## Validation

Run from the repository root:

```bash
bun run fmt
bun run fmt -- --check
bun run lint
bun test
omp --mode rpc --no-ui </dev/null
```

After the OMP load check, look in the newest `~/.omp/logs/*.log` for `Failed to load extension`; the exit code alone doesn't prove the extension loaded. On native Windows PowerShell use `cmd /c "omp --mode rpc --no-ui <NUL"`. A load in a worktree doesn't prove the delivered main checkout loads, so repeat it there after delivery when you can.

On a test failure, rerun `bun test tests/<file>.test.ts` and narrow with `-t`. Tests use temporary directories and fake command execution with no access to real Herdr, Treehouse or hosts, so run them freely. Drive timers with `vi.useFakeTimers()` instead of real sleeps. Host fixtures must keep machine, session and launch identities distinct, and model a lost acknowledgement as an applied effect with a missing response.

`bun run helper:build` builds the native helper and requires its stdio hello to pass; `--target bun-windows-x64` cross-builds for Windows.

## Real-host acceptance

Local tests and the extension load check don't prove remote support. [Requirements and platform support](docs/domain/platform-support.md#verification-status) records what has actually been exercised. To extend that, run these scenarios on real Linux, macOS and native Windows SSH hosts, plus a native Windows controller. Hosts are provisioned by the user following [docs/remote-helper.md](docs/remote-helper.md); use only disposable repositories approved for the test, and get explicit approval before any push.

1. **Prerequisites.** Record host OS, profile ID/session, and helper/OMP/Herdr/Treehouse versions. Check BatchMode SSH separately from Herdr. Confirm a missing helper, wrong overlay bytes, missing integration and a disabled machine are refused before allocation.
2. **Launch.** Register a host-only repository with an unpushed commit. Launch from `HEAD` and from a host-local branch; check the source SHA, excluded dirty scout files, native paths with spaces and Unicode, visible spaces/tabs, and the exact host model.
3. **Control and outages.** Read, send, answer a blocked question in the tab, interrupt, and relaunch with changes preserved. Cut the helper only, Herdr only, and both while another host stays healthy. After four-plus minutes offline, confirm no false stall or death, then restore and restart the controller without a replayed prompt.
4. **Reports.** Interrupt a transfer and confirm staging is kept. Finish collection with matching bytes, SHA-256 and provenance, then read the archive offline. Try invalid or redirected reports and conflicting archive destinations.
5. **Delivery.** Default delivery advances only the host checkout. Exercise one moved-target rebase, retention on dirty/branch-changed/conflict, and hold/land. With approval, exercise push and lost delivery/push acknowledgements without repeated publication.
6. **Cleanup.** Lose cleanup acknowledgements and confirm receipt-based recovery keeps parent/shared spaces and unrelated leases. Try changed profiles and helper identities, recycled pane IDs, Windows junctions and sharing violations, and closing an unfinished uncollectable scout with and without discard.

Report unavailable hosts or missing access as incomplete, and record which scenarios actually ran.
