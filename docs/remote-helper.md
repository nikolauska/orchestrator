# Host helper: manual provisioning and runtime contract

Remote work uses two independent channels: `herdr --machine <profile-id>` controls visible terminals, while a second ordinary noninteractive SSH login runs `omp-orchestrator-helper --stdio-v1` for host filesystem, Git, Treehouse, OMP queries, reports, and delivery. Local work uses the same host operations in-process and does not require an installed SSH helper.

The user provisions everything below. Orchestrator checks and refuses with remedies; it never enrolls machines, installs tools, approves SSH trust, copies credentials/configuration, or replaces a Herdr server. Provision under the same host user for SSH, Herdr, OMP, and Treehouse. A project belongs to one host; no clone synchronization or cross-host Git transfer is provided.

Native Windows remote execution has been exercised from a WSL controller, including the rebuilt helper and concurrent worker settlement described below. Linux/macOS SSH remotes and a native Windows controller remain unexercised; setup instructions are not proof of those platforms.

## 1. Prepare the host and ordinary SSH

Use Herdr **0.9.3+** with compatible live capabilities on the controller and target. Install native OMP and Bun on the target; for project work also install Git and Treehouse with durable leases, JSON status, and guarded returns. Provision project build tools yourself. Independent scouts do not require Git/Treehouse at runtime, although building the helper requires a copy of this repository and its locked dependencies.

### Linux remote

Install and enable your distribution's OpenSSH server. For Debian/Ubuntu, from a host administrator terminal:

```sh
sudo apt install openssh-server
sudo systemctl enable --now ssh
```

Allow the configured SSH port through the host firewall and connect as the worker user, not as root. Other distributions may name the service `sshd`. Obtain the host-key fingerprint through a trusted host console:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

### macOS remote

Enable **System Settings → General → Sharing → Remote Login** and allow the intended worker user. Install native macOS tooling; do not substitute a Linux VM for macOS verification. Obtain the host-key fingerprint from the Mac's trusted terminal:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

### Native Windows remote

From an elevated PowerShell terminal on the Windows host:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP
```

If the SSH firewall rule is absent, create it for your permitted network/addresses:

```powershell
New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

For an administrator account, the default OpenSSH configuration reads `C:\ProgramData\ssh\administrators_authorized_keys`, not that user's `.ssh\authorized_keys`. Add **only the controller's public key** as one line, using the host's administrator terminal:

```powershell
$file = "C:\ProgramData\ssh\administrators_authorized_keys"
if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
Add-Content -Path $file -Encoding ascii -Value "<controller-public-key-line>"
icacls $file /inheritance:r
icacls $file /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F'
icacls $file
```

The file's access entries must be **Administrators** (`*S-1-5-32-544`) and **SYSTEM** (`*S-1-5-18`) only. `/inheritance:r` removes inherited entries; `/grant:r` replaces those principals' grants but does not remove other explicit entries. Remove any other explicit principal shown by `icacls` with `icacls $file /remove "<principal>"`, then inspect again. These SID forms work across localized Windows installations. Nonadministrator accounts normally use `%USERPROFILE%\.ssh\authorized_keys`; restrict it to the intended user and required system access according to OpenSSH policy.

Compare the host fingerprint from that trusted Windows terminal:

```powershell
ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub
```

Use native Windows Herdr, OMP, Treehouse, Git, Bun, and the compiled `.exe` helper. WSL is not a native Windows remote. A **WSL controller → Windows host on the same PC** is a valid native-Windows remote, but never register one checkout through both WSL `/mnt/c/...` and Windows `C:\...`. Duplicate detection is per helper `hostId`, and cannot recognize that these two environments share the physical checkout.

### Controller key, host trust, and SSH alias

Use an existing approved key, or generate a dedicated key on the controller:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_orchestrator
ssh-add ~/.ssh/id_ed25519_orchestrator
```

Install only its `.pub` contents into the target user's authorized keys; never copy the private key. Linux/macOS targets use `~/.ssh/authorized_keys` with owner-only access (`chmod 700 ~/.ssh`, `chmod 600 ~/.ssh/authorized_keys`). On a native Windows controller, OpenSSH normally uses `$HOME\.ssh`; load a passphrase-protected key into the user-managed Windows `ssh-agent` before noninteractive checks.

Configure a stable alias in the controller's `~/.ssh/config` (Windows: `$HOME\.ssh\config`). Substitute the real address and host user:

```sshconfig
Host windows-host
    HostName <current-host-address>
    User <worker-user>
    IdentityFile ~/.ssh/id_ed25519_orchestrator
    IdentitiesOnly yes
    HostKeyAlias windows-host
