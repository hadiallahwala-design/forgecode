import process from "node:process";

import { runChatCommand } from "./commands/chat.js";
import { runConfigCommand, runSettingsCommand } from "./commands/config.js";
import { readConfig } from "../config/configStore.js";
import { isExitRequestedError, TerminalUI } from "../ui/terminal.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const command = args.find((arg) => !arg.startsWith("--"));
  const ui = new TerminalUI({ debug });

  if (command === "config") {
    await runConfigCommand(ui);
    return;
  }

  if (command === "settings") {
    const result = await runSettingsCommand(ui);
    if (result !== "reset") {
      return;
    }

    process.stdout.write("\x1Bc");
    ui.renderInfo("Configuration reset successfully.\n\nStarting setup wizard...");
    await runConfigCommand(ui, { firstRun: true });
    process.stdout.write("\x1Bc");
  }

  while (true) {
    const config = await readConfig();
    if (!config) {
      await runConfigCommand(ui, { firstRun: true });
      process.stdout.write("\x1Bc");
    }

    const result = await runChatCommand(ui);
    if (result !== "reset") {
      return;
    }

    process.stdout.write("\x1Bc");
    ui.renderInfo("Configuration reset successfully.\n\nStarting setup wizard...");
    await runConfigCommand(ui, { firstRun: true });
    process.stdout.write("\x1Bc");
  }
}

main().catch((error) => {
  if (isExitRequestedError(error)) {
    process.exitCode = 0;
    return;
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
