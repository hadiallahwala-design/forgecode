import process from "node:process";

import { readConfig } from "../../config/configStore.js";
import { runSettingsCommand } from "./config.js";
import { ProjectMemoryManager } from "../../context/projectMemory.js";
import { ProjectIndexer } from "../../context/projectIndexer.js";
import { GitManager, GitOperationError } from "../../git/gitManager.js";
import { createProvider } from "../../providers/index.js";
import { ProviderRequestError } from "../../providers/types.js";
import { AgentRuntime } from "../../runtime/agentRuntime.js";
import { ToolExecutor } from "../../runtime/toolExecutor.js";
import type { PendingFileChange } from "../../runtime/toolExecutionSession.js";
import { defaultTools } from "../../tools/index.js";
import { applyFileDelete } from "../../tools/deleteFileTool.js";
import { applyFileWrite } from "../../tools/writeFileTool.js";
import { isResetRequestedError, TerminalUI } from "../../ui/terminal.js";

const SLASH_COMMANDS: Record<string, string> = {
  "/explain": "Explain this project, its structure, and the most important files.",
  "/fix": "Find and fix issues in the relevant code for this project.",
  "/refactor": "Refactor the relevant code to improve structure and readability while preserving behavior.",
  "/test": "Add or update tests for the relevant modules in this project.",
};

function buildCommitMessage(userMessage: string): string {
  const normalized = userMessage.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  const fragment = normalized.length > 0 ? normalized : "apply changes";
  return `forge: ${fragment.slice(0, 70)}`;
}

async function syncGitStatus(ui: TerminalUI, gitManager: GitManager): Promise<void> {
  try {
    const status = await gitManager.getStatus();
    ui.setGitStatusLine(gitManager.formatStatusLine(status));
  } catch {
    ui.setGitStatusLine("branch: unavailable");
  }
}

async function safeMemoryOperation(ui: TerminalUI, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    ui.renderInfo("Project memory is unavailable. Continuing without persistence.");
  }
}

async function ensureRepository(ui: TerminalUI, gitManager: GitManager): Promise<void> {
  const isRepository = await gitManager.isRepository();
  if (isRepository) {
    return;
  }

  ui.renderInfo("This project is not a Git repository.");
  const initializeGit = await ui.confirmSelection("Initialize Git?", "Yes", "No", "yes");
  if (!initializeGit) {
    return;
  }

  try {
    await gitManager.initializeRepository();
    ui.renderInfo("Git repository initialized.");
  } catch (error) {
    const message =
      error instanceof GitOperationError
        ? error.message
        : "Git operation failed. Please check repository state.";
    ui.renderInfo(message);
  }
}

async function applyPendingWrites(
  ui: TerminalUI,
  gitManager: GitManager,
  projectIndexer: ProjectIndexer,
  projectMemory: ProjectMemoryManager,
  userMessage: string,
  pendingChanges: PendingFileChange[],
): Promise<"applied" | "cancelled"> {
  let preview;
  try {
    preview = await gitManager.buildDiffPreview(
      pendingChanges.map((change) => ({
        kind: change.kind,
        path: change.path,
        absolutePath: change.absolutePath,
        content: change.content,
        previousContent: change.previousContent,
      })),
    );
  } catch (error) {
    const message =
      error instanceof GitOperationError
        ? error.message
        : "Git operation failed. Please check repository state.";
    ui.renderInfo(message);
    return "cancelled";
  }
  const decision = await ui.reviewDiffPreview(preview.summaryLines, preview.diff);
  if (decision === "cancel") {
    return "cancelled";
  }

  const isRepository = await gitManager.isRepository();
  if (isRepository && pendingChanges.length > 1) {
    try {
      await gitManager.ensureForgeBranch(userMessage);
      await syncGitStatus(ui, gitManager);
    } catch (error) {
      const message =
        error instanceof GitOperationError
          ? error.message
          : "Git operation failed. Please check repository state.";
      ui.renderInfo(message);
    }
  }

  for (const change of pendingChanges) {
    if (change.kind === "delete") {
      await applyFileDelete(change.absolutePath);
    } else {
      await applyFileWrite(change.absolutePath, change.content ?? "");
    }
    await projectIndexer.refreshPath(change.path);
  }

  if (isRepository) {
    try {
      const commitMessage = buildCommitMessage(userMessage);
      await gitManager.commitFiles(commitMessage, pendingChanges.map((change) => change.path));
      await safeMemoryOperation(ui, async () => {
        await projectMemory.recordRecentChange(
          userMessage,
          pendingChanges.map((change) => change.path),
          commitMessage,
        );
      });
      ui.renderSuccess(`Committed ${pendingChanges.length} file ${pendingChanges.length === 1 ? "change" : "changes"}.`);
    } catch (error) {
      const message =
        error instanceof GitOperationError
          ? error.message
          : "Git operation failed. Please check repository state.";
      ui.renderInfo(message);
    }
  }

  if (!isRepository) {
    await safeMemoryOperation(ui, async () => {
      await projectMemory.recordRecentChange(
        userMessage,
        pendingChanges.map((change) => change.path),
      );
    });
  }

  await safeMemoryOperation(ui, async () => {
    await projectMemory.refreshFromIndexer(projectIndexer);
  });
  await syncGitStatus(ui, gitManager);
  return "applied";
}

function formatModifiedFiles(files: string[]): string {
  return [`Files modified:`, ...files.map((file) => `• ${file}`)].join("\n");
}

