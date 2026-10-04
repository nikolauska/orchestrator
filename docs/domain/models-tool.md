# Models tool

The Models tool shows which chat models workers can run and remembers the user's model preferences, so Orchestrator picks worker models the way the user wants across sessions.

## Operations

| `op`     | Arguments besides `op`                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `list`   | Optional `machine` or `project`, `view` (`preferred` or `all`), `provider`, `q`, `limit` (positive integer; default 50) |
| `prefer` | `model`, optional `machine` or `project`, `for` (roles/kinds of work), positive integer `rank`, `note`                  |
| `avoid`  | `model`, optional `machine` or `project`, `note`                                                                        |
| `forget` | `model` only                                                                                                            |

`rank: 1` is first choice. `view` defaults to `preferred`; results include total matches and the number returned. Copy a row's exact `model` into `orchestrator_task` rather than constructing a model name.

## Selecting a machine

`list`, `prefer`, and `avoid` accept either `machine` or `project`, never both. Neither means **local**, not the independent-scout default. Connected queries accept `local`, a saved machine ID, or a unique case-sensitive label. A project selects its registered machine and checkout directory. A machine-only query uses the host's configured OMP query directory, profile, and worker overlay; the local default query directory is the controller workspace unless manual helper configuration overrides it.

Results identify the selected `machine`, `session`, `os`, `configuration_context` (cwd, optional OMP profile, overlay path and SHA-256), and `observed_at`. Local queries return `session: null` because catalog inspection does not bind a terminal. Remote queries identify the saved profile's session without requiring it to be running. Remote paths remain native to their host, including Windows paths.

Catalogs and role assignments come only from that host and configuration context. Queries use the local host runtime or remote helper and verify the approved overlay bytes without launch preflight or a running Herdr server. Saved remote profile metadata and helper connectivity are still required; an unavailable helper is an error, not permission to use the controller's catalog. Worker launches still require Herdr readiness. `forget` remains offline-safe.

Worker model selection resolves the requested role, or that context's `default` role, to an exact model and thinking level. Missing roles, unknown selectors, and unsupported thinking levels are refused without a controller fallback. Selection is checked again in the actual allocated worker directory before launch, because project configuration can differ there.

## Listing models

By default the list shows only the models that matter right now: every model the user has a saved preference for, and every model an OMP role currently runs. The full catalog, which can hold hundreds of models, is available on request and can be narrowed by provider or by a search term that matches model names, roles, and the user's notes. Long lists are cut to a limit, and the result says how many matched in total.

Each entry names the exact model value to use for a worker, including a thinking level when one applies, along with its provider, supported thinking levels, context size, accepted input, price when known, the OMP roles that run it, and any saved preference.

Preferred models come first, ordered by rank and then unranked, followed by models that only an OMP role uses, then the rest, and avoided models last.

## Remembering preferences

A preference is saved for one exact model value, so the same model at two thinking levels can carry different preferences. The user can:

- prefer a model, optionally saying which roles or kinds of work it is for, how it ranks against other preferred models, and why;
- mark a model to avoid, optionally with the reason; or
- forget a saved preference.

Saving checks the model against the selected host's live catalog, so a misspelled model or an unsupported thinking level is refused instead of remembered. A remote-only model can be preferred or avoided after that host validates it. Saving again for the same model value replaces the earlier entry.

Preferences stay in one controller-local map, in the existing `.omp/model-preferences.json` format; selecting a machine does not move or copy them. They are not shared with the repository or written to remote machines.

## Stale entries

When a saved model is absent from the selected host's catalog, or an OMP role points at a model the catalog does not have, the list reports it as an issue rather than failing or deleting the preference. A preference valid on another host stays saved.

`forget` accepts only the exact `model` value. It does not query a machine, catalog, or registry, so it works offline even after a remote profile is removed.
