import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, FakeExec, fixtureRoot, runtime } from "./test-helpers";

afterEach(cleanup);

const CATALOG = [
  {
    provider: "anthropic",
    kind: "chat",
    id: "claude-opus-5-5",
    selector: "anthropic/claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinking: ["low", "medium", "high", "max"],
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5 },
  },
  {
    provider: "anthropic",
    kind: "chat",
    id: "claude-haiku-4-5",
    selector: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    thinking: ["low", "high"],
    input: ["text"],
  },
  {
    provider: "openai-codex",
    kind: "chat",
    id: "gpt-5.6",
    selector: "openai-codex/gpt-5.6",
    name: "GPT-5.6",
    thinking: ["low", "high", "xhigh"],
    input: ["text"],
  },
  {
    provider: "openrouter",
    kind: "chat",
    id: "qwen/qwen3-coder:free",
    selector: "openrouter/qwen/qwen3-coder:free",
    thinking: null,
    input: ["text"],
  },
];

async function setup(roles: Record<string, string> = {}) {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  fake.models = CATALOG;
  fake.modelRoles = roles;
  return { root, fake, instance: runtime(root, fake, []) };
}

type Listed = {
  view: string;
  total: number;
  returned: number;
  models: Array<{ model: string; roles?: string[]; preference?: { stance: string } }>;
  issues?: string[];
};

describe("models", () => {
  test("preferred view ranks saved preferences, role targets, and avoided models", async () => {
    const { instance } = await setup({
      default: "anthropic/claude-opus-5-5:high",
      slow: "@default",
      tiny: "anthropic/claude-haiku-4-5",
      broken: "pi/missing",
    });
    for (const params of [
      { op: "prefer" as const, model: "openai-codex/gpt-5.6:xhigh", rank: 2, for: ["review"] },
      { op: "prefer" as const, model: "anthropic/claude-opus-5-5:max", rank: 1, note: "hard bugs" },
      { op: "avoid" as const, model: "anthropic/claude-haiku-4-5", note: "misses edge cases" },
      { op: "prefer" as const, model: "openrouter/qwen/qwen3-coder:free" },
    ])
      expect((await instance.runModels(params)).isError).toBeUndefined();

    const listed = (await instance.runModels({ op: "list" })).details as Listed;

    expect(listed.models.map((item) => item.model)).toEqual([
      "anthropic/claude-opus-5-5:max",
      "openai-codex/gpt-5.6:xhigh",
      "openrouter/qwen/qwen3-coder:free",
      "anthropic/claude-opus-5-5:high",
      "anthropic/claude-haiku-4-5",
    ]);
    // Aliased roles resolve to the model they really run; the avoided model keeps its role.
    expect(listed.models[3]).toMatchObject({ roles: ["default", "slow"] });
    expect(listed.models[4]).toMatchObject({
      roles: ["tiny"],
      preference: { stance: "avoid", note: "misses edge cases" },
    });
    expect(listed.models[0]).toMatchObject({
      provider: "anthropic",
      name: "Claude Opus 5.5",
      context_window: 1_000_000,
      cost_per_mtok: { input: 5, output: 25 },
      preference: { stance: "prefer", rank: 1, note: "hard bugs" },
    });
    expect(listed.issues).toEqual([
      "OMP role broken uses pi/missing, which is not an exact catalog model",
    ]);
  });

  test("all view searches the whole catalog by provider and text", async () => {
    const { instance } = await setup();
    await instance.runModels({ op: "prefer", model: "openai-codex/gpt-5.6", for: ["review"] });

    const all = (await instance.runModels({ op: "list", view: "all", limit: 2 })).details as Listed;
    expect(all).toMatchObject({ total: 4, returned: 2 });
    expect(all.models[0]!.model).toBe("openai-codex/gpt-5.6");

    const anthropic = (await instance.runModels({ op: "list", view: "all", provider: "Anthropic" }))
      .details as Listed;
    expect(anthropic.models.map((item) => item.model)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-5-5",
    ]);

    const review = (await instance.runModels({ op: "list", view: "all", q: "REVIEW" }))
      .details as Listed;
    expect(review.models.map((item) => item.model)).toEqual(["openai-codex/gpt-5.6"]);
  });

  test("saving rejects unknown models and thinking levels without writing", async () => {
    const { root, instance } = await setup();

    const typo = await instance.runModels({ op: "prefer", model: "anthropic/claude-opus-55" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0]).toMatchObject({ text: expect.stringContaining("Unknown OMP model") });
    const level = await instance.runModels({ op: "avoid", model: "openai-codex/gpt-5.6:max" });
    expect(level.isError).toBe(true);
    expect(level.content[0]).toMatchObject({ text: expect.stringContaining("supported: low") });

    await expect(readFile(join(root, ".omp", "model-preferences.json"))).rejects.toThrow();
  });

  test("a later save replaces the entry and forget removes it", async () => {
    const { root, instance } = await setup();
    const model = "anthropic/claude-opus-5-5:high";
    await instance.runModels({ op: "prefer", model, rank: 1, for: ["plan"], note: "planning" });
    await instance.runModels({ op: "avoid", model });

    const saved = JSON.parse(await readFile(join(root, ".omp", "model-preferences.json"), "utf8"));
    expect(saved).toEqual({ [model]: { stance: "avoid", updated_at: expect.any(String) } });

    expect((await instance.runModels({ op: "forget", model })).isError).toBeUndefined();
    expect((await instance.runModels({ op: "list" })).details).toMatchObject({ models: [] });
    const again = await instance.runModels({ op: "forget", model });
    expect(again.isError).toBe(true);
  });

  test("stale preferences are reported and can still be forgotten", async () => {
    const { root, instance } = await setup();
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "model-preferences.json"),
      JSON.stringify({ "retired/model": { stance: "prefer", updated_at: "2026-01-01" } }),
    );

    const listed = (await instance.runModels({ op: "list" })).details as Listed;
    expect(listed.models).toEqual([]);
    expect(listed.issues).toEqual([
      "Saved preference retired/model is not in the OMP model catalog; forget or replace it",
    ]);
    expect((await instance.runModels({ op: "forget", model: "retired/model" })).isError).toBe(
      undefined,
    );
  });

  test("a malformed preferences file is an error, not an empty list", async () => {
    const { root, instance } = await setup();
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "model-preferences.json"),
      JSON.stringify({ "openai-codex/gpt-5.6": { stance: "maybe", updated_at: "x" } }),
    );

    const result = await instance.runModels({ op: "list" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "Malformed .omp/model-preferences.json" });
  });
});
