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

/** Chat models this OMP install can reach, keyed by exact selector. */
export async function chatModels(
  deps: RuntimeDeps,
  cwd: string,
  signal?: AbortSignal,
): Promise<Map<string, CatalogModel>> {
  const value = parseJson(
    await execCommand(deps, "omp", ["models", "--json"], { cwd, signal }),
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
      ...(typeof costInput === "number" && typeof costOutput === "number"
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
  cwd: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const output = await execCommand(deps, "omp", ["config", "get", "modelRoles", "--json"], {
    cwd,
    signal,
  });
  return rolesFrom(valueAt(parseJson(output, "omp config get"), ["value"]));
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
  cwd: string,
  now: number,
  signal?: AbortSignal,
): Promise<UsageSummary> {
  const [usageOutput, roles] = await Promise.all([
    execCommand(deps, "omp", ["usage", "--json", "--redact"], { cwd, signal }),
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
function rolesFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const resolve = (model: string, seen: Set<string>): string => {
    if (!model.startsWith("@")) return model;
    const target = model.slice(1).split(":", 1)[0]!;
    if (seen.has(target) || raw[target] === undefined) return model;
    seen.add(target);
    return resolve(raw[target], seen);
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

function duration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}
