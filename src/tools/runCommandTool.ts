import { spawn } from "node:child_process";

import { z } from "zod";

import type { ToolDefinition, ToolResult } from "./types.js";
import { truncateText } from "../utils/text.js";

const schema = z.object({
  command: z.string().min(1),
});

export const runCommandTool: ToolDefinition<z.infer<typeof schema>> = {
  name: "run_command",
  description: "Run a shell command inside the workspace.",
  inputSchema: schema,
  requiresConfirmation: true,
  confirmMessage: (input) => `Run this command in the project directory?\n${input.command}`,
  async handler(input, context): Promise<ToolResult> {
    return await new Promise<ToolResult>((resolve, reject) => {
      const child = spawn(input.command, {
        cwd: context.workspaceRoot,
        shell: true,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          summary: `Command finished with exit code ${exitCode ?? 0}`,
          data: truncateText(
            [`STDOUT:\n${stdout.trim()}`, `STDERR:\n${stderr.trim()}`].join("\n\n").trim(),
          ),
        });
      });
    });
  },
};