```

Use the alias as the saved Herdr SSH target too. `HostKeyAlias` associates trust with a stable name when the address changes, for example a WSL NAT gateway IP. It does not bypass trust: a genuinely changed host key still requires comparison and deliberate user action.

Connect once interactively and compare the displayed fingerprint with the trusted host-console fingerprint before accepting:

```sh
ssh windows-host
```

Exit that shell, then prove the separate helper-channel login can run without prompts:

```sh
ssh -o BatchMode=yes windows-host whoami
```

An unknown host key produces `Host key verification failed` in BatchMode because it cannot ask for approval. Fix trust interactively after comparison; do not disable host-key checking. Passphrase/MFA authentication must already be satisfied through keys/ssh-agent or a user-managed ControlMaster. Herdr's private SSH ControlPath is not reused by the helper.

## 2. Enroll the Herdr machine

Follow Herdr's [Connecting machines](https://herdr.dev/docs/connecting-machines/) instructions. After ordinary SSH works, run on the controller in an interactive terminal:

```sh
herdr machine add windows-host --remote-session agents --label windows-host
herdr machine list --json
herdr machine status windows-host --json
```

For Linux/macOS, substitute your alias (for example `workbox`). Herdr enrollment can offer to install/update Herdr or replace an incompatible running server; the **user**, not Orchestrator, decides. Replacement can stop pane processes. Save the opaque profile ID returned by `machine list`; one profile selects one target/session, not every session on a host.

Read-only terminal-channel verification:

```sh
herdr --machine <profile-id> agent list
```

Install the OMP integration on the execution host as its worker user:

```sh
herdr integration install omp
herdr integration status
```

The helper checks this **host-local** status for OMP integration version **3+**; Herdr does not forward integration inspection through `--machine`. Verify OMP itself is installed and logged in on that host, with its model roles and optional profile configured. Its Herdr `omp` agent kind must launch the same OMP installation/account context that the helper queries. Configuring the helper's executable descriptor does not configure Herdr's agent launcher or a running server's PATH.

The native `herdr` executable must be on the SSH login user's **noninteractive PATH** (with executable discovery through PATHEXT on Windows). There is no helper executable descriptor for Herdr. A discovered `.cmd`, `.bat`, or `.ps1` launcher is refused; installing integration from an interactive shell does not prove the helper can find Herdr.

If Herdr is Attention, recover interactively using the command it reports. `herdr machine reconnect <profile-id>` handles Herdr authentication recovery where supported but does not install/update a server; Linux/macOS controllers support Herdr's managed-connection recovery, while native Windows recovery is not supported by Herdr yet. Ordinary helper SSH still needs its own working noninteractive login. Do not restart a server merely because its version differs from the controller's.

## 3. Build and install the helper

Build with installed Bun and the repository's locked dependencies. The build uses a dedicated executable entry rather than relying on Bun's compiled `import.meta.main` flag. Native builds run the emitted binary with a real stdio `hello` and temporary configuration; an empty response or zero exit alone fails the build.

```text
bun install --frozen-lockfile
bun run helper:build
```

Cross-build a Windows x64 helper from Linux/WSL with the same locked checkout:

```sh
bun run helper:build --target bun-windows-x64
```

`--target` also accepts `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, and `bun-windows-arm64`. Cross-target builds cannot run their output on the controller: they report that limitation and require the target's real stdio hello below before installation is considered verified.

The native artifact is `node_modules/.bin/omp-orchestrator-helper` (`omp-orchestrator-helper.exe` on Windows). Manually place it on the SSH login user's PATH as `omp-orchestrator-helper`, or `omp-orchestrator-helper.exe` on Windows. It must be invocable from that user's ordinary noninteractive SSH login:

Linux/macOS example, from the target's repository root:

```sh
mkdir -p "$HOME/.local/bin"
install -m 700 node_modules/.bin/omp-orchestrator-helper "$HOME/.local/bin/omp-orchestrator-helper"
```

Add `$HOME/.local/bin` to the **noninteractive SSH** PATH, not only an interactive shell startup file. On macOS, SSH's PATH may omit Homebrew locations: ensure both the fixed helper launcher and native `herdr` are discoverable there. Absolute helper executable descriptors can locate Git, Treehouse, and OMP, but not Herdr.

