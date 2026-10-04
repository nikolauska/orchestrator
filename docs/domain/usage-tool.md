# Usage tool

The Usage tool reports how much provider usage is left for the accounts OMP workers spend from. It only reports; it never picks a model.

## Arguments

Call with `{}` for local usage, `{"machine": "<profile-id-or-label>"}` for one host, or `{"project": "<registered-name>"}` for a project's context. There is no `op` field. Selectors must be nonempty and cannot be combined.

## Selecting a machine

Pass either `machine` or `project`, never both. Neither means **local**, not the independent-scout default. Connected queries accept `local`, a saved machine ID, or a unique case-sensitive label. A project selects its registered machine and checkout directory; a machine-only query uses that host's configured OMP query directory, profile, and worker overlay. The local default query directory is the controller workspace unless manual helper configuration overrides it.

The result includes `machine`, `session`, `os`, `configuration_context` (cwd, optional OMP profile, overlay path and SHA-256), and `observed_at`, alongside the usage fields. Local queries return `session: null`; remote queries identify the saved profile's session without requiring it to be running. Host paths, including native Windows paths, are reported unchanged.

Usage queries use the local host runtime or remote helper and verify the approved overlay bytes without launch preflight or a running Herdr server. Saved remote profile metadata and helper connectivity are still required. Worker launches continue to require Herdr readiness.

Accounts and roles belong to the selected host and configuration context. The tool never falls back to controller accounts when a remote query fails. It never adds capacity across machines, even when they share the same provider account; querying each machine separately does not create extra quota.

## What it shows

For each provider, every signed-in account appears with its usage windows, such as 5 hours or 7 days. Each window shows the percent remaining, how much of the window has already passed, and when it resets. Comparing the percent used with the share of the window that has passed shows whether an account is spending faster than its window allows. Account names are shortened so they don't appear in full.

Each provider also shows how many accounts' worth of each window is left across that host's accounts, and which OMP model roles in the selected profile and configuration context currently resolve to that provider. Accounts that have no usage data, such as API keys, are listed separately.
