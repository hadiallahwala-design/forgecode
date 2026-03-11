import type { ProjectIndexer } from "../context/projectIndexer.js";
import type { ToolExecutionSession } from "../runtime/toolExecutionSession.js";
import type { z } from "zod";

export interface ToolContext {
  workspaceRoot: string;
  projectIndexer: ProjectIndexer;
  executionSession: ToolExecutionSession;
}

export interface ToolResult {
  summary: string;
  data?: string;
  details?: string;
  status?: "success" | "validation_error" | "cancelled";
}

export interface ToolDefinition<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  requiresConfirmation?: boolean;
  confirmMessage?: (input: TInput) => string;
  handler: (input: TInput, context: ToolContext) => Promise<ToolResult>;
}
