import { afterEach, describe, expect, test } from "bun:test";
import { usageSummary } from "../.omp/runtime/omp";
import type { RuntimeDeps } from "../.omp/runtime/shared";
import { cleanup, FakeExec, fixtureRoot, extensionRuntime } from "./test-helpers";
import { zod } from "@oh-my-pi/pi-coding-agent";
import usageTool from "../.omp/extensions/orchestrator/usage";
import type { OmpQueryAPI, OmpContextResolver } from "../.omp/runtime/omp";
import { PROTOCOL, type HostRequest, type HostReply } from "../.omp/runtime/helper-protocol";
import type { StdioSpawn } from "../.omp/runtime/shared";
import { executionTargetFixture } from "./test-helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

test("usage selects one host's own accounts, role/profile context, and unmodified Windows project cwd", async () => {
  const { root, project } = await fixtureRoot();
  const local = new FakeExec(project);
  local.modelRoles = { default: "local/model" };
  const windows = { ...executionTargetFixture("win32", "windows"), ompProfile: "work" };
  const mac = { ...executionTargetFixture("darwin", "mac"), ompProfile: "personal" };
  const controllerId = crypto.randomUUID();
  const hosts = [
    {
      target: windows,
      cwd: "C:\\Users\\Nïko\\Query Root",
      remaining: 80,
      role: "remote/fast:high",
    },
    { target: mac, cwd: "/Users/niko/query", remaining: 20, role: "remote/slow:low" },
  ];
  const resolver: OmpContextResolver = async (machine) => {
    const host = hosts.find((host) => host.target.machineId === machine);
    if (!host) throw new Error("Unknown machine");
    return {
      target: host.target,
      controllerId,
      context: {
        cwd: host.cwd,
        ompProfile: host.target.ompProfile,
        overlayPath: host.target.workerConfig.path,
        overlaySha256: host.target.workerConfig.sha256,
      },
    };
  };
  const spawnStdio: StdioSpawn = (command) => {
    const host = hosts.find((host) => command.includes(host.target.sshTarget));
    if (!host) throw new Error("Unknown SSH destination");
    let input = "";
    let finish!: (reply: HostReply<"omp.usage">) => void;
    const reply = new Promise<HostReply<"omp.usage">>((resolve) => {
      finish = resolve;
    });
    return {
      stdin: {
        write(data) {
          input += typeof data === "string" ? data : new TextDecoder().decode(data);
        },
        async end() {
          const request = JSON.parse(input) as HostRequest<"omp.usage">;
          const context = request.args.context;
          if (request.op !== "omp.usage" || context.ompProfile !== host.target.ompProfile)
            throw new Error("Wrong host operation/profile");
          const summary = await usageSummary(
            {
              exec: async (_command, args) => ({
                code: 0,
                stderr: "",
                stdout: JSON.stringify(
                  args[0] === "usage"
                    ? {
                        reports: [
                          {
                            provider: "remote",
                            metadata: { email: "same*", planType: "plus" },
                            limits: [
                              {
                                label: "5h",
                                amount: { remainingFraction: host.remaining / 100 },
                                window: {
                                  durationMs: 5 * HOUR,
                                  resetsAt: request.args.now + 4 * HOUR,
                                },
                              },
                            ],
                          },
                        ],
                        capacity: {
                          remote: [
                            {
                              window: "5h",
                              accounts: 1,
                              remainingAccounts: host.remaining >= 50 ? 1 : 0,
                            },
                          ],
                        },
                      }
                    : {
                        value: {
                          default:
                            context.cwd === "D:\\Projects\\app ü"
                              ? "remote/project:high"
                              : host.role,
                          slow: "@default",
                        },
                      },
                ),
              }),
            } as RuntimeDeps,
            context.cwd,
            request.args.now,
          );
          finish({
            protocol: PROTOCOL,
            version: 1,
            requestId: request.requestId,
            hostId: host.target.hostId,
            ok: true,
            result: { ...summary, context },
          });
        },
      },
      stdout: (async function* () {
        yield new TextEncoder().encode(`${JSON.stringify(await reply)}\n`);
      })(),
      stderr: (async function* () {})(),
      exited: reply.then(() => 0),
      kill() {},
    };
  };
  const pi: OmpQueryAPI = {
    cwd: root,
    zod,
    logger: {} as RuntimeDeps["logger"],
    sendMessage() {},
    exec: (command, args, options) =>
      local.exec(
        command,
        args.filter((arg) => !arg.startsWith("--config=")),
        options,
      ),
    spawnStdio,
    resolveOmpContext: resolver,
  };
  const tool = usageTool(pi);
  const run = (params: unknown) => tool.execute("usage", params, undefined, undefined, {} as never);
  const win = await run({ machine: "windows" });
  expect(win).not.toHaveProperty("isError", true);
  expect(win.details).toMatchObject({
    machine: "windows",
    os: "win32",
    session: "agents",
    observed_at: expect.any(String),
    configuration_context: {
      cwd: hosts[0]!.cwd,
      ompProfile: "work",
      overlayPath: windows.workerConfig.path,
      overlaySha256: windows.workerConfig.sha256,
    },
    roles: { default: "remote/fast:high", slow: "remote/fast:high" },
    providers: [
      {
        provider: "remote",
        roles: ["default", "slow"],
        accounts: [
          { account: "same*", windows: [{ remaining_percent: 80, window_elapsed_percent: 20 }] },
        ],
        capacity: [{ accounts: 1, remaining_accounts: 1 }],
      },
    ],
  });
  const other = await run({ machine: "mac" });
  expect(other.details).toMatchObject({
    machine: "mac",
    os: "darwin",
    configuration_context: { ompProfile: "personal" },
    roles: { default: "remote/slow:low" },
    providers: [
      {
        accounts: [{ account: "same*", windows: [{ remaining_percent: 20 }] }],
        capacity: [{ accounts: 1, remaining_accounts: 0 }],
      },
    ],
  });
  await mkdir(join(root, ".omp"), { recursive: true });
  await writeFile(
    join(root, ".omp", "projects.json"),
    JSON.stringify({
      version: 2,
      roots: {},
      projects: {
        app: {
          machine: "windows",
          path: "D:\\Projects\\app ü",
          pathKey: "windows-app",
          binding: {
            sshTarget: windows.sshTarget,
            session: windows.session,
            hostId: windows.hostId,
          },
        },
      },
    }),
  );
  const scoped = await run({ project: "app" });
  expect(scoped.details).toMatchObject({
    machine: "windows",
    configuration_context: { cwd: "D:\\Projects\\app ü", ompProfile: "work" },
    roles: { default: "remote/project:high" },
  });
  expect((await run({ machine: "mac", project: "app" })).isError).toBe(true);
  expect((await run({ machine: "" })).isError).toBe(true);
  expect((await run({ project: "missing" })).isError).toBe(true);
  expect(tool.parameters.safeParse({ machine: "mac", project: "app" }).success).toBe(false);
});

test("local usage resolves the production host context without a running Herdr server", async () => {
  const { root, project } = await fixtureRoot();
  const fake = new FakeExec(project);
  fake.modelRoles = { default: "local/model", slow: "@default" };
  const execute = fake.exec;
  fake.exec = (command, args, options) =>
    command === "herdr"
      ? Promise.resolve({ code: 1, stdout: "", stderr: "No server" })
      : execute(command, args, options);
  const { instance } = extensionRuntime(root, fake, []);
  const result = await instance.runUsage({});
  expect(result.isError).toBeUndefined();
  expect(result.details).toMatchObject({
    machine: "local",
    os: process.platform,
    session: null,
    configuration_context: { cwd: root, overlaySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    roles: { default: "local/model", slow: "local/model" },
    providers: [],
  });
});
