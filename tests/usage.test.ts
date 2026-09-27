import { afterEach, describe, expect, test } from "bun:test";
import { usageSummary } from "../.omp/runtime/omp";
import type { RuntimeDeps } from "../.omp/runtime/shared";
import { cleanup, FakeExec, fixtureRoot } from "./test-helpers";

afterEach(cleanup);

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-27T12:00:00Z");

describe("usage", () => {
  test("reports headroom against window pace and maps roles to providers", async () => {
    const { root, project } = await fixtureRoot();
    const fake = new FakeExec(project);
    fake.modelRoles = {
      default: "anthropic/claude-opus-5-5:high",
      slow: "@default",
      smol: "openai-codex/gpt-5.5:low",
    };
    fake.usage = {
      reports: [
        {
          provider: "anthropic",
          metadata: { email: "pu*", planType: null, limitReached: true },
          limits: [
            {
              label: "Claude 7 Day",
              status: "warning",
              amount: { usedFraction: 0.9, remainingFraction: 0.1, unit: "percent" },
              // Four of seven days remain, so 90% was spent in three days' worth of window.
              window: { durationMs: 168 * HOUR, resetsAt: NOW + 96 * HOUR + 30 * 60_000 },
            },
          ],
        },
        {
          provider: "openai-codex",
          metadata: { email: "us*", planType: "plus" },
          limits: [
            {
              label: "Credits",
              amount: { remaining: 40, limit: 100, unit: "credits" },
            },
          ],
        },
      ],
      capacity: {
        anthropic: [{ window: "7d", accounts: 1, usedAccounts: 0.9, remainingAccounts: 0.1 }],
      },
      accountsWithoutUsage: [{ provider: "opencode-go", type: "api_key" }],
      disabledCredentials: [],
    };

    const summary = await usageSummary({ exec: fake.exec } as unknown as RuntimeDeps, root, NOW);

    expect(summary.roles).toEqual({
      default: "anthropic/claude-opus-5-5:high",
      slow: "anthropic/claude-opus-5-5:high",
      smol: "openai-codex/gpt-5.5:low",
    });
    expect(summary.providers).toEqual([
      {
        provider: "anthropic",
        roles: ["default", "slow"],
        accounts: [
          {
            account: "pu*",
            limit_reached: true,
            windows: [
              {
                window: "Claude 7 Day",
                status: "warning",
                remaining_percent: 10,
                window_elapsed_percent: 43,
                resets_at: new Date(NOW + 96 * HOUR + 30 * 60_000).toISOString(),
                resets_in: "4d",
              },
            ],
          },
        ],
        capacity: [{ window: "7d", accounts: 1, remaining_accounts: 0.1 }],
      },
      {
        provider: "openai-codex",
        roles: ["smol"],
        accounts: [
          {
            account: "us*",
            plan: "plus",
            windows: [{ window: "Credits", remaining: 40, limit: 100, unit: "credits" }],
          },
        ],
        capacity: [],
      },
    ]);
    expect(summary.accounts_without_usage).toEqual(["opencode-go (api_key)"]);
    expect(summary).not.toHaveProperty("disabled_credentials");
  });
});
