import type { ToolSpec } from "../core/tool";
import {
  selectOmpContext,
  selectedUsage,
  type OmpQueryAPI,
  type OmpSelector,
} from "../runtime/omp";
import { claudeCodeUsage, codexUsage, type CliUsage } from "../runtime/claude";
import { isAbsolute } from "node:path";
import { errorMessage, text } from "../runtime/shared";

const usageTool = (pi: OmpQueryAPI): ToolSpec => {
  const z = pi.zod;

  return {
    name: "usage",
    label: "Usage",
    approval: "read",
    // Opt out of strict structured output: OpenAI-compatible strict mode marks every
    // property required, which would force the optional machine/project selectors.
    strict: false,
    description:
      "Report provider usage limits for accounts OMP workers on one selected machine can spend: percent remaining, elapsed windows, resets, accounts, and OMP roles. claude_code reports the local Claude Code sign-in that Claude Code workers spend from, and codex_cli the local Codex CLI sign-in Codex workers spend from (local machine only); codexHome reads codex_cli from that absolute CODEX_HOME, such as a separate work account. Optional machine or project selects the host/configuration context; neither means local. Never sums hosts or selects a model.",
    parameters: z
      .object({
        machine: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        codexHome: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (params) => params.machine === undefined || params.project === undefined,
        "machine and project are mutually exclusive",
      ),
    execute: async (params: OmpSelector & { codexHome?: string }, signal?: AbortSignal) => {
      try {
        const { codexHome, ...selector } = params;
        if (codexHome !== undefined && !isAbsolute(codexHome))
          throw new Error(`codexHome must be an absolute path: ${codexHome}`);
        const selected = await selectOmpContext(pi, selector, signal);
        const now = Date.now();
        // Claude Code and Codex workers run only on the local machine, so a remote host has no
        // such account to report; showing the controller's would misstate that host's quota.
        const local = selected.machine === "local";
        const claude: Promise<CliUsage> = local
          ? claudeCodeUsage(pi, now, signal)
          : Promise.resolve({ unavailable: "Claude Code workers run only on the local machine" });
        const codex: Promise<CliUsage> = local
          ? codexUsage(pi, now, signal, codexHome)
          : Promise.resolve({ unavailable: "Codex workers run only on the local machine" });
        const [{ context, ...summary }, claude_code, codex_cli] = await Promise.all([
          selectedUsage(pi, selected, now, signal),
          claude,
          codex,
        ]);
        const details = {
          ...summary,
          claude_code,
          codex_cli: codexHome ? { codex_home: codexHome, ...codex_cli } : codex_cli,
          machine: selected.machine,
          session: selected.session,
          os: selected.os,
          configuration_context: context,
          observed_at: new Date().toISOString(),
        };
        return text(`Usage:\n${JSON.stringify(details, null, 2)}`, details);
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default usageTool;
