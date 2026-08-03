import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionsDir = fileURLToPath(new URL("../.omp/extensions/", import.meta.url));

test("every discovered extension exports a factory", async () => {
	const entries = await readdir(extensionsDir, { withFileTypes: true });
	// The loader chooses extension modules from the directory at runtime.
	const factories = await Promise.all(entries.filter(entry => entry.isFile() && /\.(?:ts|js)$/.test(entry.name)).map(async entry => typeof (await import(pathToFileURL(join(extensionsDir, entry.name)).href)).default));
	expect(factories).not.toHaveLength(0);
	expect(factories).toEqual(factories.map(() => "function"));
});
