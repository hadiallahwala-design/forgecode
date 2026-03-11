import type { ProjectIndexer } from "../context/projectIndexer.js";
import type { PermissionHandler } from "./permissions.js";
import { ToolExecutionSession, type PendingFileChange } from "./toolExecutionSession.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { AgentMode } from "./agentRuntime.js";
import { ZodError } from "zod";

interface ToolExecutionOptions {
  mode?: AgentMode;
}

function isFilesystemAccessError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["EPERM", "EACCES", "ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code));
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
  private currentSession: ToolExecutionSession | null = null;

  public constructor(
    toolDefinitions: Array<ToolDefinition<any>>,
    private readonly permissionHandler: PermissionHandler,
    private readonly workspaceRoot: string,
    private readonly projectIndexer: ProjectIndexer,
  ) {
    this.tools = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  }

  public beginRequest(): void {
    this.currentSession = new ToolExecutionSession(this.workspaceRoot, this.projectIndexer);
  }

  public peekPendingChanges(): PendingFileChange[] {
    return this.currentSession?.peekPendingChanges() ?? [];
  }

  public getModifiedFiles(): string[] {
    return this.currentSession?.getModifiedFiles() ?? [];
  }

  public clearPendingChanges(): void {
    this.currentSession?.clearPendingChanges();
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

    let result: ToolResult;
    try {
      if (!this.currentSession) {
        throw new Error("No active tool execution session.");
      }

      result = await tool.handler(parsedInput, {
        workspaceRoot: this.workspaceRoot,
        projectIndexer: this.projectIndexer,
        executionSession: this.currentSession,
      });
    } catch (error) {
      return {
        summary: isFilesystemAccessError(error)
          ? "Tool call failed because the file or directory could not be accessed."
          : `${toolName} failed during execution.`,
        data: "",
        details: error instanceof Error ? error.message : String(error),
        status: "validation_error",
      };
    }

    return {
      status: "success",
      ...result,
    };
  }
}
