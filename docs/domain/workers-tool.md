# Workers tool

The Workers tool supervises visible workers started by the Task tool.

## Active workers

The tool lists retained workers with their status and when they started and last changed status. A worker may be working, blocked, interrupted, ready for review, or failed.

It can also show the last lines of named workers' screens, so you can see what a worker is doing without switching to its tab.

Workers are recorded durably, so they survive an OMP restart. When a new session starts, Orchestrator reconnects to workers that are still running and finishes delivery for any that completed in the meantime. A worker whose agent is gone is reported as failed and kept for recovery.

## One supervising session

Only one OMP session supervises the workers at a time. Another session opened on the same Orchestrator can list workers and read their screens, but cannot launch, message, interrupt, relaunch, land, or close them. When the supervising session exits, the next session that uses a worker tool takes over.

## Questions and notices

When a worker stops to ask a question, the notification includes its screen, so the question can be answered without switching tabs. Supervision continues while it waits: an answer sent through the tool or typed directly in the worker's tab lets it finish and deliver normally.

A working worker also produces two informational notices, each at most once per turn: when its screen has not changed for 4 minutes, and when a single turn has run for over an hour. They include the screen and never stop the worker.

## Sending corrections

The tool sends a message only to named workers. It is intended for requirement changes, answers, corrections, and targeted guidance while a worker remains active.

A message is rejected when a named worker is unknown, duplicated, or invalid. This prevents a correction from being silently sent to the wrong worker.

## Interrupting and relaunching

Interrupting a running worker stops its current turn without closing it. An interrupted worker is not delivered, even after a restart; sending it a message resumes the work.

Relaunching starts a fresh agent for a dead or stuck worker in the same worktree or working directory, with its original assignment and a recovery note you provide. Existing changes and commits are kept.

## Holding for review

An implementation started with hold stops at **ready** instead of delivering, and reports its commit and starting point so the change can be reviewed. Landing it delivers it the usual way. Sending it a message asks for more changes; it returns to ready when done.

## Closing workers

The tool closes named workers on request: it stops the agent, closes a project worker's worktree space or an independent scout's tab, and releases its worktree or disposable working directory. The project's own space and the shared `research` space stay open.

Closing an implementation worker is refused when it has uncommitted changes or commits that were not delivered, and the refusal names what would be lost. Closing it anyway requires an explicit request to discard that work. Scout working locations are disposable, and their reports are kept.

## Completion and recovery

A successful implementation is reported as merged locally, pushed to a requested remote branch, or completed with no changes. A push that also asked for a pull request (GitHub) or merge request (GitLab) reports the draft request's link, or why it could not be opened; the branch is pushed either way.

A successful scout is reported as **Completed with report**. Its durable report remains available after completion.

Workers and their working locations are retained when work is blocked, interrupted, held for review, fails, has uncommitted implementation changes, encounters a delivery conflict, cannot settle a scout report, or cannot be cleaned up safely. This preserves evidence and unfinished work for recovery instead of discarding it. When a worker finishes successfully, its own worktree space or tab closes; the parent space stays open.
