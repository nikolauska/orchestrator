import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  configurationContextSchema,
  type ConfigurationContext,
  type ExecutionTarget,
} from "./execution";
import { PROTOCOL, type HostRequest, type HostResult } from "./helper-protocol";
import { readProjectRegistry } from "./project-registry";
import { callHelper } from "./remote";
import { HostFailure } from "./host-paths";
import { dispatchHostRequest, type HostRuntime } from "./host";
import type { ToolAPI } from "./shared";
import { execCommand, parseJson, stringAt, valueAt, type RuntimeDeps } from "./shared";

export type ModelChoice = { model: string; thinking?: string };

export type CatalogModel = {
  selector: string;
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinking: string[];
  input: string[];
  /** USD per million tokens, as OMP reports it. */
  cost?: { input: number; output: number };
};

export type OmpSelector = { machine?: string; project?: string };
// Query identity is not launch readiness: a local catalog has no bound terminal session.
export type OmpQueryTarget = Pick<
  ExecutionTarget,
  "hostId" | "os" | "workerConfig" | "ompProfile"
> &
  (
    | { kind: "local"; machineId: "local"; session: string | null }
    | { kind: "ssh"; machineId: string; sshTarget: string; session: string }
  );
export type ResolvedOmpContext = {
  target: OmpQueryTarget;
  context: ConfigurationContext;
  controllerId: string;
  runtime?: HostRuntime;
};
/** S4 resolves fresh machine bindings and the host's configured query cwd, never a local guess. */
export type OmpContextResolver = (
  machine: string,
  signal?: AbortSignal,
) => Promise<ResolvedOmpContext>;
export type OmpQueryAPI = ToolAPI & { resolveOmpContext?: OmpContextResolver };
export type SelectedOmpContext = {
  machine: string;
  session: string | null;
  os: ExecutionTarget["os"];
  configuration_context: ConfigurationContext;
  resolved: ResolvedOmpContext;
};
export type OmpModelsSnapshot = {
  context: ConfigurationContext;
  catalog: Map<string, CatalogModel>;
  roles: Record<string, string>;
};
export type RequestedWorkerChoice = { role?: string; model?: string };

export function validateOmpSelector(selector: OmpSelector): void {
  if (selector.machine !== undefined && selector.project !== undefined)
    throw new Error("machine and project are mutually exclusive");
  for (const value of [selector.machine, selector.project])
    if (value !== undefined && (!value.trim() || value.includes("\0")))
      throw new Error("machine and project selectors must be nonempty");
}

export async function selectOmpContext(
  pi: OmpQueryAPI,
  selector: OmpSelector,
  signal?: AbortSignal,
): Promise<SelectedOmpContext> {
  validateOmpSelector(selector);
  signal?.throwIfAborted();
  const projects =
    selector.project === undefined
      ? undefined
      : (await readProjectRegistry(pi.cwd, signal)).registry.projects;
  const project =
    projects && selector.project !== undefined && Object.hasOwn(projects, selector.project)
      ? projects[selector.project]
      : undefined;
  if (selector.project !== undefined && !project)
    throw new Error(`Unknown project: ${selector.project}`);
  const machine = project?.machine ?? selector.machine ?? "local";
  if (!pi.resolveOmpContext) throw new Error("OMP queries require the machine context resolver");
  const resolved = await pi.resolveOmpContext(machine, signal);
  const target = resolved.target;
  if (machine === "local" && target.kind !== "local")
    throw new Error("Local OMP queries cannot use a remote target");
  if (machine !== "local" && target.kind !== "ssh")
    throw new Error("Remote OMP queries cannot fall back to the controller");
  if (
    project &&
    (target.machineId !== project.machine ||
      (project.binding &&
        (target.kind !== "ssh" ||
          target.sshTarget !== project.binding.sshTarget ||
          target.session !== project.binding.session ||
          target.hostId !== project.binding.hostId)))
  )
    throw new Error(
      "Project machine binding changed; restore it or re-register for future launches",
    );
  const context = configurationContextSchema.parse({
    ...resolved.context,
    ...(project ? { cwd: project.path } : {}),
  });
  if (
    context.overlayPath !== target.workerConfig.path ||
    context.overlaySha256 !== target.workerConfig.sha256 ||
    context.ompProfile !== target.ompProfile
  )
    throw new Error("OMP query context differs from the resolved machine overlay/profile");
  return {
    machine: target.machineId,
    session: target.session,
    os: target.os,
    configuration_context: context,
    resolved: { ...resolved, context },
  };
}

function queryArguments(command: string[], context: string | ConfigurationContext): string[] {
  return typeof context === "string"
    ? command
    : [
        ...(context.ompProfile ? ["--profile", context.ompProfile] : []),
        `--config=${context.overlayPath}`,
        ...command,
      ];
}
function queryCwd(context: string | ConfigurationContext): string {
  return typeof context === "string" ? context : context.cwd;
}

