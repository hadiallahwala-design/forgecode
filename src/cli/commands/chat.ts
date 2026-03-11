import process from "node:process";

import { readConfig } from "../../config/configStore.js";
import { runSettingsCommand } from "./config.js";
import { createProvider } from "../../providers/index.js";
import { ProviderRequestError } from "../../providers/types.js";
import { AgentRuntime } from "../../runtime/agentRuntime.js";
import { ToolExecutor } from "../../runtime/toolExecutor.js";
import { defaultTools } from "../../tools/index.js";
import { isResetRequestedError, TerminalUI } from "../../ui/terminal.js";

export async function runChatCommand(ui: TerminalUI): Promise<"reset" | void> {
  const config = await readConfig();
  if (!config) {
    ui.renderInfo("No configuration found. Run `forgecode config` first.");
    return;
  }

  const provider = createProvider(config);
  const toolExecutor = new ToolExecutor(defaultTools, ui, process.cwd());
  const runtime = new AgentRuntime(provider, toolExecutor, process.cwd());

  const renderMainScreen = async (): Promise<void> => {
    ui.renderHeader();
    await ui.renderEmptyProjectHint(process.cwd());
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
  await renderMainScreen();

  while (true) {
    let userMessage = "";
    try {
      userMessage = await ui.prompt("›");
    } catch (error) {
      if (isResetRequestedError(error)) {
        return "reset";
      }

      throw error;
    }

    if (!userMessage) {
      ui.renderInfo('Try asking something like:\n"Create a README for this project."');
      continue;
    }

    if (["exit", "quit"].includes(userMessage.trim().toLowerCase())) {
      ui.renderInfo("Session ended.");
      return;
    }

    ui.renderUserMessage(userMessage);
    ui.renderSpinnerStart();
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
            ui.renderToolEvent(`Running ${toolName}...`);
          },
          onToolEnd: (toolName, result) => {
            if (result.status === "validation_error") {
              ui.renderToolEvent(`${toolName} failed. Retrying...`);
              ui.renderSpinnerStart();
              return;
            }

            if (result.status === "cancelled") {
              ui.renderToolEvent(`${toolName} cancelled by user.`);
              ui.renderSpinnerStart();
              return;
            }

            if (result.status === "success") {
              ui.renderSuccess(result.summary);
              ui.renderSpinnerStart();
            }
          },
          onDebug: (message) => {
            ui.renderDebug(message);
          },
        },
      );
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        ui.renderProviderError(error);
        continue;
      }

      ui.renderSpinnerStop();
      throw error;
    }

    ui.renderSpinnerStop();
    ui.renderAssistantEnd();
    if (!response.streamed && response.message.trim()) {
      ui.renderAssistantStart();
      ui.renderAssistantToken(response.message);
      ui.renderAssistantEnd();
    }

    if (!response.message.trim()) {
      ui.renderInfo("No response generated.");
    }
  }
}
