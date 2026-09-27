import { usageSummary } from "../../runtime/omp";
import { errorMessage, text, type ToolFactory } from "../../runtime/shared";

const usageTool: ToolFactory = (pi) => {
  const z = pi.zod;

  return {
    name: "usage",
    label: "Usage",
    loadMode: "essential",
    approval: "read",
    description:
      "Report provider usage limits for every account OMP workers can spend: percent remaining per window, how much of each window has elapsed, reset times, accounts per provider, and which OMP model roles resolve to each provider. Data only; it never selects a model.",
    parameters: z.object({}).strict(),
    execute: async (_id, _params, signal?: AbortSignal) => {
      try {
        const summary = await usageSummary(pi, pi.cwd, Date.now(), signal);
        return text(`Usage:\n${JSON.stringify(summary, null, 2)}`, summary);
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default usageTool;