Native Windows example, from the target repository root in PowerShell after the same Bun build:

```powershell
New-Item -ItemType Directory -Force "$HOME\.local\bin" | Out-Null
Copy-Item node_modules\.bin\omp-orchestrator-helper.exe "$HOME\.local\bin\omp-orchestrator-helper.exe"
```

Append the directory to the **user** PATH without replacing existing entries:

```powershell
$bin = "$HOME\.local\bin"
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', "$path;$bin", 'User')
}
```

From a fresh controller terminal/login, check discovery:

```text
ssh -T -o BatchMode=yes <saved-ssh-target> "where omp-orchestrator-helper"
```

Add that directory to the worker user's Windows PATH. A running SSH/Herdr service or server may retain an older environment; confirm in a fresh SSH login and the actual Herdr OMP launch environment rather than assuming the new PATH is effective. Never replace/restart a server with running workers without the user's recovery decision.

```text
ssh -T -o BatchMode=yes -o ConnectTimeout=10 <saved-ssh-target> "omp-orchestrator-helper --stdio-v1"
```

That command waits for one newline-terminated JSON request **and stdin EOF**; it is not an interactive health command. Use the hello probe below once configuration exists. The transport always uses this fixed remote command. Project paths, branch names, launch IDs, and other data travel on stdin, never in remote shell syntax. Windows OpenSSH may use cmd or PowerShell as its login shell; the compiled native helper requires neither a shell script nor WSL.

Also run the installed binary without arguments: it must print usage on stderr and exit `2`, not silently exit `0`. Then require `ok: true`, the configured hostId and native OS from the stdio hello below. Keep a backup of the working binary until the replacement passes hello.

SSH authentication and host-key trust are user-owned. Load passphrase-protected keys with `ssh-add`, verify ordinary SSH access, or use a user-managed ControlMaster. The helper neither relaxes host-key checking nor uses Herdr's private SSH ControlPath. Herdr terminal routing is a separate channel.

## 4. Configure roots, executables, profile, and overlay

Manually create `<user-home>/.omp/orchestrator/helper.json`. An explicitly configured `OMP_ORCHESTRATOR_HELPER_CONFIG` in the target login environment overrides that location. The controller never forwards or copies this file.

Create the configuration parent directory yourself. Generate a UUID once with `bun -e 'console.log(crypto.randomUUID())'` on Linux/macOS or `[guid]::NewGuid().ToString()` in Windows PowerShell, then put it in `hostId`. Do not reuse the sample UUID below across hosts or regenerate it during upgrades.

Example Linux/macOS configuration (replace UUID and paths with real host values):

```json
{
  "version": 1,
  "hostId": "873f9554-17c0-4a33-b6d4-2d7ec7bdb6bc",
  "overlayPath": "/opt/omp-orchestrator/worker-config.yml",
  "runtimeRoot": "/srv/omp-orchestrator/runtime",
  "neutralRoot": "/srv/omp-orchestrator/neutral",
  "queryCwd": "/srv/omp-orchestrator/query",
  "approvedProjectRoots": ["/srv/projects"],
  "executables": {
    "git": { "executable": "git", "prefixArgs": [] },
    "treehouse": { "executable": "treehouse", "prefixArgs": [] },
    "omp": { "executable": "omp", "prefixArgs": [] }
  }
}
```

Concrete per-user directories, outside the helper source checkout and all project roots:

```sh
mkdir -p "$HOME/.omp/orchestrator" "$HOME/.omp/orchestrator-artifacts" "$HOME/.omp/orchestrator-runtime" "$HOME/.omp/orchestrator-neutral" "$HOME/.omp/orchestrator-query" "$HOME/src"
chmod 700 "$HOME/.omp/orchestrator" "$HOME/.omp/orchestrator-artifacts" "$HOME/.omp/orchestrator-runtime" "$HOME/.omp/orchestrator-neutral" "$HOME/.omp/orchestrator-query"
```

Use absolute paths for those directories in your configuration. The examples below are alternative layouts, not commands that create `/srv` or `D:`. `queryCwd` must exist; a neutral dedicated query directory avoids inheriting one project's OMP settings in machine-only queries. Project queries use the registered checkout, and launch checks run again in the allocated worktree.

