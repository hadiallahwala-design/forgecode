import type { PermissionHandler } from "./permissions.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { AgentMode } from "./agentRuntime.js";
import { ZodError } from "zod";

interface ToolExecutionOptions {
  mode?: AgentMode;
}

function formatValidationDetails(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "Invalid tool inputs.";
  }

  const fieldName = issue.path[0];
  if (issue.code === "invalid_type" && issue.received === "undefined" && fieldName) {
    return `Missing required input ${String(fieldName).toUpperCase()}.`;
  }

  if (fieldName) {
    return `Invalid input ${String(fieldName).toUpperCase()}: ${issue.message}.`;
  }

  return issue.message;
}

export class ToolExecutor {
  private readonly tools: Map<string, ToolDefinition<any>>;

  public constructor(
    toolDefinitions: Array<ToolDefinition<any>>,
    private readonly permissionHandler: PermissionHandler,
    private readonly workspaceRoot: string,
  ) {
    this.tools = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  }

  public async execute(
    toolName: string,
    rawInput: Record<string, string>,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    let parsedInput: any;
    try {
      parsedInput = tool.inputSchema.parse(rawInput);
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          summary: "Tool call failed because required inputs were missing or invalid.",
          data: "",
          details: formatValidationDetails(error),
          status: "validation_error",
        };
      }

      throw error;
    }

    const mode = options.mode ?? "APPROVAL";
    const shouldConfirm =
      mode === "APPROVAL"
        ? true
        : mode === "AUTO"
          ? toolName === "run_command"
          : Boolean(tool.requiresConfirmation);

    if (shouldConfirm) {
      const message =
        mode === "APPROVAL"
          ? `Proposed action: ${toolName}\n\nApprove? (y/n)`
          : (tool.confirmMessage?.(parsedInput) ?? `Allow ${toolName}?`);
      const allowed = await this.permissionHandler.confirm(message);

      if (!allowed) {
        return {
          summary: `${toolName} was cancelled by the user.`,
          status: "cancelled",
        };
      }
    }

    const result = await tool.handler(parsedInput, { workspaceRoot: this.workspaceRoot });
    return {
      status: "success",
      ...result,
    };
  }
}
