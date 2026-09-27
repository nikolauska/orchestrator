import { readFile } from "node:fs/promises";
import { stringAt, valueAt } from "./shared";

export async function lastResponse(sessionPath: string): Promise<string | undefined> {
  const lines = (await readFile(sessionPath, "utf8")).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const text = responseText(lines[index]!);
    if (text) return text;
  }
  return undefined;
}

function responseText(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // OMP may still be appending the final line.
    return undefined;
  }
  if (stringAt(entry, ["type"]) !== "message") return undefined;
  if (stringAt(entry, ["message", "role"]) !== "assistant") return undefined;
  const content = valueAt(entry, ["message", "content"]);
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    const text = stringAt(part, ["type"]) === "text" ? stringAt(part, ["text"])?.trim() : undefined;
    return text ? [text] : [];
  });
  return parts.length ? parts.join("\n\n") : undefined;
}
