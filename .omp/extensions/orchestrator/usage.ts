import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
  selectOmpContext,
  selectedUsage,
  type OmpQueryAPI,
  type OmpSelector,
} from "../../runtime/omp";
import { errorMessage, text } from "../../runtime/shared";

const usageTool = (pi: OmpQueryAPI): ToolDefinition<any, any> => {
  const z = pi.zod;

  return {
    name: "usage",
    label: "Usage",
    loadMode: "essential",
    approval: "read",
    description:
      "Report provider usage limits for accounts OMP workers on one selected machine can spend: percent remaining, elapsed windows, resets, accounts, and OMP roles. Optional machine or project selects the host/configuration context; neither means local. Never sums hosts or selects a model.",
    parameters: z
      .object({
        machine: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (params) => params.machine === undefined || params.project === undefined,
        "machine and project are mutually exclusive",
      ),
    execute: async (_id: string, params: OmpSelector, signal?: AbortSignal) => {
      try {
        const selected = await selectOmpContext(pi, params, signal);
        const { context, ...summary } = await selectedUsage(pi, selected, Date.now(), signal);
        const details = {
          ...summary,
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
