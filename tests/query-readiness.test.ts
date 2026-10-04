import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, extensionRuntime, fixtureRoot, machineFixture, FakeExec } from "./test-helpers";

afterEach(cleanup);

for (const operation of ["models", "usage"] as const) {
  test.each(["constructor", "toString"])(
    `${operation} refuses inherited project properties as unknown registrations: %s`,
    async (projectName) => {
      const { root, project } = await fixtureRoot();
      const fake = new FakeExec(project);
      const { instance } = extensionRuntime(root, fake, []);
      const result =
        operation === "models"
          ? await instance.runModels({ op: "list", project: projectName })
          : await instance.runUsage({ project: projectName });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("Unknown project:") }),
      ]);
    },
  );
  test.each([{}, { machine: "local" }, { project: "local-repo" }])(
    `registered ${operation} works without Herdr for selector %j`,
    async (selector) => {
      const { root, project } = await fixtureRoot();
      const f = await machineFixture(root, project);
      f.fake.modelRoles = { default: "anthropic/claude-opus-5-5" };
      f.fake.usage = {
        reports: [{ provider: "anthropic", metadata: { email: "local*" }, windows: [] }],
        capacity: {},
      };
      const execute = f.fake.exec;
      f.fake.exec = (command, args, options) =>
        command === "herdr"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "Herdr unavailable" })
          : execute(command, args, options);
      const { instance } = extensionRuntime(root, f.fake, []);
      await mkdir(join(root, ".omp"), { recursive: true });
      await writeFile(
        join(root, ".omp", "projects.json"),
        JSON.stringify({ "local-repo": project }),
      );
      const result =
        operation === "models"
          ? await instance.runModels({ op: "list", view: "all", ...selector })
          : await instance.runUsage(selector);
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({
        machine: "local",
        session: null,
        configuration_context: { cwd: "project" in selector ? project : root },
        ...(operation === "models"
          ? {
              models: expect.arrayContaining([
                expect.objectContaining({ model: "anthropic/claude-opus-5-5" }),
              ]),
            }
          : {
              roles: { default: "anthropic/claude-opus-5-5" },
              providers: [
                expect.objectContaining({
                  provider: "anthropic",
                  accounts: [{ account: "local*", windows: [] }],
                }),
              ],
            }),
      });
    },
  );

  test.each([{ machine: "windows" }, { project: "windows-repo" }])(
    `registered ${operation} queries the helper without Herdr preflight for selector %j`,
    async (selector) => {
      const { root, project } = await fixtureRoot();
      const f = await machineFixture(root, project);
      const host = f.hosts.get("windows-ssh")!;
      host.herdrOffline = true;
      host.integrationUnavailable = true;
      const execute = f.fake.exec;
      f.fake.exec = (command, args, options) =>
        command === "herdr" && !(args[0] === "machine" && args[1] === "list")
          ? Promise.resolve({ code: 1, stdout: "", stderr: "Herdr unavailable" })
          : execute(command, args, options);
      const { instance } = extensionRuntime(root, f.fake, [], { spawnStdio: f.spawnStdio });
      await mkdir(join(root, ".omp"), { recursive: true });
      await writeFile(
        join(root, ".omp", "projects.json"),
        JSON.stringify({
          version: 2,
          roots: {},
          projects: {
            "windows-repo": {
              machine: "windows",
              path: `${host.root}\\repo`,
              pathKey: "repo",
              binding: { sshTarget: "windows-ssh", session: "agents", hostId: host.hostId },
            },
          },
        }),
      );
      const result =
        operation === "models"
          ? await instance.runModels({ op: "list", view: "all", ...selector })
          : await instance.runUsage(selector);
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({
        machine: "windows",
        os: "win32",
        session: "agents",
        configuration_context: { cwd: "project" in selector ? `${host.root}\\repo` : host.root },
        ...(operation === "models"
          ? {
              models: [
                expect.objectContaining({
                  model: `openai-codex/win32-only${"project" in selector ? "-project" : ""}`,
                }),
              ],
            }
          : {
              providers: [
                expect.objectContaining({
                  capacity: [{ window: "5h", accounts: 1, remaining_accounts: 0.73 }],
                }),
              ],
            }),
      });
    },
  );
}
