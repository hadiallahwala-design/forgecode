import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { z } from "zod";

import { WorkspaceGuard } from "../runtime/workspace.js";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  path: z.string().default("."),
  max_depth: z.coerce.number().int().min(0).max(6).default(3),
});

const IGNORED_NAMES = new Set([".git", "dist", "node_modules"]);

async function collectFiles(
  basePath: string,
  rootPath: string,
  maxDepth: number,
  currentDepth = 0,
): Promise<string[]> {
  const entries = await readdir(basePath, { withFileTypes: true });
  const output: string[] = [];

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = join(basePath, entry.name);
    const relativePath = relative(rootPath, absolutePath) || ".";

    if (entry.isDirectory()) {
      output.push(`${relativePath}/`);

      if (currentDepth < maxDepth) {
        const nested = await collectFiles(absolutePath, rootPath, maxDepth, currentDepth + 1);
        output.push(...nested);
      }

      continue;
    }

    output.push(relativePath);
  }

  return output.sort((left, right) => left.localeCompare(right));
}

export const listFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "list_files",
  description: "List files and directories under the current workspace.",
  inputSchema: schema,
  async handler(input, context) {
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const absolutePath = guard.resolvePath(input.path);
    const files = await collectFiles(absolutePath, context.workspaceRoot, input.max_depth);

    return {
      summary: `Listed files under ${input.path}`,
      data: files.join("\n"),
    };
  },
};
