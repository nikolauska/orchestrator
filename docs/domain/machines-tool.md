# Machines tool

The Machines tool discovers local and saved Herdr machines, checks their readiness, and saves the machine choice for future independent research. It does not move retained workers or change a project's machine.

## Operations

| `op`          | Arguments besides `op` | Selection                                               |
| ------------- | ---------------------- | ------------------------------------------------------- |
| `list`        | None                   | Local and saved/referenced machines; no host connection |
| `status`      | Optional `machine`     | Omitted checks all saved machines plus local            |
| `check`       | Required `machine`     | Use `local`, a saved ID, or a unique label              |
| `set-default` | Required `machine`     | Save the choice for future independent scouts           |

Unlike project/catalog queries, omitted `status.machine` means **all**, not local. `check` and `set-default` require an explicit selector.

## Discovery and checks

- **List** shows local plus saved Herdr profiles and the independent-research default. It reads saved metadata without connecting to a host. Missing, disabled, or changed profiles referenced by registrations, creation locations, defaults, or retained workers appear as issues; their work is not deleted.
- **Status** checks fresh Herdr reachability for one machine or all saved machines plus local. One unavailable machine does not hide healthy machines. It does not need the separate host helper.
- **Check** probes the Herdr channel and the separate host helper, verifies the independent-scout prerequisites and approved worker settings, and reports readiness, each channel's state, errors/remedies, and the available host OS, paths, configuration context, and capabilities. A reachable Herdr server alone does not mean the machine is ready. Project launches additionally check that project's Git root and Treehouse lease support; a generic machine check is not a check of every project or build tool.

Connected operations accept an opaque saved machine ID or a unique, case-sensitive label. Labels may change without changing machine identity. Disabled profiles, changed SSH targets or Herdr sessions, and changed helper identities are refused rather than falling back to local or rebinding work. An offline machine is unavailable, not proof that its workers stopped.

## Independent-research default

The default initially selects local. **Set-default** requires the supervising session and a ready machine; another session can still list, check and query status. A failed check leaves the default unchanged. The saved default is controller-local and applies only to future independent research; projects still select their machine from their own registration. Retained workers keep their original target even when the default changes or a profile disappears.

The tool as a whole is classified for write approval, so every operation, including `list`, `status` and `check`, follows the same approval policy.

## Manual provisioning

Enroll machines and recover SSH authentication through Herdr/OpenSSH yourself. Provision OMP, its accounts and configuration, the host helper, approved worker settings, required tools, and Herdr's OMP integration on each host. The Machines tool does not enroll, remove, install, reconnect, restart servers, bypass host-key trust, or copy credentials or configuration.

Linux, macOS, and native Windows paths are interpreted on the selected execution host. The controller does not turn remote paths into local filesystem locations. Machine checks do not create projects, worker checkouts, or visible terminal spaces.

Follow the [manual provisioning guide](../remote-helper.md), then call `{"op": "check", "machine": "<profile-id>"}`. A failed check reports the missing prerequisite instead of creating a worker. Use `{"op": "set-default", "machine": "local"}` to restore the initial independent choice.