function expandSlashCommand(input: string): { kind: "prompt"; value: string } | { kind: "history" } {
  const trimmed = input.trim();
  if (trimmed === "/history") {
    return { kind: "history" };
  }

  for (const [command, expanded] of Object.entries(SLASH_COMMANDS)) {
    if (trimmed === command) {
      return { kind: "prompt", value: expanded };
    }

    if (trimmed.startsWith(`${command} `)) {
      const rest = trimmed.slice(command.length).trim();
      return {
        kind: "prompt",
        value: `${expanded}\n\nAdditional context:\n${rest}`,
      };
    }
  }

  return { kind: "prompt", value: input };
}

export async function runChatCommand(ui: TerminalUI): Promise<"reset" | void> {
  const config = await readConfig();
  if (!config) {
    ui.renderInfo("No configuration found. Run `forgecode config` first.");
    return;
  }

  const workspaceRoot = await ProjectIndexer.detectProjectRoot(process.cwd());
  const gitManager = new GitManager(workspaceRoot);
  await ensureRepository(ui, gitManager);
  await syncGitStatus(ui, gitManager);

  const projectMemory = new ProjectMemoryManager(workspaceRoot);
  ui.renderInfo("Indexing project...");
  const projectIndexer = new ProjectIndexer(workspaceRoot, {
    onIndexChange: async (indexer) => {
      await projectMemory.persistIndex(indexer);
    },
  });
  const indexedFileCount = await projectIndexer.initialize();
  ui.renderInfo(`Indexed ${indexedFileCount} files.`);
  await safeMemoryOperation(ui, async () => {
    await projectMemory.initialize(projectIndexer);
  });

  const provider = createProvider(config);
  const toolExecutor = new ToolExecutor(defaultTools, ui, workspaceRoot, projectIndexer);
  const runtime = new AgentRuntime(provider, toolExecutor, projectIndexer, projectMemory);

  const renderMainScreen = async (): Promise<void> => {
    ui.renderHeader();
    await ui.renderEmptyProjectHint(projectIndexer.hasIndexedFiles());
  };

  ui.setMainScreenRenderer(renderMainScreen);
  ui.setSettingsOverlayHandler(async () => {
    const result = await runSettingsCommand(ui);
    if (result === "reset") {
      return "reset";
    }

    await renderMainScreen();
    return "continue";
  });
  try {
    await renderMainScreen();
    const queuedMessages: string[] = [];

    while (true) {
      let userMessage = "";
      if (queuedMessages.length > 0) {
        userMessage = queuedMessages.shift() ?? "";
      } else {
        try {
          userMessage = await ui.prompt("›");
        } catch (error) {
          if (isResetRequestedError(error)) {
            return "reset";
          }

          throw error;
        }
      }

      if (!userMessage) {
        ui.renderInfo('Try asking something like:\n"Create a README for this project."');
        continue;
      }

      const expanded = expandSlashCommand(userMessage);
      if (expanded.kind === "history") {
        await ui.showConversationHistory();
        continue;
      }
      userMessage = expanded.value;

      if (["exit", "quit"].includes(userMessage.trim().toLowerCase())) {
        ui.renderInfo("Session ended.");
        return;
      }

      const relevantHints = projectIndexer.suggestRelevantFiles(userMessage, 3);
      ui.renderContextSuggestion(relevantHints);
      ui.renderUserMessage(userMessage);
      ui.renderSpinnerStart("ForgeCode is thinking...");
      const usedTools: string[] = [];
      const shouldCaptureQueue = ui.getMode() !== "APPROVAL";
      if (shouldCaptureQueue) {
        ui.startQueueCapture((queuedMessage) => {
          queuedMessages.push(queuedMessage);
          ui.renderInfo(`Queued prompt (${queuedMessages.length}): ${queuedMessage}`);
        });
      }
      let response;
      try {
        response = await runtime.processUserMessage(
          userMessage,
          { mode: ui.getMode() },
          {
            onAssistantToken: (token) => {
              ui.renderAssistantStart();
              ui.renderAssistantToken(token);
            },
            onToolStart: (toolName) => {
              usedTools.push(toolName);
            },
            onToolEnd: (toolName, result) => {
              if (result.status === "validation_error") {
                return;
              }

              if (result.status === "cancelled") {
                return;
              }
            },
            onDebug: (message) => {
              ui.renderDebug(message);
            },
          },
        );
      } catch (error) {
        ui.stopQueueCapture();
        if (error instanceof ProviderRequestError) {
          ui.renderProviderError(error);
          continue;
        }

        ui.renderSpinnerStop();
        throw error;
      }
      ui.stopQueueCapture();

      ui.renderSpinnerStop();
      ui.renderToolSummary(usedTools.filter((tool) => !tool.includes(":")));

      const pendingChanges = toolExecutor.peekPendingChanges();
      if (pendingChanges.length > 0) {
        const modifiedFiles = toolExecutor.getModifiedFiles();
        const workflowResult = await applyPendingWrites(
          ui,
          gitManager,
          projectIndexer,
          projectMemory,
          userMessage,
          pendingChanges,
        );
        toolExecutor.clearPendingChanges();

        if (workflowResult === "cancelled") {
          ui.renderInfo("Cancelled proposed changes. No files were modified.");
          continue;
        }

        ui.renderInfo(formatModifiedFiles(modifiedFiles));
      }

      ui.renderAssistantEnd();
      if (!response.streamed && response.message.trim()) {
        ui.renderAssistantMessage(response.message);
      } else if (response.message.trim()) {
        ui.recordAssistantMessage(response.message);
      }

      if (!response.message.trim()) {
        ui.renderInfo("No response generated.");
      }
    }
  } finally {
    projectIndexer.close();
  }
}
