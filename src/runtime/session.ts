import { readFile } from "node:fs/promises";
import { stringAt, valueAt } from "./shared";

/** Final assistant text of an OMP session, a Claude Code transcript or a Codex session. */
export async function lastResponse(sessionPath: string): Promise<string | undefined> {
  const lines = (await readFile(sessionPath, "utf8")).split("\n");
  let message: string | undefined;
  let parts: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const response = responseOf(lines[index]!);
    if (!response) continue;
    // Claude Code writes one line per content block; blocks of one message share its ID.
    if (parts.length && (!message || response.message !== message)) break;
    if (response.texts.length) {
      message ??= response.message;
      parts = [...response.texts, ...parts];
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

function responseOf(line: string): { message?: string; texts: string[] } | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // The agent may still be appending the final line.
    return undefined;
  }
  const type = stringAt(entry, ["type"]);
  // Codex closes each turn with an event carrying that turn's final answer.
  if (type === "event_msg" && stringAt(entry, ["payload", "type"]) === "task_complete") {
    const text = stringAt(entry, ["payload", "last_agent_message"])?.trim();
    return { texts: text ? [text] : [] };
  }
  // OMP writes {type:"message"}; Claude Code writes {type:"assistant"} and marks subagent lines.
  if (type !== "message" && type !== "assistant") return undefined;
  if (valueAt(entry, ["isSidechain"]) === true) return undefined;
  if (stringAt(entry, ["message", "role"]) !== "assistant") return undefined;
  const content = valueAt(entry, ["message", "content"]);
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((part) => {
    const text = stringAt(part, ["type"]) === "text" ? stringAt(part, ["text"])?.trim() : undefined;
    return text ? [text] : [];
  });
  return { message: type === "assistant" ? stringAt(entry, ["message", "id"]) : undefined, texts };
}
