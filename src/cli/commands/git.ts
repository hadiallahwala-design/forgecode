import process from "node:process";

import { readConfig } from "../../config/configStore.js";
import { ProjectIndexer } from "../../context/projectIndexer.js";
import { GitManager, GitOperationError } from "../../git/gitManager.js";
import { createProvider } from "../../providers/index.js";
import { ProviderRequestError } from "../../providers/types.js";
import { TerminalUI } from "../../ui/terminal.js";

function normalizeCommitMessage(message: string): string {
  return message
    .trim()
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .split("\n")[0]
    .trim();
}

async function createGitManager(): Promise<GitManager> {
  const workspaceRoot = await ProjectIndexer.detectProjectRoot(process.cwd());
  return new GitManager(workspaceRoot);
}

export async function runUndoCommand(ui: TerminalUI, count = 1): Promise<void> {
  const gitManager = await createGitManager();

  try {
    const result = await gitManager.undoLastAiCommit(count);
    if (result === "no_changes") {
      ui.renderInfo("No changes to undo.");
      return;
    }

    ui.renderInfo(
      count === 1 ? "Undid the most recent AI commit." : `Undid the most recent ${count} AI commits.`,
    );
  } catch (error) {
    const message =
      error instanceof GitOperationError
        ? error.message
        : "Git operation failed. Please check repository state.";
    ui.renderInfo(message);
  }
}

export async function runCommitCommand(ui: TerminalUI): Promise<void> {
  const config = await readConfig();
  if (!config) {
    ui.renderInfo("No configuration found. Run `forgecode config` first.");
    return;
  }

  const gitManager = await createGitManager();
  if (!(await gitManager.isRepository())) {
    ui.renderInfo("This project is not a Git repository.");
    return;
  }

  let snapshot = "";
  try {
    snapshot = await gitManager.getWorkingTreeSnapshot();
  } catch (error) {
    const message =
      error instanceof GitOperationError
        ? error.message
        : "Git operation failed. Please check repository state.";
    ui.renderInfo(message);
    return;
  }

  if (!snapshot.trim()) {
    ui.renderInfo("No changes to commit.");
    return;
  }

  const provider = createProvider(config);
  let suggestion = "";
  try {
    suggestion = normalizeCommitMessage(
      await provider.generateResponse(
        [
          "Generate a single concise conventional commit message for this git diff.",
          "Return only the commit message, no explanation.",
          "",
          snapshot.slice(0, 16_000),
        ].join("\n"),
      ),
    );
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      ui.renderProviderError(error);
      return;
    }

    ui.renderInfo("Failed to generate a commit message.");
    return;
  }

  if (!suggestion) {
    ui.renderInfo("Failed to generate a commit message.");
    return;
  }

  ui.renderInfo(`Suggested commit message:\n\n${suggestion}`);

  let commitMessage = suggestion;
  while (true) {
    const choice = await ui.select("Choose an action:", [
      { name: "accept", message: "[y] Accept" },
      { name: "edit", message: "[e] Edit" },
      { name: "cancel", message: "[n] Cancel" },
    ]);

    if (choice === "cancel") {
      ui.renderInfo("Commit cancelled.");
      return;
    }

    if (choice === "edit") {
      commitMessage = normalizeCommitMessage(await ui.prompt("Commit message", commitMessage));
      if (!commitMessage) {
        ui.renderInfo("Commit message cannot be empty.");
        commitMessage = suggestion;
      }
      continue;
    }

    break;
  }

  try {
    await gitManager.commitAllChanges(commitMessage);
    ui.renderInfo(`Committed changes with message:\n\n${commitMessage}`);
  } catch (error) {
    const message =
      error instanceof GitOperationError
        ? error.message
        : "Git operation failed. Please check repository state.";
    ui.renderInfo(message);
  }
}
