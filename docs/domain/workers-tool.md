# Workers tool

The Workers tool supervises visible workers started by the Task tool.

## Operations

| `op`        | Arguments besides `op`                                         |
| ----------- | -------------------------------------------------------------- |
| `list`      | Optional `machine` saved-ID filter; omitted lists all machines |
| `read`      | `names`, optional `lines` (1–200; default 40)                  |
| `send`      | `names`, nonempty `message`                                    |
| `interrupt` | `names`                                                        |
| `relaunch`  | `names`, nonempty recovery `note`                              |
| `land`      | `names`                                                        |
| `close`     | `names`, optional `discard` (default false)                    |

`names` must be a nonempty list without duplicates. Only `list` accepts a machine selector; every other operation finds each named worker's recorded host. Worktree and working-directory paths belong to that host, not the controller filesystem.

## Active workers

The tool lists retained workers with their machine, bound session and host OS, lifecycle status, launch phase, connection health, and last successful contact with each channel. A worker may be starting, working, blocked, interrupted, ready for review, or failed. `status_changed_at` tracks lifecycle changes; `updated_at` also changes when connection health or recovery evidence is saved.

`list` accepts an optional `machine` filter. It matches the saved machine ID, including IDs whose Herdr profile has been removed. Omitting it lists all retained workers, not only local workers. Listing does not resolve labels or move workers to the current independent default. A supervising session can also resume read-only observation; offline records remain visible.

`read` returns `{name,status,machine,session,connection,screen?,screen_error?,observed_at?}` for each named worker. A successful read includes fresh screen text and its observation time. An unavailable screen has a structured `screen_error`, not an error message disguised as screen text.

Workers are recorded durably, so they survive an OMP restart. The next supervising session reconnects to the original host and session. Partial launches resume from what the original host can prove was created; they never allocate again or replay a prompt. Startup idle alone does not prove the assignment finished. Migrated local workers keep their original Herdr agent and worktree, and an unknown original source SHA remains unknown.

## Machine binding and connections

Every read, message, interruption and relaunch uses the worker's saved target. Changing project registrations or the independent default does not redirect retained workers. A changed or disabled profile, missing profile, helper identity mismatch, SSH authentication failure or host-key failure is reported in connection health with an actionable error. Restore the original binding; workers cannot be moved to a replacement host.

Herdr terminal access and helper access are separate channels. Full management requires both, but an available Herdr channel still permits fresh screens when the helper is offline. Read-only reconnect uses bounded backoff, independently for each target. An offline host does not stop healthy hosts from being supervised.

Connection failures do not mark a worker dead or reset its lifecycle clock. A missing-agent response from the original server or a verified replacement agent marks the worker failed and retains its resources. Before input or closure, Orchestrator verifies that the terminal still belongs to the original worker; a terminal reused by someone else is never messaged or closed.

Temporary helper or Herdr outages during report collection or delivery, including an explicit land request, retain the worker without marking the assignment failed. Supervision resumes when access returns and checks any uncertain outcome before continuing.

## One supervising session

Only one OMP session supervises the workers at a time. Another session opened on the same Orchestrator can list workers and read their screens, but cannot launch, message, interrupt, relaunch, land, or close them. When the supervising session exits, the next session that uses a worker tool takes over.

## Questions and notices

When a worker stops to ask a question, the notification includes its screen, so the question can be answered without switching tabs. Supervision continues while it waits: an answer sent through the tool or typed directly in the worker's tab lets it finish and deliver normally.

A working worker produces two informational notices, each at most once per turn: when fresh successful screens have stayed unchanged for 4 minutes, and when a single turn has run for over an hour. Unavailable screens never count as stalled progress. Reconnect starts a fresh screen-stall baseline without restarting the turn clock. A long-turn notice includes the observation gap and may have `screen_error` instead of a screen. Neither notice stops the worker.

## Sending corrections

The tool sends a message only to named workers. It is intended for requirement changes, answers, corrections, and targeted guidance while a worker remains active.

A message is rejected when a named worker is unknown, duplicated, or invalid. This prevents a correction from being silently sent to the wrong worker.

After a new message, an earlier completed turn does not count as completion of the new request, even if the terminal still looks idle or the send response is lost.

## Interrupting and relaunching

Interrupting a running worker stops its current turn without closing it. An interrupted worker is not delivered, even after a restart; sending it a message resumes the work.

