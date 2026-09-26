# Workers tool

The Workers tool supervises visible workers started by the Task tool.

## Active workers

The tool lists active retained workers and their current status. A worker may be working, blocked, or failed.

Workers are recorded durably, so they survive an OMP restart. When a new session starts, Orchestrator reconnects to workers that are still running and finishes delivery for any that completed in the meantime. A worker whose agent is gone is reported as failed and kept for recovery.

Use it to identify the correct worker before changing an assignment.

## Sending corrections

The tool sends a message only to named workers. It is intended for requirement changes, corrections, and targeted guidance while a worker remains active.

A message is rejected when a named worker is unknown, duplicated, or invalid. This prevents a correction from being silently sent to the wrong worker.

## Closing workers

The tool closes named workers on request: it stops the agent, closes a project worker's worktree space or an independent scout's tab, and releases its worktree or disposable working directory. The project's own space and the shared `research` space stay open.

Closing an implementation worker is refused when it has uncommitted changes or commits that were not delivered, and the refusal names what would be lost. Closing it anyway requires an explicit request to discard that work. Scout working locations are disposable, and their reports are kept.

## Completion and recovery

A successful implementation is reported as merged locally, pushed to a requested remote branch, or completed with no changes.

A successful scout is reported as **Completed with report**. Its durable report remains available after completion.

Workers and their working locations are retained when work is blocked, fails, has uncommitted implementation changes, encounters a delivery conflict, cannot settle a scout report, or cannot be cleaned up safely. This preserves evidence and unfinished work for recovery instead of discarding it. When a worker finishes successfully, its own worktree space or tab closes; the parent space stays open.
