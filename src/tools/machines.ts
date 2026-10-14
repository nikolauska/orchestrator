import {
  checkMachine,
  listMachines,
  machineError,
  selectMachine,
  statusMachine,
  validateBinding,
  type Machine,
} from "../runtime/machines";
import { readProjectRegistry } from "../runtime/project-registry";
import { errorMessage, text, type ToolFactory } from "../runtime/shared";
import type { MachineBinding } from "../runtime/execution";
import { requireOwnership, stateFor } from "./workers";

const machinesTool: ToolFactory = (pi) => {
  const z = pi.zod;
  const parameters = z.union([
    z.object({ op: z.literal("list") }).strict(),
    z.object({ op: z.literal("status"), machine: z.string().optional() }).strict(),
    z.object({ op: z.literal("check"), machine: z.string().min(1) }).strict(),
    z.object({ op: z.literal("set-default"), machine: z.string().min(1) }).strict(),
  ]);
  return {
    name: "machines",
    label: "Machines",
    approval: "write",
    description:
      "Discover saved Herdr machines, check reachability and manually provisioned prerequisites, or set the default for future independent scouts. Never enrolls, installs, reconnects, or moves retained workers.",
    parameters,
    execute: async (input, signal) => {
      try {
        const params = parameters.parse(input);
        const state = stateFor(pi);
        if (params.op === "list") {
          const machines = await listMachines(pi, signal);
          const profiles = [...machines];
          const issues: { machine: string; source: string; error: unknown }[] = [];
          const bindings: { binding: MachineBinding; source: string }[] = [];
          const read = await readProjectRegistry(pi.cwd, signal);
          const registry = read.registry;
          for (const [name, entry] of Object.entries(registry.projects))
            if (entry.binding)
              bindings.push({
                binding: { machineId: entry.machine, ...entry.binding },
                source: `project:${name}`,
              });
          for (const [machineId, entry] of Object.entries(registry.roots))
            if (entry.binding)
              bindings.push({
                binding: { machineId, ...entry.binding },
                source: `root:${machineId}`,
              });
          const independent = state.store.independentTarget;
          if ("hostId" in independent)
            bindings.push({ binding: independent, source: "independent_default" });
          for (const worker of state.store.all()) {
            if (worker.target?.kind === "ssh")
              bindings.push({ binding: worker.target, source: `worker:${worker.name}` });
          }
          for (const { binding, source } of bindings) {
            try {
              validateBinding(selectMachine(profiles, binding.machineId), binding);
            } catch (error) {
              issues.push({
                machine: binding.machineId,
                source,
                error: machineError(error, "controller"),
              });
              if (!machines.some((machine) => machine.machineId === binding.machineId))
                machines.push({
                  machineId: binding.machineId,
                  label: binding.machineId,
                  enabled: false,
                  sshTarget: binding.sshTarget,
                  session: binding.session,
                });
            }
          }
          const details = {
            machines,
            independent_default: independent,
            issues,
            ...(read.issues.length ? { registry_issues: read.issues } : {}),
          };
          return text(
            `Machines (saved metadata, not a connectivity check):\n${JSON.stringify(details, null, 2)}`,
            details,
          );
        }
        if (params.op === "status") {
          const machines = await listMachines(pi, signal);
          const selected: Machine[] = params.machine
            ? [selectMachine(machines, params.machine)]
            : machines;
          const details = await Promise.all(
            selected.map(async (machine) => ({
              machine,
              herdr: await statusMachine(pi, machine, signal),
            })),
          );
          return text(`Herdr reachability:\n${JSON.stringify(details, null, 2)}`, details);
        }
        if (params.op === "set-default") requireOwnership(state);
        const saved = state.store.independentTarget;
        const machine = selectMachine(await listMachines(pi, signal), params.machine);
        const check = await checkMachine(pi, machine.machineId, {
          controllerId: state.store.controllerId,
          signal,
          ...(saved.machineId === machine.machineId && "hostId" in saved ? { binding: saved } : {}),
        });
        if (params.op === "check")
          return text(
            `Machine prerequisites:\n${JSON.stringify(check, null, 2)}`,
            check,
            !check.ready,
          );
        if (!check.ready || !check.target)
          return text(
            `Independent default unchanged:\n${JSON.stringify(check, null, 2)}`,
            check,
            true,
          );
        requireOwnership(state);
        const target = check.target;
        if (target.kind === "ssh")
          validateBinding(
            selectMachine(await listMachines(pi, signal), target.machineId),
            target,
            target.hostId,
          );
        state.store.setIndependentTarget(
          target.kind === "local"
            ? { machineId: "local" }
            : {
                machineId: target.machineId,
                sshTarget: target.sshTarget,
                session: target.session,
                hostId: target.hostId,
              },
        );
        const details = { independent_default: state.store.independentTarget, check };
        return text(`Default for future independent scouts: ${target.machineId}`, details);
      } catch (error) {
        return text(errorMessage(error), { error: machineError(error, "controller") }, true);
      }
    },
  };
};
export default machinesTool;
