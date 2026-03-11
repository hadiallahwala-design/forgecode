import { SYSTEM_PROMPT } from "../agent/systemPrompt.js";
import type { ProjectMemoryManager } from "./projectMemory.js";
import type { ProjectIndexer } from "./projectIndexer.js";

export interface ConversationEntry {
  role: "user" | "assistant" | "tool";
  content: string;
}

function buildHistoryBlock(history: ConversationEntry[]): string {
  return history.map((entry) => `[${entry.role.toUpperCase()}]\n${entry.content}`).join("\n\n");
}

export async function buildPrompt(
  projectIndexer: ProjectIndexer,
  projectMemory: ProjectMemoryManager,
  history: ConversationEntry[],
): Promise<string> {
  const treeLines = projectIndexer.buildFileTree(2);
  const latestUserMessage =
    [...history].reverse().find((entry) => entry.role === "user")?.content ?? "";
  const contextFiles = await projectIndexer.selectContextFiles(latestUserMessage);
  const contextBlock = contextFiles
    .map(({ file, content }) => `File: ${file.path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  return [
    SYSTEM_PROMPT,
    `Workspace root: ${projectIndexer.getProjectRoot()}`,
    "Project memory:",
    projectMemory.buildPromptContext(),
    "Indexed file tree:",
    treeLines.length > 0 ? treeLines.join("\n") : "- <empty workspace>",
    "Relevant files:",
    contextBlock || "<none selected>",
    "Conversation history:",
    buildHistoryBlock(history),
  ].join("\n\n");
}