async function verifyContext(context: string | ConfigurationContext): Promise<void> {
  if (typeof context === "string") return;
  configurationContextSchema.parse(context);
  const digest = createHash("sha256")
    .update(await readFile(context.overlayPath))
    .digest("hex");
  if (digest !== context.overlaySha256)
    throw new Error("Worker overlay hash changed; restore the approved bytes (including LF/CRLF)");
}

export async function selectedModels(
  pi: OmpQueryAPI,
  selected: SelectedOmpContext,
  signal?: AbortSignal,
): Promise<OmpModelsSnapshot> {
  const resolved = selected.resolved;
  const request: HostRequest<"omp.models"> = {
    protocol: PROTOCOL,
    version: 1,
    requestId: crypto.randomUUID(),
    controllerId: resolved.controllerId,
    expectedHostId: resolved.target.hostId,
    op: "omp.models",
    args: { context: selected.configuration_context },
  };
  let result: HostResult<"omp.models">;
  if (resolved.target.kind === "ssh") {
    result = await callHelper(resolved.target, request, { spawnStdio: pi.spawnStdio, signal });
  } else {
    signal?.throwIfAborted();
    const reply = await dispatchHostRequest(resolved.runtime!, request);
    if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
    result = reply.result;
  }
  return {
    context: result.context,
    catalog: new Map(result.catalog.map((entry) => [entry.selector, entry])),
    roles: result.roles,
  };
}

export async function selectedUsage(
  pi: OmpQueryAPI,
  selected: SelectedOmpContext,
  now: number,
  signal?: AbortSignal,
): Promise<UsageSummary & { context: ConfigurationContext }> {
  const resolved = selected.resolved;
  const request: HostRequest<"omp.usage"> = {
    protocol: PROTOCOL,
    version: 1,
    requestId: crypto.randomUUID(),
    controllerId: resolved.controllerId,
    expectedHostId: resolved.target.hostId,
    op: "omp.usage",
    args: { context: selected.configuration_context, now },
  };
  if (resolved.target.kind === "ssh")
    return await callHelper(resolved.target, request, { spawnStdio: pi.spawnStdio, signal });
  signal?.throwIfAborted();
  const reply = await dispatchHostRequest(resolved.runtime!, request);
  if (!reply.ok) throw new HostFailure(reply.error.code, reply.error.message, reply.error);
  return reply.result;
}

/** Call again in the allocated/reset cwd: project-local configuration can change the choice. */
export async function effectiveWorkerChoice(
  source: RuntimeDeps | OmpModelsSnapshot,
  context: ConfigurationContext,
  requested: RequestedWorkerChoice = {},
  signal?: AbortSignal,
): Promise<ModelChoice> {
  signal?.throwIfAborted();
  configurationContextSchema.parse(context);
  if (requested.role !== undefined && requested.model !== undefined)
    throw new Error("role and model are mutually exclusive");
  const snapshot =
    "catalog" in source
      ? source
      : {
          context,
          catalog: await chatModels(source, context, signal),
          roles: await modelRoles(source, context, signal),
        };
  if (
    snapshot.context.cwd !== context.cwd ||
    snapshot.context.ompProfile !== context.ompProfile ||
    snapshot.context.overlayPath !== context.overlayPath ||
    snapshot.context.overlaySha256 !== context.overlaySha256
  )
    throw new Error(
      "Model snapshot belongs to a different configuration context; revalidate in the worker cwd",
    );
  if (requested.model !== undefined) return resolveModel(snapshot.catalog, requested.model);
  const role = requested.role ?? "default";
  const value = snapshot.roles[role];
  if (!value) throw new Error(`Selected host context has no configured OMP role: ${role}`);
  return resolveModel(snapshot.catalog, value);
}

