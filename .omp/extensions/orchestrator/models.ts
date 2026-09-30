import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chatModels, modelRoles, resolveModel, type CatalogModel } from "../../runtime/omp";
import {
  errorMessage,
  text,
  type ModelsParams,
  type ToolAPI,
  type ToolFactory,
} from "../../runtime/shared";

export type ModelPreference =
  | { stance: "prefer"; for?: string[]; rank?: number; note?: string; updated_at: string }
  | { stance: "avoid"; note?: string; updated_at: string };

export type ModelRow = {
  /** Exact value for `orchestrator_task` `model`, thinking suffix included. */
  model: string;
  provider: string;
  name?: string;
  thinking_levels: string[];
  context_window?: number;
  max_tokens?: number;
  input: string[];
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
  return z.record(
    z.string(),
    z.union([
      z
        .object({
          stance: z.literal("prefer"),
          for: z.array(z.string()).optional(),
          rank: z.number().int().min(1).optional(),
          note,
          updated_at,
        })
        .strict(),
      z.object({ stance: z.literal("avoid"), note, updated_at }).strict(),
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

async function listModels(
  root: string,
  pi: ToolAPI,
  params: Extract<ModelsParams, { op: "list" }>,
  signal?: AbortSignal,
) {
  const view = params.view ?? "preferred";
  const [catalog, roles, preferences] = await Promise.all([
    chatModels(pi, root, signal),
    modelRoles(pi, root, signal),
    readPreferences(root, pi.zod, signal),
  ]);
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
  for (const value of Object.keys(preferences))
    if (!add(value))
      issues.push(
        `Saved preference ${value} is not in the OMP model catalog; forget or replace it`,
      );
  for (const [value, names] of rolesByModel)
    if (!add(value))
      issues.push(
        `OMP role ${names.toSorted().join(", ")} uses ${value}, which is not an exact catalog model`,
      );
  if (view === "all") for (const selector of catalog.keys()) add(selector);

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
    view,
    total: filtered.length,
    returned: models.length,
    models,
    ...(issues.length ? { issues } : {}),
  };
  return text(`Models:\n${JSON.stringify(details, null, 2)}`, details);
}

const modelsTool: ToolFactory = (pi) => {
  const z = pi.zod;

  return {
    name: "models",
    label: "Models",
    loadMode: "essential",
    approval: "write",
    description:
      "List OMP chat models with the user's saved model preferences and the models current OMP roles run, and remember preferences. `list` view `preferred` (default) shows only models with a saved preference or role; `all` searches the full catalog. Each row's `model` is the exact value for orchestrator_task `model`. `prefer` saves a preferred model, optionally with the roles or kinds of work it is for, a rank (1 = first choice), and the user's reason; `avoid` marks a model never to pick on your own; `forget` deletes a saved entry. Saving replaces any earlier entry for the same model value.",
    parameters: z.union([
      z
        .object({
          op: z.literal("list"),
          view: z.enum(["preferred", "all"]).optional(),
          provider: z.string().optional(),
          q: z.string().optional(),
          limit: z.number().int().min(1).optional(),
        })
        .strict(),
      z
        .object({
          op: z.literal("prefer"),
          model: z.string().min(1),
          for: z
            .array(z.string().min(1))
            .optional()
            .describe("OMP roles or kinds of work this model should handle, e.g. slow, review"),
          rank: z.number().int().min(1).optional(),
          note: z.string().optional(),
        })
        .strict(),
      z
        .object({ op: z.literal("avoid"), model: z.string().min(1), note: z.string().optional() })
        .strict(),
      z.object({ op: z.literal("forget"), model: z.string().min(1) }).strict(),
    ]),
    execute: async (_id, params: ModelsParams, signal?: AbortSignal) => {
      const root = pi.cwd;
      try {
        signal?.throwIfAborted();
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
        // Validate against the live catalog so a typo can't be remembered and later block
        // or misdirect a launch; the stored key is the exact value orchestrator_task accepts.
        const choice = resolveModel(await chatModels(pi, root, signal), params.model);
        const model = choice.thinking ? `${choice.model}:${choice.thinking}` : choice.model;
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
                ...(uses.length ? { for: uses } : {}),
                ...(params.rank !== undefined ? { rank: params.rank } : {}),
                ...(note ? { note } : {}),
                updated_at,
              }
            : { stance: "avoid", ...(note ? { note } : {}), updated_at };
        preferences[model] = preference;
        await writePreferences(root, preferences, signal);
        return text(`Saved model preference:\n${JSON.stringify({ model, preference }, null, 2)}`, {
          model,
          preference,
        });
      } catch (error) {
        return text(errorMessage(error), undefined, true);
      }
    },
  };
};

export default modelsTool;
