import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { SYSTEM_PROMPT } from "../agent/systemPrompt.js";

export interface ConversationEntry {
  role: "user" | "assistant" | "tool";
  content: string;
}

const TREE_IGNORE = new Set([".git", "dist", "node_modules"]);

async function buildFileTree(
  rootDir: string,
  currentDir: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (TREE_IGNORE.has(entry.name)) {
      continue;
    }

    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      lines.push(`${"  ".repeat(depth)}- ${relativePath}/`);
      if (depth < maxDepth) {
        await buildFileTree(rootDir, absolutePath, depth + 1, maxDepth, lines);
      }
      continue;
    }

    lines.push(`${"  ".repeat(depth)}- ${relativePath}`);
  }
}

export async function buildPrompt(
  workspaceRoot: string,
  history: ConversationEntry[],
): Promise<string> {
  const treeLines: string[] = [];
  await buildFileTree(workspaceRoot, workspaceRoot, 0, 2, treeLines);

  const historyBlock = history
    .map((entry) => `[${entry.role.toUpperCase()}]\n${entry.content}`)
    .join("\n\n");

  return [
    SYSTEM_PROMPT,
    `Workspace root: ${workspaceRoot}`,
    "File tree:",
    treeLines.length > 0 ? treeLines.join("\n") : "- <empty workspace>",
    "Conversation history:",
    historyBlock,
  ].join("\n\n");
}