Windows configuration example (replace UUID and every installation/entry-file path with the actual native installation):

```json
{
  "version": 1,
  "hostId": "64975f31-f41c-49b9-86fc-0d4c6ae0e2fb",
  "overlayPath": "C:\\Users\\Niko\\.omp\\orchestrator-artifacts\\worker-config.yml",
  "runtimeRoot": "D:\\OMP Runtime\\state",
  "neutralRoot": "D:\\OMP Runtime\\neutral",
  "queryCwd": "D:\\OMP Query",
  "approvedProjectRoots": ["C:\\Users\\Niko\\src"],
  "ompProfile": "workers",
  "executables": {
    "git": { "executable": "C:\\Program Files\\Git\\cmd\\git.exe", "prefixArgs": [] },
    "treehouse": {
      "executable": "C:\\Tools\\treehouse.exe",
      "prefixArgs": ["--root", "D:\\OMP Pool"]
    },
    "omp": {
      "executable": "C:\\Users\\Niko\\.bun\\bin\\bun.exe",
      "prefixArgs": ["C:\\Tools\\omp\\actual-entry-file.js"]
    }
  }
}
```

Treehouse's `--root` prefix puts its pool under a dedicated provisioned parent. `approvedProjectRoots` restricts source repositories, not Treehouse's worktree placement; provision and protect the chosen pool separately.

`actual-entry-file.js` is a placeholder for your installed OMP package's real entry file, not a file shipped by Orchestrator. Read that installation's launcher/package metadata to find it. Omit `ompProfile` if you use the default profile. Create the Windows roots yourself with `New-Item -ItemType Directory -Force`, including the configuration directory `$HOME\.omp\orchestrator`. Protect helper state/configuration/overlay with owner-restricted ACLs, for example on each dedicated directory:

```powershell
$root = "D:\OMP Runtime\state"
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $root /inheritance:r
icacls $root /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
icacls $root
```

Remove unintended explicit entries as with authorized keys. Apply equivalent protection to the neutral root and helper configuration/artifact directories, not to an unrelated shared parent or every project. On Linux/macOS, restrict `helper.json` itself to mode `600` after saving it.

`ompProfile` is optional and must name an already provisioned OMP profile. The helper applies the same profile and byte-verified overlay to catalog/role/usage queries. Preflight also checks the host-local `herdr integration status` output and returns `herdr-omp-integration` with its numeric installed version, at least `3`. Herdr does not forward this query through `--machine`.

Catalog and usage inspection resolves the approved host query context through `omp.context`, not launch preflight. It verifies overlay bytes but does not check Herdr integration or resolve a live local terminal session. Project queries replace only the query cwd with the registered host checkout. Launch readiness still checks both channels and the integration.

Windows paths are native JSON strings, for example `"D:\\OMP Runtime\\state"`, `"D:\\OMP Runtime\\neutral"`, `"C:\\Users\\Nïko\\src"`, and `"C:\\Program Files\\Git\\cmd\\git.exe"`. Fully qualified drive paths and UNC paths are accepted when the host tools/filesystem support them. `C:repo`, `\repo`, device namespaces, alternate streams, and reserved-device aliases are refused. `~` and `~/` expand using the execution host's home, not the controller's.

Executable descriptors are available only for Git, Treehouse, and OMP. They contain an absolute executable or a bare PATH-discovered name, plus literal argv prefixes. `.cmd`, `.bat`, and `.ps1` shims are refused. For a Bun/Node-backed OMP installation, manually configure the native runtime executable and an absolute entry-file path in `prefixArgs`; do not use `cmd /c` or interpolate worker arguments into a shell fragment. Bare tool discovery respects the host PATH/PATHEXT, but a discovered shell shim is not executable support. Native `herdr` must be discoverable on the SSH user's noninteractive PATH; it has no descriptor.

Native mise `.exe` shims (for example `C:\Users\Niko\AppData\Local\mise\shims\omp.exe` and `treehouse.exe`) are valid descriptors. Runtime-plus-entry-file configuration is an alternative for script-backed installations, not a requirement for these native launchers. `mise which omp` can report `not a mise bin` in a working installed layout; use `where omp`, inspect launcher forwarding, and verify the actual Herdr-launched OMP command line instead of relying only on mise discovery.

