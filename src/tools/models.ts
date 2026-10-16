import type { ToolSpec } from "../core/tool";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  resolveModel,
  selectOmpContext,
  selectedModels,
  validateOmpSelector,
  type CatalogModel,
  type OmpQueryAPI,
  type OmpSelector,
} from "../runtime/omp";
import { CLAUDE_CODE_ALIASES } from "../runtime/claude";
import { CLAUDE_EFFORTS, CLAUDE_MODEL } from "../runtime/herdr";
import { CODEX_EFFORTS, CODEX_MODEL, codexModels, type CodexModel } from "../runtime/codex";
import { errorMessage, text, type ModelsParams, type ToolAPI } from "../runtime/shared";

/** `agent` marks a Claude Code or Codex model value; absent means an OMP catalog model. */
export type ModelPreference =
  | {
      stance: "prefer";
      agent?: "claude" | "codex";
      for?: string[];
      rank?: number;
      note?: string;
      updated_at: string;
    }
  | { stance: "avoid"; agent?: "claude" | "codex"; note?: string; updated_at: string };

export type HostModelsParams =
  | (Exclude<ModelsParams, { op: "forget" }> & OmpSelector)
  | Extract<ModelsParams, { op: "forget" }>;
export type ModelRow = {
  /** Exact value for `orchestrator_task` `model`, thinking suffix included. */
  model: string;
  /** Present for Claude Code and Codex models, which launch with that orchestrator_task agent. */
  agent?: "claude" | "codex";
  provider: string;
  name?: string;
  thinking_levels: string[];
  context_window?: number;
  max_tokens?: number;
  input?: string[];
  cost_per_mtok?: { input: number; output: number };
  roles?: string[];
  preference?: ModelPreference;
};

const DEFAULT_LIMIT = 50;

function preferencesPath(root: string): string {
  return join(root, ".omp", "model-preferences.json");
}

function preferencesSchema(z: ToolAPI["zod"]) {
  const note = z.string().optional();
  const updated_at = z.string();
  const agent = z.enum(["claude", "codex"]).optional();
  return z.record(
    z.string(),
    z.union([
      z
        .object({
          stance: z.literal("prefer"),
          agent,
          for: z.array(z.string()).optional(),
          rank: z.number().int().min(1).optional(),
          note,
          updated_at,
        })
        .strict(),
      z.object({ stance: z.literal("avoid"), agent, note, updated_at }).strict(),
    ]),
  );
}

export async function readPreferences(
  root: string,
  z: ToolAPI["zod"],
  signal?: AbortSignal,
): Promise<Record<string, ModelPreference>> {
  signal?.throwIfAborted();
  let raw: string;
  try {
    raw = await readFile(preferencesPath(root), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Malformed .omp/model-preferences.json");
  }
  const result = preferencesSchema(z).safeParse(parsed);
  if (!result.success) throw new Error("Malformed .omp/model-preferences.json");
  return result.data as Record<string, ModelPreference>;
}

async function writePreferences(
  root: string,
  preferences: Record<string, ModelPreference>,
  signal?: AbortSignal,
): Promise<void> {
  const path = preferencesPath(root);
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  const sorted = Object.fromEntries(
    Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b)),
  );
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
  await rename(temp, path);
}

