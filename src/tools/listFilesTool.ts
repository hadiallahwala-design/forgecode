import { z } from "zod";

import { WorkspaceGuard } from "../runtime/workspace.js";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  path: z.string().default("."),
  max_depth: z.coerce.number().int().min(0).max(6).default(3),
});

export const listFilesTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "list_files",
  description: "List files and directories under the current workspace.",
  inputSchema: schema,
  async handler(input, context) {
    const guard = new WorkspaceGuard(context.workspaceRoot);
    guard.resolvePath(input.path);
    const files = context.executionSession.getVisibleFiles(input.path, input.max_depth);

    return {
      summary: `Listed files under ${input.path}`,
      data: files.join("\n"),
    };
  },
};
