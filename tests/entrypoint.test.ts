import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import extension from "../.omp/extensions/entrypoint";
const extensionsDir = fileURLToPath(new URL("../.omp/extensions/", import.meta.url));

test("every discovered extension exports a factory", async () => {
	const entries = await readdir(extensionsDir, { withFileTypes: true });
	// The loader chooses extension modules from the directory at runtime.
	const factories = await Promise.all(entries.filter(entry => entry.isFile() && /\.(?:ts|js)$/.test(entry.name)).map(async entry => typeof (await import(pathToFileURL(join(extensionsDir, entry.name)).href)).default));
	expect(factories).not.toHaveLength(0);
	expect(factories).toEqual(factories.map(() => "function"));
});


test("loads with the extension's Zod facade", () => {
	interface Schema {
		optional(): Schema;
		strict(): Schema;
		min(_value: number): Schema;
		max(_value: number): Schema;
	}
	const schemas = (): Schema => ({ optional: schemas, strict: schemas, min: schemas, max: schemas });
	const z = { string: schemas, literal: (_value: unknown) => schemas(), object: (_shape: unknown) => schemas(), array: (_item: unknown) => schemas(), union: (_options: unknown[]) => schemas() };
	const tools: { name: string }[] = [];
	const pi = {
		zod: { z },
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		sendMessage: async () => {},
		logger: {},
		registerTool: (tool: { name: string }) => tools.push(tool),
		on: () => {},
	};
	// This facade intentionally omits discriminatedUnion, matching the extension host.
	extension(pi as unknown as Parameters<typeof extension>[0]);
	expect(tools.map(tool => tool.name)).toEqual(["projects", "task", "workers", "reports"]);
});