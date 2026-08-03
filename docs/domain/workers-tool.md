# Workers tool

The Workers tool supervises visible workers started by the Task tool.

## Active workers

The tool lists active retained workers and their current status. A worker may be working, blocked, or failed.

Use it to identify the correct worker before changing an assignment.

## Sending corrections

The tool sends a message only to named workers. It is intended for requirement changes, corrections, and targeted guidance while a worker remains active.

A message is rejected when a named worker is unknown, duplicated, or invalid. This prevents a correction from being silently sent to the wrong worker.

## Completion and recovery

A successful implementation is reported as merged locally, pushed to a requested remote branch, or completed with no changes.

A successful scout is reported as **Completed with report**. Its durable report remains available after completion.

Workers and their working locations are retained when work is blocked, fails, has uncommitted implementation changes, encounters a delivery conflict, cannot settle a scout report, or cannot be cleaned up safely. This preserves evidence and unfinished work for recovery instead of discarding it.
