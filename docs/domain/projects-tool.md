# Projects tool

The Projects tool maintains named Git projects on the local machine or a saved Herdr machine. Each registration belongs to exactly one machine; there are no replicas or automatic transfers between machines.

## Operations

| `op`       | Arguments besides `op`                               |
| ---------- | ---------------------------------------------------- |
| `list`     | Optional `machine`; omitted means `local`            |
| `add`      | `name`, `path`, optional `machine`                   |
| `create`   | `name`, optional `path`, optional `machine`          |
| `set-root` | `path`, optional `machine`                           |
| `remove`   | `name` only; the registration determines the machine |

Ordinary names are controller-wide, 1–64 characters, begin with a letter or digit, and contain only letters, digits, `.`, `-`, or `_`. `_independent` is reserved for independent scout reports: add and create refuse it before any host or registry mutation. An existing legacy registration with that name can still be listed and removed. Listing one machine does not list every registration.

## Registering projects

A project is an existing source repository registered under a stable name. Later work requests use that name to select both the repository and its machine.

The tool can:

- list registrations on one machine without connecting to it;
- add an existing repository on that machine;
- remove a registration without deleting the repository, retained workers, or reports;
- set that machine's default location for new projects; and
- create and register a new empty project on that machine.

Omitting the machine selects local, not the independent-research default. Connected operations accept a saved machine ID or a unique, case-sensitive label. Offline listing uses the saved ID, even if the profile has been removed from Herdr.

Registration requires the exact top-level directory of a non-bare Git working checkout. The same repository on two machines is two projects with different names; identical paths or origins do not link their work. Two profiles pointing to the same helper host and repository cannot register it twice. Do not register one physical Windows checkout both locally through WSL `/mnt/c/...` and remotely as `C:\...`: duplicate detection uses each helper's host identity and cannot recognize that cross-environment alias.

Remote paths are interpreted on their own host, including home-directory shortcuts and native Windows paths. Disabled profiles, changed SSH targets or sessions, and changed helper identities are refused rather than silently routing work elsewhere. Removing and registering again changes only future work; retained workers keep their original machine.

Existing local registrations remain readable without a migration write. The first authorized project change imports them and the old creation location, preserving unavailable paths with a pending-validation issue. Adding an available legacy registration again validates its identity. Listing and removing registrations do not require their disks or remote machines to be online.

## Creating projects

Creating a project requires either:

- a previously configured projects location on the chosen machine; or
- an explicit destination on that machine.

The destination must not already exist. Creation initializes an empty Git repository with an initial commit; it does not clone or publish anything. If setup or registration fails after creation, the repository remains for inspection and the error identifies its machine and location.

Remote enrollment, SSH authentication, tools, and approved project roots must be provisioned manually. On a remote machine, `add`, `set-root` and `create` accept only paths inside that host's manually approved project roots and refuse anything outside them; the same applies locally when approved roots are configured. See the [manual provisioning guide](../remote-helper.md) for configuring those roots. Project operations do not install tools or copy credentials or configuration.

`add`, `create`, `set-root` and `remove` change the controller's registry, so only the supervising session can run them; another session can still list registrations.

After an interrupted registry change, the next supervising session can make changes without manually clearing a stale registry lock. If repository creation was interrupted, inspect the destination before trying again; an existing repository is never overwritten.

Example remote-only registration:

```json
{ "op": "add", "name": "app-workbox", "machine": "workbox", "path": "/srv/projects/app" }
```

After registration, use the saved ID for offline listing: `{"op": "list", "machine": "<profile-id>"}`. Changing the independent default does not change project registration or creation roots.
