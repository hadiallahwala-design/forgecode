import { rm } from "node:fs/promises";
import { relative } from "node:path";

import { z } from "zod";

import { WorkspaceGuard } from "../runtime/workspace.js";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  path: z.string().min(1),
});

export async function applyFileDelete(absolutePath: string): Promise<void> {
  await rm(absolutePath, { force: true });
}

export const deleteFileTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "delete_file",
  description: "Delete a file inside the current workspace.",
  inputSchema: schema,
  requiresConfirmation: true,
  confirmMessage: (input) => `Delete ${input.path}?`,
  async handler(input, context) {
    const guard = new WorkspaceGuard(context.workspaceRoot);
    const absolutePath = guard.resolvePath(input.path);
    await context.executionSession.stageDelete(absolutePath);

    return {
      summary: `Prepared deletion of ${relative(context.workspaceRoot, absolutePath)}`,
    };
  },
};
