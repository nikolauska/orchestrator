import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseJson, stringAt, valueAt } from "./shared";

/** Reasoning efforts Codex model catalogs list; a model may support only some of them. */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** A Codex model slug with an optional `:effort`; Codex resolves the slug itself. */
export const CODEX_MODEL = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]*(?::(?:${CODEX_EFFORTS.join("|")}))?$`,
);

/** The CODEX_HOME a worker runs under; an explicit one must be absolute, never `~`-relative. */
export function codexHome(explicit?: string): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error(`Codex home must be an absolute path: ${explicit}`);
    return explicit;
  }
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export type CodexModel = { slug: string; name?: string; efforts: string[] };

/**
 * Codex publishes no catalog command, but caches the account's model list in its home. A
 * missing or unreadable cache means "unknown", not "no models", so callers fall back to the
 * name shape a launch accepts.
 */
export async function codexModels(home?: string): Promise<CodexModel[] | undefined> {
  let parsed: unknown;
  try {
    parsed = parseJson(
      await readFile(join(codexHome(home), "models_cache.json"), "utf8"),
      "Codex model cache",
    );
  } catch {
    return undefined;
  }
  const models = valueAt(parsed, ["models"]);
  if (!Array.isArray(models)) return undefined;
  return models.flatMap((model) => {
    const slug = stringAt(model, ["slug"]);
    // Hidden entries are Codex's own internal models, not ones a user picks.
    if (!slug || stringAt(model, ["visibility"]) === "hide") return [];
    const levels = valueAt(model, ["supported_reasoning_levels"]);
    const efforts = (Array.isArray(levels) ? levels : []).flatMap((level) => {
      const effort = stringAt(level, ["effort"]);
      return effort ? [effort] : [];
    });
    const name = stringAt(model, ["display_name"]);
    return [{ slug, ...(name ? { name } : {}), efforts }];
  });
}
