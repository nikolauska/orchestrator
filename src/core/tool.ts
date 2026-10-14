// Harness-neutral tool contract. Tools depend only on these types; each harness adapter
// (src/adapters/*) maps them onto its own tool registration and session-wake mechanism.
import type * as zod from "@oh-my-pi/omptype/zod";

/**
 * Schema builder the harness injects. OMP's extension loader resolves packages from this
 * repository's node_modules, so tool parameters must be built with the harness's own instance.
 */
export type Zod = typeof zod;
export type Schema = zod.ZodLikeSchema<unknown>;

export type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export type Logger = { warn?(message: string, context?: Record<string, unknown>): void };

export type ToolOutcome = {
  content: { type: "text"; text: string }[];
  details?: unknown;
  isError?: true;
};

export type SessionReason = "start" | "switch" | "branch" | "tree" | "shutdown";

export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  approval: "read" | "write" | "exec";
  /** Opt out of strict structured output, which would mark every optional property required. */
  strict?: false;
  parameters: Schema;
  execute(params: any, signal?: AbortSignal): Promise<ToolOutcome>;
  onSession?(reason: SessionReason): void;
};

export type HarnessServices = {
  exec: Exec;
  logger: Logger;
  /**
   * Delivers a supervision message and wakes the root session for a new turn. Returning (or
   * resolving) means the harness accepted it; throwing (or rejecting) leaves the event pending.
   */
  notify(message: string): void | Promise<void>;
};