For ad-hoc PowerShell probes over SSH, explicitly set UTF-8 output before printing native paths or process information:

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
```

Windows PowerShell can emit CLIXML progress on stderr. These settings apply to shell probes; the compiled helper already sends JSON-only UTF-8 stdout and needs neither a shell shim nor WSL.

Preserve `hostId` across upgrades. Changing it causes a typed `HOST_MISMATCH`; retained workers must never be rebound to a different machine. Generate the installation UUID once during manual provisioning. Missing configuration is a prerequisite error, not permission to generate remote config, install tools, or copy credentials.

Create writable runtime/neutral roots before preflight. They must be separate, non-nested directories, outside approved project boundaries and helper/configuration/overlay paths. Install the helper outside these disposable roots. `approvedProjectRoots` controls host project validation/creation; new projects are initialized there, never cloned. Symlink/junction targets are resolved before identity and containment checks. The helper's paths belong to the host; controller code must not join or delete them with local path utilities.

Protect the configuration, runtime, neutral, and controller state directories from other users. On Linux/macOS provision owner-only permissions. On Windows provision restrictive owner ACLs; POSIX file modes are not a Windows ACL guarantee. Do not put runtime/ledger state on a shared network filesystem or allow a second controller to manage the same clone. The helper trusts the SSH user's authority; its ownership guards protect against stale controller/resource IDs, not a malicious account owner.

Manually provision the approved `.omp/worker-config.yml` bytes. Preflight compares SHA-256, including LF versus CRLF; changing line endings changes the approval hash. The helper does not transfer credentials, OMP configuration, tools, or overlays.

Copy only the approved worker overlay artifact by hand, for example from the host's matching Orchestrator source checkout:

```sh
install -m 600 .omp/worker-config.yml "$HOME/.omp/orchestrator-artifacts/worker-config.yml"
```

On Windows, `Copy-Item .omp\worker-config.yml "$HOME\.omp\orchestrator-artifacts\worker-config.yml"` copies bytes without text re-encoding. Compare with the controller artifact:

```sh
# Linux, from each checkout:
sha256sum .omp/worker-config.yml
# macOS:
shasum -a 256 .omp/worker-config.yml
```

```powershell
Get-FileHash -Algorithm SHA256 "$HOME\.omp\orchestrator-artifacts\worker-config.yml"
```

Compare the provisioned host file's hash with the controller's `.omp/worker-config.yml` hash. Git `autocrlf` or saving in an editor can change LF to CRLF; matching settings text is not enough. The overlay pins `plan.defaultOnStartup: false`, `prewalk.enabled: false`, and `retry.usageReservePolicy: auto`. It is not the host's OMP login/config store.

Log in and configure model roles in OMP on the host yourself; no controller credential export is part of setup. Confirm native executable versions and the effective selected profile/overlay from `queryCwd`:

```text
git --version
treehouse --version
treehouse get --help
treehouse status --help
treehouse return --help
omp --profile workers --config=<absolute-overlay-path> models --json
omp --profile workers --config=<absolute-overlay-path> config get modelRoles --json
```

Omit `--profile workers` when no profile is configured. If OMP is runtime-backed, invoke the configured native runtime/entry-file instead of a refused shell shim. Independent-only hosts can skip the Git/Treehouse commands; the configuration schema still requires all three executable descriptors.

## 5. Verify both channels and machine readiness

Send a read-only helper hello after installing `helper.json`. This checks fixed-command discovery, config, protocol, and host identity, not every prerequisite. The UUIDs below are probe identifiers, not a saved controller identity.

Linux/macOS/WSL controller:

```sh
printf '%s\n' '{"protocol":"omp-orchestrator-helper","version":1,"requestId":"1046bcb7-384a-4346-bb80-baece3eb669f","controllerId":"391dfc1d-14b5-4df2-a42c-33cd53b6f6f6","op":"hello","args":{"supportedVersions":[1]}}' | ssh -T -o BatchMode=yes -o ConnectTimeout=10 <saved-ssh-target> "omp-orchestrator-helper --stdio-v1"
```

Native Windows PowerShell controller:

```powershell
'{"protocol":"omp-orchestrator-helper","version":1,"requestId":"1046bcb7-384a-4346-bb80-baece3eb669f","controllerId":"391dfc1d-14b5-4df2-a42c-33cd53b6f6f6","op":"hello","args":{"supportedVersions":[1]}}' | ssh -T -o BatchMode=yes -o ConnectTimeout=10 <saved-ssh-target> "omp-orchestrator-helper --stdio-v1"
```

Expect one JSON reply with `ok: true`, the configured `hostId`, protocol/version, and native `os` (`linux`, `darwin`, or `win32`). Stdout must be JSON-only; shell banners or progress text corrupt framing. A native Windows target must report `win32`, not Linux.

In the root OMP session, call:

```json
{ "op": "check", "machine": "<profile-id>" }
```

This is the **Machines tool**, not a helper subcommand. Expect `ready: true`, `herdr.state: "online"`, `helper.state: "online"`, the expected host/session/OS, approved overlay hash/profile, existing roots, and tool capability evidence. `machines status` checks only Herdr; `machines check` checks both channels and independent-scout prerequisites. Project launch additionally checks the selected Git root and Treehouse.

Register the exact host Git root with `projects`, then query `models` and `usage` with that `project` before launch. For independent work, query the chosen `machine` and set the default only after readiness:

```json
{ "op": "set-default", "machine": "<profile-id>" }
```

No worker is launched by these checks. Actual visible start/control, report transfer, target-owned delivery and recovery still need the real-host acceptance in [CONTRIBUTING.md](../CONTRIBUTING.md#real-host-acceptance).

### Common remedies

| Observation                                   | User action                                                                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BatchMode host-key/authentication failure     | Compare/accept the host key interactively, install the public key with correct permissions, or load the approved key into ssh-agent; never disable checking                                                                              |
| Herdr reachable, helper unavailable           | Test ordinary BatchMode SSH independently; verify the fixed helper name in the login PATH and `helper.json` under that user                                                                                                              |
| `CONFIG_MISMATCH`                             | Restore approved overlay bytes/profile and check LF/CRLF hashes; inspect root overlap errors                                                                                                                                             |
| `PREREQUISITE_MISSING` / `CAPABILITY_MISSING` | Install/configure tools or integration manually; ensure native `herdr` is on the SSH user's noninteractive PATH (PATHEXT on Windows; no `.cmd`/`.bat`/`.ps1`); verify Git/Treehouse/OMP descriptors and Treehouse guarded-return support |
| `PROFILE_CHANGED` / `HOST_MISMATCH`           | Restore original target/session/hostId for retained workers; re-register only for future launches                                                                                                                                        |
| Offline or lost acknowledgement               | Restore connectivity and observe/reconcile original evidence; do not replay prompts, delivery, push, or allocation                                                                                                                       |

Enrollment/default changes never move retained workers. Close cannot release an offline host even with discard. Closing an unfinished scout keeps uncollectable staged evidence unless `discard: true` explicitly authorizes its loss; already collected controller reports remain untouched.

## Operations and recovery

One process handles one UTF-8 JSON Lines request using protocol `omp-orchestrator-helper`, exact version `1`. Diagnostics are stderr-only. Replies carry the request ID and persistent helper host ID. The regular frame limit is 1 MiB; report chunks are at most 64 KiB decoded, with no arbitrary total-report-size cap. Exit codes: `0` success, `1` operation failure, `2` malformed request/protocol usage.

Build and manually redeploy helpers from the matching controller checkout when upgrading. Version `1` now includes `path.validate` kind `forbidden_root`; an older helper can pass hello yet reject launches using this kind. It resolves a boundary even when the path is missing, without requiring a Git root or an approved project root. Allocation still checks that working locations do not overlap it. The launched project's own checkout continues to require its registered identity and approved-root checks.

Controller/launch/operation IDs are full UUIDs. Mutations require stable operation IDs. Their intent, request hash, resources and receipts are persisted atomically under:

```text
<runtimeRoot>/controllers/<controllerId>/ledger.json
```

This is helper-local state, not a change to the controller worker DB/project registry. Every request verifies its expected host identity. Reusing an operation ID with different arguments is refused. A confirmed repeated mutation returns its recorded result; uncertain operations are observed/reconciled, not re-executed. Git/Treehouse crashes are not exactly-once transactions.

Before valid configuration exists, error replies use the reserved error-only host identity `00000000-0000-4000-8000-000000000000`, not an invented installation ID. Only a no-effect `PREREQUISITE_MISSING` refusal may cross that unconfigured boundary. This identity is rejected by helper configuration and execution-target validators; it cannot become a saved machine binding.

Mutations use cross-platform exclusive directory locks. Controller mutations and checkpoint-writing observations serialize per host/controller ledger, including background binding and settlement. A `LOCK_BUSY` refusal before a new operation enters the ledger has `effect: none`; the controller can make a bounded safe retry. A missing operation is retired under the acquired host lock before `OPERATION_NOT_STARTED` proves no effect, preventing a delayed submission from allocating later. An operation already in the ledger retains its original effect/uncertainty; allocation, prompt, delivery and push are never blindly replayed.

A recorded mutation that fails before any effect is marked `refused` with `effect: none`, including a delivery refused by a busy project lock. After resolving the cause, a new attempt uses a fresh operation ID; the refused ID continues to return its original refusal. Once an effect may have started, a failure remains uncertain and requires reconciliation.

An interrupted helper can leave `mutation.lock` or a host-side project-delivery lock behind. Observation remains available, but missing-operation retirement and mutation cannot bypass a retained lock. Inspect the ledger and the original helper/child on that host, then manually clear the lock only after proving they have stopped. A dead SSH client is not proof that a remote child exited. No unresolved operation is expired by age. These host locks are separate from controller project registration, which does not use a persistent registry lock directory.

Allocation resets only a newly acquired, verified Treehouse lease. It checks both lease guards, the host filesystem identity, distinctness from the registered source, exact Git top-level, and the shared Git object database before reset. A lost acquisition acknowledgement is reconciled by full controller-qualified lease holder. Without a proven completed reset, it remains uncertain, even if an owned lease is found; no second acquisition/reset is attempted.

Delivery checks the owned clean worker, registered checkout identity, expected named branch, and target cleanliness. It uses ff-only delivery. A moved target triggers one rebase with durable base/rebased-head checkpoints, followed by a fresh target check. Conflict, a second target move, dirty target, branch change or uncertainty retains work. Explicit push is only to the requested origin ref without force; receipt/ledger origin identity is a SHA-256 digest, not a potentially credential-bearing URL. Lost land/push acknowledgement is reconciled from the recorded intent and branch/ref evidence, never by blind resend.

If a pushed branch later moves, cleanup checks that it still contains the worker's published commit. If the new remote commit is not present on the worker host, that proof is unavailable: cleanup is refused and work is retained. The helper does not fetch to establish it.

Reports are staged outside disposable worker directories. Export opens only the launch's exact staged file, refuses symlink/junction redirects/nonregular/empty/whitespace/invalid-UTF-8 content, checks file identity/size/time before and after streaming, and preserves LF/CRLF bytes. Helper and controller compute byte SHA-256. Consumers must publish local temporary files only after a validated end frame and successful process exit.

`report.ack` verifies the staged hash/size against a controller durable receipt. Release/forget recheck that evidence. Ordinary close cannot discard an uncollected scout report. Explicit `discard` permits removal of only that worker's scratch/staging. Cleanup requires confirmed Herdr closure plus exact lease guards, or the owned neutral directory identity. Compact helper resource/operation tombstones remain for lost-acknowledgement recovery. Controller report archives are never removed.

Explicit close may retire a partial `preflighted`/`allocating` launch when the helper proves no resource or launch operations, no topology was ever recorded or attempted, and missing controller intents have been safely retired. Any live lock, allocated resource, recorded topology or unresolved effects retain the launch.

Legacy local adoption is not a remote wire operation. Normal recovery first proves the original OMP alias/session/cwd/topology, then calls `adoptLegacyLocalRecord`. Explicit close of a failed unbound local project scout can instead supply fresh, complete evidence that no live agent remains in its recorded topology or under its alias. Its space must be absent with its tab and pane, or proven to be the same project's linked leased worktree with no replacement terminal. The close journal preserves uncertain effects without replay. This path never fabricates an agent binding or adopts a live replacement. Adoption verifies the retained lease and imports ownership without allocation/reset. It preserves old lease holders, does not invent an unknown original source SHA, and marks existing local reports archive-owned so staging cleanup cannot delete them. A never-written legacy archive may be closed without discard, but only after host-side absence and original lease guards are checked. Existing valid reports are collected in place; invalid or uncollectable reports remain protected.

## Local runtime state

Without a manual helper configuration, `createLocalHostRuntime` keeps persistent per-user state under `~/.omp/orchestrator/` (the native user's home on Windows):

- `host-id`: the generated local host identity, reused across sessions.
- `host-runtime/controllers/<controllerId>/ledger.json`: operation records used for recovery.
- `host-runtime/controllers/<controllerId>/reports/<launchId>.md`: staged local scout reports, separate from the controller's final `.omp/reports/` archive.
- `independent-workers/`: disposable independent-scout working directories.

A helper configuration at `~/.omp/orchestrator/helper.json`, or the path selected by `OMP_ORCHESTRATOR_HELPER_CONFIG`, takes precedence on the controller host too. It defines the `local` host identity, runtime and neutral roots, overlay, query directory, OMP profile, executables, and approved project roots. Nonempty approved roots restrict local registration, creation roots, and project creation just as they do on remote hosts. Without configured approved roots, local projects need not be inside a separate approved boundary.

Do not add, remove, or change this configuration while local workers are retained. A configuration added for incoming remote work also changes this user's local execution context; changing the identity or paths can prevent recovery of existing workers. Preserve the identity and runtime state across upgrades.

## Runtime entry points

- `createHostRuntime(configuration, deps, options?)`: explicit host configuration and injectable argv executor.
- `createLocalHostRuntime(deps, {cwd, neutralRoot?, runtimeRoot?, overlayPath?, ompProfile?})`: in-process local settings/identity; no installed SSH helper required. Existing manual helper identity/configuration takes precedence.
- `dispatchHostRequest(runtime, request)`: strict typed domain replies; local execution uses this same dispatcher.
- `streamHostReport(runtime, request)`: local/helper report frame generator.
- `adoptLegacyLocalRecord(runtime, record, verifiedTarget, verifiedBinding)`: local-only migration adoption after routing evidence.
- `callHelper(target, request, transportOptions?)`: noninteractive SSH request, validated typed result or `HostFailure.detail`.
- `readReportStream(target, request, consumeFrame, transportOptions?)`: incremental controller validation/export callback; returns a verified end frame only after successful exit.
- `reconcileOperation(runtime, controllerId, operationId)`: helper-side read-only resource/receipt reconciliation, no execution replay. Reconciliation persists evidence only while the controller ledger lock is acquired.
- `canonicalPath`, `pathIdentity`, `assertContained`: host-native path/identity/containment contracts.

`callHelper` accepts a target with SSH kind/target and host identity, so initial `hello` can run before the full execution snapshot exists. `HelperTransport` accepts `spawnStdio`, cancellation, deadline and the controller's operation-ID-to-original-op map. The map is required when validating lookup results containing completed operation views. Transport never retries automatically. Controller intents may retry only a typed pre-ledger `LOCK_BUSY` no-effect refusal; uncertain effects require reconciliation, not mutation replay.

SSH helper requests default to a two-minute deadline. Allocation, project creation, landing, pushing, and worker release have ten minutes; a caller can override the deadline or cancel. A timed-out mutation may still have taken effect, so its recorded outcome must be reconciled before any new action.

## Verification boundary

Recorded Linux-local proof exercised a compiled native helper over a real stdio subprocess, native Git/Treehouse/OMP preflight, exact-source allocation, moved-target rebase/ff-only delivery, guarded release and streamed Unicode/CRLF report checksums. Behavior tests cover lost acknowledgements, target-bound supervision/settlement, dirty/conflicting work, report/session ownership, and Windows path rules through a filesystem seam.

Native Windows remote proof on `winbox` from a WSL controller exercised a Linux-cross-built Windows helper hello (`os: win32`, persistent hostId), both-channel readiness, and a simultaneous project scout/implementation batch using `openai-codex/gpt-6-luna`. Both settled without lock-related uncertainty: the scout completed with a byte-verified archive, provenance sidecar and host acknowledgement; implementation delivery advanced only the Windows checkout. Guarded cleanup released both leases and closed worker spaces; the disposable project/pool and parent space were removed. The earlier Windows run also exercised held moved-target delivery and helper-only outage recovery, but exposed the build/lock/partial-close regressions corrected here.

Native Windows controller, native macOS and Linux-SSH remote runs remain unexercised. The remaining failure/recovery scenarios in CONTRIBUTING.md still need their separate real-host proof; this Windows run is not an unconditional platform acceptance claim.

Known external limitation: OMP 18.4.4 background Wait on this Windows mise installation tries to re-execute its extensionless installed `omp` path and reports `Executable not found in $PATH`. Native `.exe` shim launch and helper queries work. This is an OMP/mise runtime limitation observed on winbox, not fixed by these Orchestrator changes.
