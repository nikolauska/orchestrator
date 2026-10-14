import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeExec } from "../src/runtime/host";
import { HostFailure } from "../src/runtime/host-paths";
import {
  PROTOCOL,
  validateHostRequest,
  type HelperConfiguration,
  type HostArgs,
  type HostOp,
  type HostRequest,
} from "../src/runtime/helper-protocol";
import { callHelper, readReportStream, readJsonLines } from "../src/runtime/remote";
import type { StdioSpawn } from "../src/runtime/shared";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function subprocessFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-stdio-"));
  roots.push(root);
  const projects = join(root, "projects");
  const runtimeRoot = join(root, "runtime");
  const neutralRoot = join(root, "neutral");
  await Promise.all([projects, runtimeRoot, neutralRoot].map((path) => mkdir(path)));
  const overlayPath = join(root, "worker config ü.yml");
  await writeFile(overlayPath, "unattended: true\n");
  const configuration: HelperConfiguration = {
    version: 1,
    hostId: randomUUID(),
    runtimeRoot,
    neutralRoot,
    overlayPath,
    queryCwd: projects,
    approvedProjectRoots: [projects],
    executables: {
      git: {
        executable: Bun.which("git")!,
        prefixArgs: [
          "-c",
          "user.name=Stdio fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          `core.hooksPath=${join(root, "no-hooks")}`,
        ],
      },
      treehouse: { executable: "treehouse", prefixArgs: [] },
      omp: { executable: "omp", prefixArgs: [] },
    },
  };
  const configurationPath = join(root, "helper.json");
  await writeFile(configurationPath, JSON.stringify(configuration));
  const controllerId = randomUUID();
  const request = <Op extends HostOp>(
    op: Op,
    args: HostArgs[Op],
    operationId?: string,
  ): HostRequest<Op> =>
    validateHostRequest({
      protocol: PROTOCOL,
      version: 1,
      requestId: randomUUID(),
      controllerId,
      expectedHostId: configuration.hostId,
      op,
      args,
      ...(operationId ? { operationId } : {}),
    }) as HostRequest<Op>;
  const target = {
    kind: "ssh" as const,
    hostId: configuration.hostId,
    sshTarget: "stdio-test-host",
  };
  const helperPath = fileURLToPath(new URL("../src/runtime/helper-entry.ts", import.meta.url));
  const spawnStdio: StdioSpawn = () => {
    const child = Bun.spawn([process.execPath, "run", helperPath, "--stdio-v1"], {
      env: { ...process.env, OMP_ORCHESTRATOR_HELPER_CONFIG: configurationPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdin: {
        write: (data) => {
          child.stdin.write(data);
        },
        end: () => {
          child.stdin.end();
        },
      },
      stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: child.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: child.exited,
      kill: () => child.kill(),
    };
  };
  return {
    root,
    projects,
    overlayPath,
    configuration,
    configurationPath,
    controllerId,
    request,
    target,
    spawnStdio,
  };
}

function failedPeer(stderr: string, code = 255, stdout = ""): StdioSpawn {
  return () => ({
    stdin: { write: () => {}, end: () => {} },
    stdout: (async function* () {
      if (stdout) yield Buffer.from(stdout);
    })(),
    stderr: (async function* () {
      yield Buffer.from(stderr);
    })(),
    exited: Promise.resolve(code),
    kill: () => {},
  });
}

describe("helper subprocess and transport", () => {
  test("real stdio subprocess creates Git path containing spaces, Unicode and metacharacters without shell interpretation", async () => {
    const f = await subprocessFixture();
    const payload = "project ü & % ! $ ; ' \" $(touch injected)";
    const path = join(
      f.projects,
      process.platform === "win32" ? payload.replaceAll('"', "") : payload,
    );
    const request = f.request(
      "project.create",
      { path, registrationId: randomUUID() },
      randomUUID(),
    );
    const result = await callHelper(f.target, request, { spawnStdio: f.spawnStdio });
    expect(result.project.path).toBe(path);
    const observed = await nativeExec("git", ["-C", path, "rev-parse", "HEAD"]);
    expect(observed.stdout.trim()).toBe(result.head);
    const snapshot = await callHelper(
      f.target,
      f.request("project.snapshot", {
        projectPath: path,
        tasks: [{ name: payload, kind: "scout" }],
      }),
      { spawnStdio: f.spawnStdio },
    );
    expect(snapshot.starts[payload]).toBe(result.head);
    await expect(access(join(f.root, "injected"))).rejects.toThrow();
    await expect(access(join(f.projects, "injected"))).rejects.toThrow();
    const repeated = await callHelper(
      f.target,
      { ...request, requestId: randomUUID() },
      { spawnStdio: f.spawnStdio },
    );
    expect(repeated).toEqual(result);
  });

  test("real subprocess streams exact large Unicode bytes and does not release an uncollected scout", async () => {
    const f = await subprocessFixture();
    const launchId = randomUUID();
    const resource = await callHelper(
      f.target,
      f.request(
        "worker.allocate",
        { scope: "independent", kind: "scout", launchId, forbiddenRoots: [] },
        randomUUID(),
      ),
      { spawnStdio: f.spawnStdio },
    );
    const bytes = Buffer.from("# Report ü\r\n" + "Payload 😀 % & ! $ ; \" '\r\n".repeat(9000));
    await writeFile(resource.reportSourcePath!, bytes);
    const chunks: Buffer[] = [];
    const end = await readReportStream(
      f.target,
      f.request("report.read", { launchId }),
      (frame) => {
        if (frame.type === "chunk") chunks.push(Buffer.from(frame.bytesBase64, "base64"));
      },
      { spawnStdio: f.spawnStdio },
    );
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(end.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    await expect(
      callHelper(
        f.target,
        f.request("worker.release", { launchId, proof: "closed", herdrClosed: true }, randomUUID()),
        { spawnStdio: f.spawnStdio },
      ),
    ).rejects.toMatchObject({ detail: { code: "REPORT_INVALID", effect: "none" } });
    expect(await readFile(resource.reportSourcePath!)).toEqual(bytes);
    await access(resource.directory.path);
  });

  test("missing helper, authentication and host keys are actionable; unidentified 255 is offline", async () => {
    const f = await subprocessFixture();
    const request = f.request("hello", { supportedVersions: [1] });
    await expect(
      callHelper(f.target, request, {
        spawnStdio: failedPeer("omp-orchestrator-helper: command not found", 127),
      }),
    ).rejects.toMatchObject({
      detail: { code: "PREREQUISITE_MISSING", remedy: expect.stringContaining("Manually install") },
    });
    await expect(
      callHelper(f.target, request, { spawnStdio: failedPeer("Permission denied (publickey).") }),
    ).rejects.toMatchObject({
      detail: { code: "SSH_AUTH", remedy: expect.stringContaining("ssh-add") },
    });
    await expect(
      callHelper(f.target, request, { spawnStdio: failedPeer("Host key verification failed.") }),
    ).rejects.toMatchObject({ detail: { code: "SSH_HOST_KEY" } });
    await expect(
      callHelper(f.target, request, { spawnStdio: failedPeer("connection closed") }),
    ).rejects.toMatchObject({ detail: { code: "TRANSPORT_OFFLINE" } });
    await expect(
      callHelper(f.target, request, {
        spawnStdio: () => {
          throw new Error("missing ssh.exe");
        },
      }),
    ).rejects.toMatchObject({ detail: { code: "PREREQUISITE_MISSING", channel: "controller" } });
  });

  test.each([
    ["Permission denied (publickey).", "SSH_AUTH"],
    ["Host key verification failed.", "SSH_HOST_KEY"],
    ["ssh: connect to host peer port 22: Connection refused", "TRANSPORT_OFFLINE"],
  ])("report stream preserves SSH failure classification: %s", async (diagnostic, code) => {
    const f = await subprocessFixture();
    await expect(
      readReportStream(f.target, f.request("report.read", { launchId: randomUUID() }), () => {}, {
        spawnStdio: failedPeer(diagnostic),
      }),
    ).rejects.toMatchObject({ detail: { code, effect: "none" } });
  });

  test.each([0, 255])(
    "truncated frames distinguish protocol failure from SSH exit %s",
    async (code) => {
      const f = await subprocessFixture();
      const spawnStdio = failedPeer("", code, '{"protocol":');
      await expect(
        callHelper(f.target, f.request("hello", { supportedVersions: [1] }), { spawnStdio }),
      ).rejects.toMatchObject({
        detail: { code: code === 255 ? "TRANSPORT_OFFLINE" : "PROTOCOL_MISMATCH", effect: "none" },
      });
      await expect(
        readReportStream(f.target, f.request("report.read", { launchId: randomUUID() }), () => {}, {
          spawnStdio,
        }),
      ).rejects.toMatchObject({
        detail: { code: code === 255 ? "TRANSPORT_OFFLINE" : "PROTOCOL_MISMATCH", effect: "none" },
      });
      await expect(
        callHelper(
          f.target,
          f.request(
            "worker.allocate",
            {
              scope: "independent",
              kind: "scout",
              launchId: randomUUID(),
              forbiddenRoots: [],
            },
            randomUUID(),
          ),
          { spawnStdio },
        ),
      ).rejects.toMatchObject({
        detail: {
          code: code === 255 ? "TRANSPORT_OFFLINE" : "PROTOCOL_MISMATCH",
          effect: "unknown",
          retry: "reconcile",
        },
      });
    },
  );

  test("stream failure observes a pending SSH exit before killing the peer", async () => {
    const f = await subprocessFixture();
    let killed = false;
    const spawnStdio: StdioSpawn = (...args) => ({
      ...failedPeer("Permission denied (publickey).")(...args),
      exited: new Promise<number>((resolve) => setImmediate(() => resolve(255))),
      kill() {
        killed = true;
      },
    });
    await expect(
      readReportStream(f.target, f.request("report.read", { launchId: randomUUID() }), () => {}, {
        spawnStdio,
      }),
    ).rejects.toMatchObject({ detail: { code: "SSH_AUTH" } });
    expect(killed).toBe(false);
  });

  test("SSH diagnostics classify a failed stream even while the peer is still running", async () => {
    const f = await subprocessFixture();
    let killed = false;
    const spawnStdio: StdioSpawn = (...args) => ({
      ...failedPeer("Host key verification failed.")(...args),
      exited: new Promise<number>(() => {}),
      kill() {
        killed = true;
      },
    });
    await expect(
      readReportStream(f.target, f.request("report.read", { launchId: randomUUID() }), () => {}, {
        spawnStdio,
      }),
    ).rejects.toMatchObject({ detail: { code: "SSH_HOST_KEY" } });
    expect(killed).toBe(true);
  });

  test.each([
    "hello",
    "worker.allocate",
    "delivery.land",
    "delivery.push",
    "project.create",
    "worker.release",
  ] as const)("%s uses a bounded deadline appropriate to its operation", async (op) => {
    const f = await subprocessFixture();
    const launchId = randomUUID();
    const args = {
      hello: { supportedVersions: [1] },
      "worker.allocate": { scope: "independent", kind: "scout", launchId, forbiddenRoots: [] },
      "delivery.land": {
        launchId,
        expectedBranch: "main",
        deliveryBase: "a".repeat(40),
        expectedWorkerHead: "b".repeat(40),
      },
      "delivery.push": { launchId, pushTo: "origin/topic", expectedWorkerHead: "b".repeat(40) },
      "project.create": { path: f.projects, registrationId: randomUUID() },
      "worker.release": { launchId, proof: "closed", herdrClosed: true },
    } satisfies { [Op in typeof op]: HostArgs[Op] };
    let killed = false;
    let settled = false;
    const spawnStdio: StdioSpawn = () => ({
      stdin: { write() {}, end() {} },
      // A peer that never writes keeps the exchange pending until its deadline fires.
      stdout: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.withResolvers<IteratorResult<Uint8Array>>().promise,
        }),
      },
      stderr: (async function* () {})(),
      exited: new Promise<number>(() => {}),
      kill() {
        killed = true;
      },
    });
    vi.useFakeTimers();
    try {
      const pending = callHelper(
        f.target,
        f.request(op, args[op], op === "hello" ? undefined : randomUUID()),
        { spawnStdio },
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await new Promise<void>(setImmediate);
      vi.advanceTimersByTime(120_000);
      await new Promise<void>(setImmediate);
      expect(settled).toBe(op === "hello");
      expect(killed).toBe(op === "hello");
      if (op !== "hello") vi.advanceTimersByTime(480_000);
      expect(await pending).toMatchObject({
        detail: {
          code: "TIMEOUT",
          effect: op === "hello" ? "none" : "unknown",
          retry: op === "hello" ? "read_only" : "reconcile",
        },
      });
      expect(killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("host mismatch and overlay mismatch refuse without allocating on the helper", async () => {
    const f = await subprocessFixture();
    const wrong = randomUUID();
    await expect(
      callHelper(
        { ...f.target, hostId: wrong },
        {
          ...f.request("path.validate", { path: f.projects, kind: "projects_root" }),
          expectedHostId: wrong,
        },
        { spawnStdio: f.spawnStdio },
      ),
    ).rejects.toMatchObject({ detail: { code: "HOST_MISMATCH", effect: "none" } });
    await expect(
      callHelper(
        f.target,
        f.request("preflight", { scope: "independent", requiredOverlaySha256: "0".repeat(64) }),
        { spawnStdio: f.spawnStdio },
      ),
    ).rejects.toMatchObject({
      detail: { code: "CONFIG_MISMATCH", remedy: expect.stringContaining("Manually") },
    });
    await rm(f.overlayPath);
    await expect(
      callHelper(
        f.target,
        f.request("preflight", { scope: "independent", requiredOverlaySha256: "0".repeat(64) }),
        { spawnStdio: f.spawnStdio },
      ),
    ).rejects.toMatchObject({ detail: { code: "PREREQUISITE_MISSING" } });
    await rm(f.configurationPath);
    await expect(
      callHelper(f.target, f.request("hello", { supportedVersions: [1] }), {
        spawnStdio: f.spawnStdio,
      }),
    ).rejects.toMatchObject({
      detail: {
        code: "PREREQUISITE_MISSING",
        effect: "none",
        remedy: expect.stringContaining("helper.json"),
      },
    });
  });

  test("transport loss after a mutation remains uncertain and is never resent", async () => {
    const f = await subprocessFixture();
    const operationId = randomUUID();
    const request = f.request(
      "worker.allocate",
      { scope: "independent", kind: "scout", launchId: randomUUID(), forbiddenRoots: [] },
      operationId,
    );
    await expect(
      callHelper(f.target, request, { spawnStdio: failedPeer("connection reset") }),
    ).rejects.toMatchObject({
      detail: { code: "TRANSPORT_OFFLINE", effect: "unknown", retry: "reconcile", operationId },
    });
    await expect(
      callHelper({ ...f.target, sshTarget: "-oProxyCommand=malicious" }, request, {
        spawnStdio: f.spawnStdio,
      }),
    ).rejects.toMatchObject({ detail: { code: "INVALID_REQUEST", effect: "none" } });
  });

  test("invalid framing, login banners, missing newline and oversized frames are refused", async () => {
    const collect = async (text: string, limit = 1024) => {
      const frames = [];
      for await (const frame of readJsonLines(
        (async function* () {
          yield Buffer.from(text);
        })(),
        limit,
      ))
        frames.push(frame);
      return frames;
    };
    await expect(collect("login banner\n")).rejects.toBeInstanceOf(HostFailure);
    await expect(collect('{"unfinished":true}')).rejects.toMatchObject({
      detail: { code: "PROTOCOL_MISMATCH" },
    });
    await expect(
      collect(JSON.stringify({ text: "x".repeat(100) }) + "\n", 50),
    ).rejects.toMatchObject({ detail: { code: "PROTOCOL_MISMATCH" } });
    await expect(collect("\n")).rejects.toMatchObject({ detail: { code: "PROTOCOL_MISMATCH" } });
  });
});