function row(
  model: string,
  entry: CatalogModel,
  roles: string[] | undefined,
  preference: ModelPreference | undefined,
): ModelRow {
  return {
    model,
    provider: entry.provider,
    ...(entry.name ? { name: entry.name } : {}),
    thinking_levels: entry.thinking,
    ...(entry.contextWindow !== undefined ? { context_window: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { max_tokens: entry.maxTokens } : {}),
    input: entry.input,
    ...(entry.cost ? { cost_per_mtok: entry.cost } : {}),
    ...(roles?.length ? { roles: roles.toSorted() } : {}),
    ...(preference ? { preference } : {}),
  };
}

const CLAUDE_PROVIDER = "claude-code";

function claudeRow(model: string, preference: ModelPreference | undefined): ModelRow {
  return {
    model,
    agent: "claude",
    provider: CLAUDE_PROVIDER,
    thinking_levels: [...CLAUDE_EFFORTS],
    ...(preference ? { preference } : {}),
  };
}

const CODEX_PROVIDER = "codex-cli";

function codexRow(
  model: string,
  entry: CodexModel | undefined,
  preference: ModelPreference | undefined,
): ModelRow {
  return {
    model,
    agent: "codex",
    provider: CODEX_PROVIDER,
    ...(entry?.name ? { name: entry.name } : {}),
    thinking_levels: entry?.efforts.length ? entry.efforts : [...CODEX_EFFORTS],
    ...(preference ? { preference } : {}),
  };
}

/** Ranked preferences first, then unranked ones, role targets, the rest, and avoided models last. */
function order(item: ModelRow): number[] {
  const preference = item.preference;
  if (preference?.stance === "avoid") return [4, 0];
  if (preference?.stance === "prefer")
    return preference.rank !== undefined ? [0, preference.rank] : [1, 0];
  return item.roles ? [2, 0] : [3, 0];
}

function matches(item: ModelRow, query: string): boolean {
  const preference = item.preference;
  const haystack = [
    item.model,
    item.name ?? "",
    ...(item.roles ?? []),
    preference?.note ?? "",
    ...(preference?.stance === "prefer" ? (preference.for ?? []) : []),
  ];
  return haystack.some((value) => value.toLowerCase().includes(query));
}

export async function listModels(
  root: string,
  pi: OmpQueryAPI,
  params: Extract<HostModelsParams, { op: "list" }>,
  signal?: AbortSignal,
) {
  const view = params.view ?? "preferred";
  const selected = await selectOmpContext(pi, params, signal);
  const [snapshot, preferences] = await Promise.all([
    selectedModels(pi, selected, signal),
    readPreferences(root, pi.zod, signal),
  ]);
  const { catalog, roles } = snapshot;
  const rolesByModel = new Map<string, string[]>();
  for (const [role, value] of Object.entries(roles))
    rolesByModel.set(value, [...(rolesByModel.get(value) ?? []), role]);

  const rows = new Map<string, ModelRow>();
  const add = (value: string): boolean => {
    if (rows.has(value)) return true;
    let selector: string;
    try {
      selector = resolveModel(catalog, value).model;
    } catch {
      return false;
    }
    rows.set(
      value,
      row(value, catalog.get(selector)!, rolesByModel.get(value), preferences[value]),
    );
    return true;
  };
  // Stale entries stay listed as issues instead of failing: a provider dropping a model must
  // not hide every other preference, and the user needs the exact key to forget it.
  const issues: string[] = [];
  // Claude Code and Codex workers run only on the local machine, so their models belong to its
  // list alone.
  const claude = selected.machine === "local";
  const codex = claude ? await codexModels() : undefined;
  const codexEntry = (value: string) => codex?.find((item) => item.slug === value.split(":")[0]);
  for (const [value, preference] of Object.entries(preferences)) {
    if (preference.agent === "claude") {
      if (claude) rows.set(value, claudeRow(value, preference));
      continue;
    }
    if (preference.agent === "codex") {
      if (claude) rows.set(value, codexRow(value, codexEntry(value), preference));
      continue;
    }
    if (!add(value))
      issues.push(
        `Saved preference ${value} is not in the OMP model catalog; forget or replace it`,
      );
  }
  for (const [value, names] of rolesByModel)
    if (!add(value))
      issues.push(
        `OMP role ${names.toSorted().join(", ")} uses ${value}, which is not an exact catalog model`,
      );
  if (view === "all") {
    for (const selector of catalog.keys()) add(selector);
    if (claude)
      for (const alias of CLAUDE_CODE_ALIASES)
        if (!rows.has(alias)) rows.set(alias, claudeRow(alias, undefined));
    for (const entry of codex ?? [])
      if (!rows.has(entry.slug)) rows.set(entry.slug, codexRow(entry.slug, entry, undefined));
  }

  const provider = params.provider?.toLowerCase();
  const query = params.q?.trim().toLowerCase();
  const filtered = [...rows.values()]
    .filter((item) => !provider || item.provider.toLowerCase() === provider)
    .filter((item) => !query || matches(item, query))
    .sort((a, b) => {
      const [left, right] = [order(a), order(b)];
      return left[0]! - right[0]! || left[1]! - right[1]! || a.model.localeCompare(b.model);
    });
  const limit = params.limit ?? DEFAULT_LIMIT;
  const models = filtered.slice(0, limit);
  const details = {
    machine: selected.machine,
    session: selected.session,
    os: selected.os,
    configuration_context: snapshot.context,
    observed_at: new Date().toISOString(),
    view,
    total: filtered.length,
    returned: models.length,
    models,
    ...(issues.length ? { issues } : {}),
  };
  return text(`Models:\n${JSON.stringify(details, null, 2)}`, details);
}

const modelsTool = (pi: OmpQueryAPI): ToolSpec => {
  const z = pi.zod;
  const selector = { machine: z.string().min(1).optional(), project: z.string().min(1).optional() };
  const exclusive = (params: OmpSelector) =>
    params.machine === undefined || params.project === undefined;
  return {
    name: "models",
    label: "Models",
    approval: "write",
    description:
      "List OMP chat models with the user's saved model preferences and the models current OMP roles run, and remember preferences. `list` view `preferred` (default) shows only models with a saved preference or role; `all` searches the full catalog. Each row's `model` is the exact value for orchestrator_task `model`; rows with agent `claude` or `codex` are Claude Code or Codex CLI models (local machine only; Codex rows come from the default CODEX_HOME's model cache) and launch with that orchestrator_task agent. `prefer`/`avoid` with agent `claude` or `codex` save that CLI's model name with optional :effort, without machine or project. `prefer` saves a preferred model, optionally with the roles or kinds of work it is for, a rank (1 = first choice), and the user's reason; `avoid` marks a model never to pick on your own; `forget` deletes a saved entry. Saving replaces any earlier entry for the same model value. Optional machine or project selects the catalog and configuration context; neither means local. Preferences stay controller-local; forget needs no host.",
    parameters: z.union([
      z
        .object({
          op: z.literal("list"),
          ...selector,
          view: z.enum(["preferred", "all"]).optional(),
          provider: z.string().optional(),
          q: z.string().optional(),
          limit: z.number().int().min(1).optional(),
        })
        .strict()
        .refine(exclusive, "machine and project are mutually exclusive"),
      z
        .object({
          op: z.literal("prefer"),
          ...selector,
          model: z.string().min(1),
          agent: z.enum(["omp", "claude", "codex"]).optional(),
          for: z
            .array(z.string().min(1))
            .optional()
            .describe("OMP roles or kinds of work this model should handle, e.g. slow, review"),
          rank: z.number().int().min(1).optional(),
          note: z.string().optional(),
        })
        .strict()
        .refine(exclusive, "machine and project are mutually exclusive"),
      z
        .object({
          ...selector,
          op: z.literal("avoid"),
          model: z.string().min(1),
          agent: z.enum(["omp", "claude", "codex"]).optional(),
          note: z.string().optional(),
        })
        .strict()
        .refine(exclusive, "machine and project are mutually exclusive"),
      z.object({ op: z.literal("forget"), model: z.string().min(1) }).strict(),
    ]),
    execute: async (params: HostModelsParams, signal?: AbortSignal) => {
      const root = pi.cwd;
      try {
        signal?.throwIfAborted();
        if (params.op !== "forget") validateOmpSelector(params);
        if (params.op === "list") return await listModels(root, pi, params, signal);

        const preferences = await readPreferences(root, pi.zod, signal);
        if (params.op === "forget") {
          if (!(params.model in preferences))
            throw new Error(`No saved model preference: ${params.model}`);
          delete preferences[params.model];
          await writePreferences(root, preferences, signal);
          return text(`Forgot model preference: ${params.model}`, { model: params.model });
        }

        if (params.op === "prefer" && params.rank !== undefined)
          if (!Number.isInteger(params.rank) || params.rank < 1)
            throw new Error("Preference rank must be a whole number of 1 or more");
        const cli =
          params.agent === "claude" || params.agent === "codex" ? params.agent : undefined;
        let model: string;
        let host:
          | { selected: Awaited<ReturnType<typeof selectOmpContext>>; context: unknown }
          | undefined;
        if (cli) {
          const label = cli === "claude" ? "Claude Code" : "Codex";
          if (params.machine !== undefined || params.project !== undefined)
            throw new Error(
              `${label} preferences take no machine or project; ${label} workers run only on the local machine`,
            );
          // Claude Code resolves aliases itself and publishes no catalog, and each Codex home
          // caches its own account's models, so only the shape a launch accepts is checked.
          const [shape, efforts] =
            cli === "claude" ? [CLAUDE_MODEL, CLAUDE_EFFORTS] : [CODEX_MODEL, CODEX_EFFORTS];
          if (!shape.test(params.model))
            throw new Error(
              `Invalid ${label} model: ${params.model}; use a ${label} model name with optional :${efforts.join("|")}`,
            );
          model = params.model;
        } else {
          // Validate against the live catalog so a typo can't be remembered and later block
          // or misdirect a launch; the stored key is the exact value orchestrator_task accepts.
          const selected = await selectOmpContext(pi, params, signal);
          const snapshot = await selectedModels(pi, selected, signal);
          const choice = resolveModel(snapshot.catalog, params.model);
          model = choice.thinking ? `${choice.model}:${choice.thinking}` : choice.model;
          host = { selected, context: snapshot.context };
        }
        const updated_at = new Date().toISOString();
        const note = params.note?.trim();
        const uses =
          params.op === "prefer"
            ? (params.for ?? []).map((item) => item.trim()).filter(Boolean)
            : [];
        const preference: ModelPreference =
          params.op === "prefer"
            ? {
                stance: "prefer",
                ...(cli ? { agent: cli } : {}),
                ...(uses.length ? { for: uses } : {}),
                ...(params.rank !== undefined ? { rank: params.rank } : {}),
                ...(note ? { note } : {}),
                updated_at,
              }
            : {
                stance: "avoid",
                ...(cli ? { agent: cli } : {}),
                ...(note ? { note } : {}),
                updated_at,
              };
        preferences[model] = preference;
        await writePreferences(root, preferences, signal);
        const details = {
          model,
          preference,
          ...(host
            ? {
                machine: host.selected.machine,
                session: host.selected.session,
                os: host.selected.os,
                configuration_context: host.context,
              }
            : { machine: "local" }),
          observed_at: new Date().toISOString(),
        };
        return text(`Saved model preference:\n${JSON.stringify(details, null, 2)}`, details);
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default modelsTool;
