import { deleteFileTool } from "./deleteFileTool.js";
import { listFilesTool } from "./listFilesTool.js";
import { readFileTool } from "./readFileTool.js";
import { runCommandTool } from "./runCommandTool.js";
import type { ToolDefinition } from "./types.js";
import { writeFileTool } from "./writeFileTool.js";

export const defaultTools: Array<ToolDefinition<any>> = [
  readFileTool,
  writeFileTool,
  deleteFileTool,
  listFilesTool,
  runCommandTool,
];