/** Chat models this OMP install can reach, keyed by exact selector. */
export async function chatModels(
  deps: RuntimeDeps,
  cwd: string | ConfigurationContext,
  signal?: AbortSignal,
): Promise<Map<string, CatalogModel>> {
  await verifyContext(cwd);
  const value = parseJson(
    await execCommand(deps, "omp", queryArguments(["models", "--json"], cwd), {
      cwd: queryCwd(cwd),
      signal,
    }),
    "omp models",
  );
  const models = valueAt(value, ["models"]);
  if (!Array.isArray(models)) throw new Error("omp models returned no model list");
  const catalog = new Map<string, CatalogModel>();
  for (const entry of models) {
    const selector = stringAt(entry, ["selector"]);
    if (!selector || stringAt(entry, ["kind"]) !== "chat") continue;
    const slash = selector.indexOf("/");
    const input = valueAt(entry, ["input"]);
    const costInput = valueAt(entry, ["cost", "input"]);
    const costOutput = valueAt(entry, ["cost", "output"]);
    const contextWindow = valueAt(entry, ["contextWindow"]);
    const maxTokens = valueAt(entry, ["maxTokens"]);
    const name = stringAt(entry, ["name"]);
    catalog.set(selector, {
      selector,
      provider: stringAt(entry, ["provider"]) ?? selector.slice(0, Math.max(slash, 0)),
      id: stringAt(entry, ["id"]) ?? selector.slice(slash + 1),
      ...(name ? { name } : {}),
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof maxTokens === "number" ? { maxTokens } : {}),
      thinking: strings(valueAt(entry, ["thinking"])),
      input: strings(input),
      // Routing placeholders expose negative sentinel prices, not an actual quoted cost.
      ...(typeof costInput === "number" &&
      Number.isFinite(costInput) &&
      costInput >= 0 &&
      typeof costOutput === "number" &&
      Number.isFinite(costOutput) &&
      costOutput >= 0
        ? { cost: { input: costInput, output: costOutput } }
        : {}),
    });
  }
  return catalog;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * `omp --model` fuzzy-matches, so a typo could silently start a different model; only exact
 * catalog selectors pass. Some ids contain `:` themselves (OpenRouter's `:free`), so the whole
 * value is tried as a selector before a trailing `:level` is read as the thinking level.
 */
export function resolveModel(catalog: Map<string, CatalogModel>, value: string): ModelChoice {
  if (catalog.has(value)) return { model: value };
  const split = value.lastIndexOf(":");
  const selector = split > 0 ? value.slice(0, split) : value;
  const levels = catalog.get(selector)?.thinking;
  if (!levels)
    throw new Error(`Unknown OMP model: ${value}; use an exact provider/id from \`omp models\``);
  const thinking = value.slice(split + 1);
  if (!levels.includes(thinking))
    throw new Error(
      `Thinking level ${thinking || "(empty)"} is not supported by ${selector}${
        levels.length ? ` (supported: ${levels.join(", ")})` : " (it has no thinking levels)"
      }`,
    );
  return { model: selector, thinking };
}

/** OMP model roles with `@role` aliases followed, so each role shows the model it really runs. */
export async function modelRoles(
  deps: RuntimeDeps,
  cwd: string | ConfigurationContext,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  await verifyContext(cwd);
  const output = await execCommand(
    deps,
    "omp",
    queryArguments(["config", "get", "modelRoles", "--json"], cwd),
    {
      cwd: queryCwd(cwd),
      signal,
    },
  );
  const value = valueAt(parseJson(output, "omp config get"), ["value"]);
  // A colon can belong to an exact model id; only its host catalog can separate a level.
  const overrides =
    value &&
    typeof value === "object" &&
    Object.values(value).some((role) => typeof role === "string" && /^@[^:]+:/.test(role));
  return rolesFrom(value, overrides ? await chatModels(deps, cwd, signal) : undefined);
}

type UsageAmount = {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit?: string;
};
type UsageLimit = {
  label?: string;
  status?: string;
  amount?: UsageAmount;
  window?: { label?: string; durationMs?: number; resetsAt?: number };
};
type UsageReport = {
  provider?: string;
  limits?: UsageLimit[];
  metadata?: {
    email?: string;
    accountId?: string;
    planType?: string | null;
    limitReached?: boolean | null;
  };
};
type UsageCapacity = {
  window?: string;
  meter?: string;
  accounts?: number;
  remainingAccounts?: number;
};

export type UsageWindow = {
  window: string;
  status?: string;
  remaining_percent?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
  window_elapsed_percent?: number;
  resets_at?: string;
  resets_in?: string;
};
export type UsageAccount = {
  account: string;
  plan?: string;
  limit_reached?: true;
  windows: UsageWindow[];
};
export type UsageProvider = {
  provider: string;
  roles: string[];
  accounts: UsageAccount[];
  capacity: Array<{ window: string; accounts: number; remaining_accounts: number }>;
};
export type UsageSummary = {
  generated_at: string;
  providers: UsageProvider[];
  roles: Record<string, string>;
  accounts_without_usage?: string[];
  disabled_credentials?: unknown[];
};

/**
 * Reads the same credential store workers spend from, which vendor-CLI quota readers do not see,
 * and trims it to what a dispatch decision needs: headroom, reset time, and how much of each
 * window has elapsed so usage can be compared against pace.
 */
export async function usageSummary(
  deps: RuntimeDeps,
  cwd: string | ConfigurationContext,
  now: number,
  signal?: AbortSignal,
): Promise<UsageSummary> {
  await verifyContext(cwd);
  const [usageOutput, roles] = await Promise.all([
    execCommand(deps, "omp", queryArguments(["usage", "--json", "--redact"], cwd), {
      cwd: queryCwd(cwd),
      signal,
    }),
    modelRoles(deps, cwd, signal),
  ]);
  const usage = parseJson(usageOutput, "omp usage");
  const reports = valueAt(usage, ["reports"]);
  const capacity = valueAt(usage, ["capacity"]);
  const providers = new Map<string, UsageProvider>();
  const providerFor = (provider: string) => {
    let entry = providers.get(provider);
    if (!entry) {
      entry = {
        provider,
        roles: Object.entries(roles)
          .filter(([, model]) => model.startsWith(`${provider}/`))
          .map(([role]) => role),
        accounts: [],
        capacity: [],
      };
      providers.set(provider, entry);
    }
    return entry;
  };
  for (const report of Array.isArray(reports) ? (reports as UsageReport[]) : []) {
    if (!report?.provider) continue;
    const entry = providerFor(report.provider);
    const metadata = report.metadata ?? {};
    entry.accounts.push({
      account: metadata.email ?? metadata.accountId ?? `account ${entry.accounts.length + 1}`,
      ...(metadata.planType ? { plan: metadata.planType } : {}),
      ...(metadata.limitReached ? { limit_reached: true as const } : {}),
      windows: (report.limits ?? []).map((limit) => usageWindow(limit, now)),
    });
  }
  if (capacity && typeof capacity === "object" && !Array.isArray(capacity))
    for (const [provider, windows] of Object.entries(capacity)) {
      if (!Array.isArray(windows)) continue;
      providerFor(provider).capacity = (windows as UsageCapacity[]).flatMap((window) =>
        window.window && typeof window.accounts === "number"
          ? [
              {
                window: window.meter ? `${window.window} ${window.meter}` : window.window,
                accounts: window.accounts,
                remaining_accounts: round(window.remainingAccounts ?? 0, 2),
              },
            ]
          : [],
      );
    }
  const without = valueAt(usage, ["accountsWithoutUsage"]);
  const disabled = valueAt(usage, ["disabledCredentials"]);
  const withoutUsage = Array.isArray(without)
    ? without.flatMap((item) => {
        const provider = stringAt(item, ["provider"]);
        const type = stringAt(item, ["type"]);
        return provider ? [type ? `${provider} (${type})` : provider] : [];
      })
    : [];
  return {
    generated_at: new Date(now).toISOString(),
    providers: [...providers.values()],
    roles,
    ...(withoutUsage.length ? { accounts_without_usage: withoutUsage } : {}),
    ...(Array.isArray(disabled) && disabled.length ? { disabled_credentials: disabled } : {}),
  };
}

/** Role aliases (`@slow`) point at another role; follow them so each role shows its real model. */
function rolesFrom(value: unknown, catalog?: Map<string, CatalogModel>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const resolve = (model: string, seen: Set<string>): string => {
    if (!model.startsWith("@")) return model;
    const split = model.indexOf(":");
    const target = model.slice(1, split < 0 ? undefined : split);
    if (seen.has(target) || raw[target] === undefined) return model;
    seen.add(target);
    const resolved = resolve(raw[target], seen);
    if (resolved.startsWith("@") || split < 0) return resolved;
    const suffix = model.slice(split);
    try {
      return `${resolveModel(catalog!, resolved).model}${suffix}`;
    } catch {
      return `${resolved}${suffix}`;
    }
  };
  return Object.fromEntries(
    Object.entries(raw).map(([role, model]) => [role, resolve(model, new Set([role]))]),
  );
}

function usageWindow(limit: UsageLimit, now: number): UsageWindow {
  const amount = limit.amount ?? {};
  const window = limit.window ?? {};
  const remainingFraction =
    amount.remainingFraction ??
    (amount.usedFraction !== undefined ? 1 - amount.usedFraction : undefined);
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : undefined;
  const elapsed =
    resetsAt !== undefined && window.durationMs
      ? Math.min(1, Math.max(0, 1 - (resetsAt - now) / window.durationMs))
      : undefined;
  return {
    window: limit.label ?? window.label ?? "unknown",
    ...(limit.status ? { status: limit.status } : {}),
    ...(remainingFraction !== undefined
      ? { remaining_percent: round(remainingFraction * 100, 0) }
      : {
          ...(amount.remaining !== undefined ? { remaining: amount.remaining } : {}),
          ...(amount.limit !== undefined ? { limit: amount.limit } : {}),
          ...(amount.unit ? { unit: amount.unit } : {}),
        }),
    ...(elapsed !== undefined ? { window_elapsed_percent: round(elapsed * 100, 0) } : {}),
    ...(resetsAt !== undefined
      ? { resets_at: new Date(resetsAt).toISOString(), resets_in: duration(resetsAt - now) }
      : {}),
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function duration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}
