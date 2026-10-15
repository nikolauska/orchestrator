import { fileURLToPath } from "node:url";
import { execCommand, parseJson, stringAt, valueAt, type RuntimeDeps } from "./shared";
import { duration, type UsageWindow } from "./omp";

// The pinned package's own entry, run with bun: the .bin shim is a .cmd file on Windows, which
// argv-only execution refuses, and a global install could be a different, untested version.
const QUOTA_AXI = fileURLToPath(
  new URL("../../node_modules/quota-axi/dist/bin/quota-axi.js", import.meta.url),
);

/** Aliases `claude --model` documents for the latest models; full names are accepted too. */
export const CLAUDE_CODE_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

export type ClaudeCodeUsage =
  | {
      plan?: string;
      state: string;
      windows: Array<UsageWindow & { pace?: string }>;
      effective_remaining_percent?: number;
      runway?: { status: string; exhausted_at?: string; limiting_window?: string };
    }
  | { error: string }
  | { unavailable: string };

// quota-axi reports reset times but not window lengths; these are Claude's fixed windows.
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
  seven_day_opus: 7 * 86_400_000,
  seven_day_sonnet: 7 * 86_400_000,
};

/**
 * Claude Code workers spend from Claude Code's own sign-in, which OMP's credential store does not
 * see. quota-axi reads it without this code ever handling the token. Credential refresh is off so
 * a read-only query never rewrites Claude Code's credentials file.
 */
export async function claudeCodeUsage(
  deps: RuntimeDeps,
  now: number,
  signal?: AbortSignal,
): Promise<ClaudeCodeUsage> {
  let output: string;
  try {
    output = await execCommand(
      deps,
      "bun",
      [QUOTA_AXI, "--provider", "claude", "--json", "--no-credential-refresh"],
      { signal, timeout: 30_000 },
    );
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Claude Code usage could not run quota-axi: ${message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseJson(output, "quota-axi");
  } catch (error) {
    return { error: (error as Error).message };
  }
  const providers = valueAt(parsed, ["providers"]);
  const claude = Array.isArray(providers)
    ? providers.find((item) => stringAt(item, ["provider"]) === "claude")
    : undefined;
  if (!claude || valueAt(claude, ["notSetUp"]) === true)
    return { error: "Claude Code is not signed in on this machine" };

  const rawWindows = valueAt(claude, ["windows"]);
  const windows = (Array.isArray(rawWindows) ? rawWindows : []).flatMap((item) => {
    const id = stringAt(item, ["id"]);
    if (!id) return [];
    const remaining = valueAt(item, ["percentRemaining"]);
    const resets = Date.parse(stringAt(item, ["resetsAt"]) ?? "");
    const length = WINDOW_MS[id];
    const elapsed =
      length && !Number.isNaN(resets)
        ? Math.min(1, Math.max(0, 1 - (resets - now) / length))
        : undefined;
    const pace = stringAt(item, ["pace", "status"]);
    return [
      {
        window: id,
        ...(typeof remaining === "number" ? { remaining_percent: Math.round(remaining) } : {}),
        ...(elapsed !== undefined ? { window_elapsed_percent: Math.round(elapsed * 100) } : {}),
        ...(!Number.isNaN(resets)
          ? { resets_at: new Date(resets).toISOString(), resets_in: duration(resets - now) }
          : {}),
        ...(pace ? { pace } : {}),
      },
    ];
  });
  const state = stringAt(claude, ["state", "status"]) ?? "unknown";
  if (!windows.length) {
    const reason = stringAt(claude, ["state", "reason"]) ?? stringAt(claude, ["error"]);
    return {
      error: `quota-axi reported no Claude usage windows (state ${state}${reason ? `: ${reason}` : ""})`,
    };
  }
  const available = valueAt(claude, ["quotaSemantics", "effectiveAvailability"]);
  const overall = Array.isArray(available)
    ? (available.find((item) => stringAt(item, ["scope"]) === "all_models") ?? available[0])
    : undefined;
  const effective = valueAt(overall, ["effectivePercentRemaining"]);
  const runwayStatus = stringAt(overall, ["runway", "status"]);
  const exhaustedAt = stringAt(overall, ["runway", "projectedExhaustedAt"]);
  const limiting = stringAt(overall, ["runway", "limitingWindowId"]);
  const plan = stringAt(claude, ["plan"]);
  return {
    ...(plan ? { plan } : {}),
    state,
    windows,
    ...(typeof effective === "number" ? { effective_remaining_percent: effective } : {}),
    ...(runwayStatus
      ? {
          runway: {
            status: runwayStatus,
            ...(exhaustedAt ? { exhausted_at: exhaustedAt } : {}),
            ...(limiting ? { limiting_window: limiting } : {}),
          },
        }
      : {}),
  };
}
