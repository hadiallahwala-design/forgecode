import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { z } from "zod";

import { WorkspaceGuard } from "../runtime/workspace.js";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const writeFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "write_file",
  description: "Write a UTF-8 text file inside the current workspace.",
  inputSchema: schema,
  requiresConfirmation: true,
  confirmMessage: (input) => `Write changes to ${input.path}?`,
  async handler(input, context) {
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const absolutePath = guard.resolvePath(input.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, "utf8");

    return {
      summary: `Wrote ${relative(context.workspaceRoot, absolutePath)}`,
    };
  },
};