Relaunching starts a fresh agent in the same host, session, worktree or working directory, with its original assignment and a recovery note you provide. Existing changes and commits, report destination, and the exact initial model and thinking level are kept. Supervision then follows the new terminal. If ownership, connection or the outcome of an earlier action is uncertain, the worker and its working location stay recorded instead of blindly repeating the action.

## Holding for review

An implementation started with hold stops changed work at **ready** instead of delivering, and reports its host-local commit, delivery base and working location for review. Review the diff on that host; Orchestrator does not import its Git objects to the controller. Landing uses the original machine and delivery destination. It refuses an active, blocked or replacement agent and a dirty or unowned checkout. Sending a message asks for more changes; it returns to ready when done. An implementation with no changes can settle as `no_changes` without a held diff.

## Closing workers

The tool closes named workers on request: it stops the agent, closes a project worker's worktree space or an independent scout's tab, and releases its worktree or disposable working directory. The project's own space and the shared `research` space stay open.

A partial launch that never acquired a working location or opened a terminal can be explicitly closed when fresh host evidence proves it has no resource or unfinished operation. Any uncertain allocation or terminal creation stays recorded until its original outcome can be proven. This close path removes only the inert worker record; it does not delete unrelated files or spaces.

A partial launch that acquired a working location but never opened a terminal can also be closed once ownership is confirmed. The usual protections for uncommitted changes, undelivered commits, and scout reports still apply; uncertain terminal creation keeps the worker recorded.

Closing an implementation worker without discard checks for uncommitted or undelivered work both before and after stopping its owned agent. The refusal names what would be lost. If new work is discovered after stopping the agent, the checkout remains available for recovery and later delivery rather than being treated as closed. `discard: true` authorizes discarding only this worker's scratch or unlanded work.

An unfinished scout may be stopped, but any valid staged report must be collected before releasing its working location—even with discard. Missing, invalid, changed or uncollectable staging remains recorded unless discard was explicitly authorized. Archive destination conflicts never overwrite existing reports or metadata. Discard never removes the controller archive or unrelated paths.

An offline host cannot be closed or released, even with discard. The record keeps its machine and working location so the original binding can be restored.

A failed migrated local project scout that never recorded its agent can be explicitly closed when fresh, complete observations prove that none of its agents remains alive in its original space or under its original name, and that its space is either gone or still holds only its own terminal with no agent running. Closure never adopts a live or replacement agent, and its worktree is returned only to its original owner. A never-written archive has nothing to discard and does not require `discard: true`; an existing valid report is collected in place first. Invalid or uncollectable evidence is retained without explicit discard. Live or recycled agents, replacement spaces or terminals, incomplete observations, changed worktree ownership and offline servers refuse cleanup. Lost close acknowledgements are observed, not replayed.

## Completion and recovery

A successful implementation is reported as `merged`, `pushed`, or `no_changes`, with a durable delivery receipt and resulting SHA/base. Default delivery advances only the project's registered checkout on its own machine: clean checkout, expected named branch and fast-forward only. A moved target permits one worker rebase; a dirty target, branch switch, second move or conflict retains the work. `pushTo` publishes explicitly from the worker checkout on that host, without force. No Git objects or implementation files are copied to the controller.

A successful scout is reported as **Completed with report** only after its regular, nonempty UTF-8 staged report has been collected and verified on the controller, its provenance sidecar has been published, and the host has acknowledged the durable collection receipt. Identical retries succeed; differing local report bytes or metadata are retained as a destination conflict. Legacy local reports already at their final archive path are validated in place, not deleted as staging.

Workers and their working locations are retained when work is blocked, interrupted, held for review, fails, has uncommitted implementation changes, encounters a delivery conflict, cannot settle a scout report, or cannot be cleaned up safely. This preserves evidence and unfinished work for recovery instead of discarding it. When a worker finishes successfully, its own worktree space or tab closes; the parent space stays open.

Confirmed delivery and report collection remain recorded even if cleanup stops partway through. If a response is lost, Orchestrator checks what happened before continuing; it never blindly repeats delivery, publication, or cleanup.

Partial cleanup reports `cleanup_pending` alongside the successful delivery or collection result and retained location. Restart or an explicit close continues the remaining cleanup without delivering or pushing again. A settled assignment awaiting cleanup cannot be sent another prompt or relaunched. If a published branch later moves, cleanup still requires proof that the worker's changes were published; otherwise the worker is retained. Parent project and shared research spaces remain open.
