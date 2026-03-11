import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { z } from "zod";

import { WorkspaceGuard } from "../runtime/workspace.js";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  path: z.string().min(1),
});

export const readFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "read_file",
  description: "Read a UTF-8 text file from the current workspace.",
  inputSchema: schema,
  async handler(input, context) {
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const absolutePath = guard.resolvePath(input.path);
    const content = await readFile(absolutePath, "utf8");

    return {
      summary: `Read ${relative(context.workspaceRoot, absolutePath)}`,
      data: content,
    };
  },
};
