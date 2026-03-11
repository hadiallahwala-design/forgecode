import process from "node:process";
import { readdir } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";

import chalk from "chalk";
import enquirer from "enquirer";

import type { PermissionHandler } from "../runtime/permissions.js";
import type { AgentMode } from "../runtime/agentRuntime.js";
import type { ProviderRequestError } from "../providers/types.js";

const ConfirmPrompt = (enquirer as any).Confirm;
const PasswordPrompt = (enquirer as any).Password;
const InputPrompt = (enquirer as any).Input;
const SelectPrompt = (enquirer as any).Select;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT_HINTS = [
  "Create a README file",
  "Explain this project",
  "Fix errors in main.py",
  "Generate a Python script",
];
const MODE_ORDER: AgentMode[] = ["PLAN", "APPROVAL", "AUTO"];
const SUBTLE = chalk.hex("#7a8699");
const FULL_SHORTCUT_ITEMS = ["Ctrl+Q Quit", "Ctrl+O Settings", "Ctrl+H Help", "Ctrl+L Clear", "Tab Mode"];
const MEDIUM_SHORTCUT_ITEMS = ["Ctrl+Q Quit", "Ctrl+O Settings", "Ctrl+H Help", "Tab Mode"];
const COMPACT_SHORTCUT_ITEMS = ["Ctrl+Q Quit", "Ctrl+O Settings", "Ctrl+H Help"];

class ExitRequestedError extends Error {
  public constructor() {
    super("Exit requested.");
  }
}

class ResetRequestedError extends Error {
  public constructor() {
    super("Reset requested.");
  }
}

interface TerminalUIOptions {
  debug?: boolean;
}

interface PromptSessionResult {
  action: "submit" | "help" | "settings" | "clear" | "quit" | "mode" | "abort";
  value: string;
}

interface SelectChoice {
  name: string;
  message: string;
  hint?: string;
}

interface SelectOptions {
  initial?: string;
}

type MainScreenRenderer = (() => Promise<void> | void) | null;
type SettingsOverlayHandler = (() => Promise<"continue" | "reset">) | null;

export class TerminalUI implements PermissionHandler {
  private assistantStreaming = false;
  private readonly debugEnabled: boolean;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrameIndex = 0;
  private spinnerText = "thinking...";
  private spinnerVisible = false;
  private promptCount = 0;
  private mainScreenRenderer: MainScreenRenderer = null;
  private settingsOverlayHandler: SettingsOverlayHandler = null;
  private mode: AgentMode = "APPROVAL";

  public constructor(options: TerminalUIOptions = {}) {
    this.debugEnabled = options.debug ?? false;
  }

  public renderHeader(): void {
    const title = chalk.bold.hex("#ff8a00")("ForgeCode");
    const separator = chalk.hex("#7a8699")("•");
    const subtitle = chalk.hex("#7a8699")("AI Coding Assistant");
    process.stdout.write(`\n${title} ${separator} ${subtitle}\n\n`);
    process.stdout.write(`${chalk.white("Ask me to create files, edit code, or explain projects.")}\n\n`);
    process.stdout.write(`${chalk.white("Examples:")}\n`);
    process.stdout.write(`${SUBTLE("• Create a README file")}\n`);
    process.stdout.write(`${SUBTLE("• Explain this project")}\n`);
    process.stdout.write(`${SUBTLE("• Fix errors in main.py")}\n\n`);
    process.stdout.write(`${chalk.white("Keyboard shortcuts:")}\n`);
    process.stdout.write(`${this.getFooterText()}\n`);
  }

  public renderWelcomeSetup(): void {
    process.stdout.write(`\n${chalk.white("Welcome to ForgeCode.")}\n\n`);
    process.stdout.write(`${chalk.white("Let's quickly set things up.")}\n\n`);
    process.stdout.write(`${chalk.hex("#7a8699")("This wizard should take less than 30 seconds.")}\n`);
  }

  public renderGettingStarted(): void {
    return;
  }

  public async renderEmptyProjectHint(workspaceRoot: string): Promise<void> {
    const files = await readdir(workspaceRoot);
    if (files.length > 0) {
      return;
    }

    process.stdout.write(`\n${chalk.hex("#7a8699")("This folder is empty.")}\n\n`);
    process.stdout.write(`${chalk.hex("#7a8699")('Try asking:\n\n"Create a starter project"')}\n`);
  }

  public renderUserMessage(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`\n${chalk.bold.hex("#4db6ff")("You")}\n`);
    process.stdout.write(`${chalk.white(message)}\n`);
  }

  public renderAssistantStart(): void {
    this.renderSpinnerStop();
    if (this.assistantStreaming) {
      return;
    }

    process.stdout.write(`\n${chalk.bold.hex("#31c48d")("ForgeCode")}\n`);
    this.assistantStreaming = true;
  }

  public renderAssistantToken(token: string): void {
    if (!this.assistantStreaming) {
      this.renderAssistantStart();
    }

    process.stdout.write(chalk.white(token));
  }

  public renderAssistantEnd(): void {
    if (this.assistantStreaming) {
      process.stdout.write("\n\n");
      this.assistantStreaming = false;
    }
  }

  public renderToolEvent(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`${this.formatToolEvent(message)}\n`);
  }

  public renderSuccess(summary: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`${chalk.hex("#31c48d")("✔")} ${chalk.hex("#31c48d")(this.formatSuccess(summary))}\n`);
  }

  public renderSpinnerStart(label = "thinking..."): void {
    this.renderAssistantEnd();
    this.spinnerText = label;

    if (this.spinnerTimer) {
      return;
    }

    process.stdout.write("\n");
    this.spinnerVisible = true;
    this.writeSpinnerFrame();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
      this.writeSpinnerFrame();
    }, 80);
  }

  public renderSpinnerStop(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }

    if (this.spinnerVisible) {
      process.stdout.write("\r\x1b[2K");
      this.spinnerVisible = false;
      this.spinnerFrameIndex = 0;
    }
  }

  public renderDebug(message: string): void {
    if (!this.debugEnabled) {
      return;
    }

    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`\n${chalk.hex("#7a8699")("[debug]")} ${chalk.hex("#7a8699")(message)}\n`);
  }

  public renderInfo(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`\n${chalk.hex("#7a8699")(message)}\n`);
  }

  public renderProviderError(error: ProviderRequestError): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();

    const message =
      error.kind === "rate_limit"
        ? [
            chalk.hex("#f59e0b")("⚠ Rate limit reached"),
            "",
            chalk.white("The selected model is currently overloaded."),
            "",
            chalk.white("Try again in a few seconds or switch models in settings."),
          ]
        : error.kind === "network"
          ? [
              chalk.hex("#f59e0b")("⚠ Network error"),
              "",
              chalk.white("Unable to reach the AI provider."),
              "",
              chalk.white("Check your internet connection and try again."),
            ]
          : [
              chalk.hex("#f59e0b")("⚠ AI provider error"),
              "",
              chalk.white("The model request failed."),
              "",
              chalk.white("Please try again or check your configuration."),
            ];

    process.stdout.write(`\n${message.join("\n")}\n\n`);
  }

  public clearScreen(): void {
    this.renderSpinnerStop();
    process.stdout.write("\x1Bc");
  }

  public setMainScreenRenderer(renderer: MainScreenRenderer): void {
    this.mainScreenRenderer = renderer;
  }

  public setSettingsOverlayHandler(handler: SettingsOverlayHandler): void {
    this.settingsOverlayHandler = handler;
  }

  public getMode(): AgentMode {
    return this.mode;
  }

  public renderSectionTitle(title: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`${chalk.bold.hex("#ff8a00")(title)}\n\n`);
  }

  public async showHelpPanel(): Promise<void> {
    this.clearScreen();
    process.stdout.write(`${chalk.bold.hex("#ff8a00")("ForgeCode Help")}\n\n`);
    process.stdout.write(`${chalk.white("Keyboard Shortcuts")}\n\n`);
    process.stdout.write(`${chalk.hex("#4db6ff")("Ctrl+Q")}   ${chalk.white("Quit ForgeCode")}\n`);
    process.stdout.write(`${chalk.hex("#4db6ff")("Ctrl+O")}   ${chalk.white("Open Settings")}\n`);
    process.stdout.write(`${chalk.hex("#4db6ff")("Ctrl+H")}   ${chalk.white("Show Help")}\n`);
    process.stdout.write(`${chalk.hex("#4db6ff")("Ctrl+L")}   ${chalk.white("Clear Screen")}\n\n`);
    process.stdout.write(`${chalk.white("Example Prompts")}\n`);
    for (const hint of PROMPT_HINTS) {
      process.stdout.write(`${SUBTLE(hint)}\n`);
    }
    process.stdout.write(`\n${SUBTLE("Press any key to return.")}\n`);
    await this.waitForAnyKey();
    await this.rerenderMainScreen();
  }

  public async prompt(message: string, initial = ""): Promise<string> {
    let value = initial.trim();

    while (true) {
      this.promptCount += 1;
      const result = await this.runPromptSession(message, value);

      if (result.action === "submit") {
        return result.value;
      }

      if (result.action === "clear") {
        value = result.value;
        await this.rerenderMainScreen();
        continue;
      }

      if (result.action === "help") {
        value = result.value;
        await this.showHelpPanel();
        continue;
      }

      if (result.action === "settings") {
        value = result.value;
        if (!this.settingsOverlayHandler) {
          continue;
        }

        const outcome = await this.settingsOverlayHandler();
        if (outcome === "reset") {
          throw new ResetRequestedError();
        }
        continue;
      }

      if (result.action === "mode") {
        value = result.value;
        this.cycleMode();
        await this.rerenderMainScreen();
        continue;
      }

      if (result.action === "quit") {
        value = result.value;
        const confirmed = await this.confirmSelection(
          "Exit ForgeCode?",
          "Yes",
          "No",
          "no",
        );
        if (confirmed) {
          throw new ExitRequestedError();
        }
        continue;
      }

      throw new ExitRequestedError();
    }
  }

  public async promptSecret(message: string, initial = ""): Promise<string> {
    const promptInstance = new PasswordPrompt({
      name: "",
      initial,
    });
    promptInstance.prefix = async () => "";
    promptInstance.message = async () => chalk.bold.hex("#4db6ff")(message);
    promptInstance.separator = async () => "";

    return String(await promptInstance.run()).trim();
  }

  public async select(
    message: string,
    choices: SelectChoice[],
    options: SelectOptions = {},
  ): Promise<string> {
    const promptInstance = new SelectPrompt({
      name: "",
      message: chalk.white(message),
      initial: options.initial,
      choices: choices.map((choice) => ({
        name: choice.name,
        message: choice.message,
        hint: choice.hint,
      })),
    });
    promptInstance.prefix = async () => "";
    promptInstance.separator = async () => "";

    return String(await promptInstance.run());
  }

  public async confirmSelection(
    message: string,
    yesLabel = "Yes",
    noLabel = "No",
    initial: "yes" | "no" = "yes",
  ): Promise<boolean> {
    const choice = await this.select(message, [
      { name: "yes", message: yesLabel },
      { name: "no", message: noLabel },
    ], {
      initial,
    });

    return choice === "yes";
  }

  public async confirm(message: string): Promise<boolean> {
    const promptInstance = new ConfirmPrompt({
      name: "",
      initial: true,
    });
    promptInstance.prefix = async () => "";
    promptInstance.message = async () => chalk.white(message);
    promptInstance.separator = async () => "";

    return Boolean(await promptInstance.run());
  }

  private async runPromptSession(message: string, initial = ""): Promise<PromptSessionResult> {
    const promptHint = this.getPromptHint();
    const promptInstance = new InputPrompt({
      name: "",
      initial,
      stdin: process.stdin,
      stdout: process.stdout,
    });
    promptInstance.prefix = async () => "";
    promptInstance.message = async () => chalk.bold.hex("#4db6ff")(message);
    promptInstance.separator = async () => "";
    promptInstance.footer = async () => this.getFooterText();
    promptInstance.header = async () => `${this.getModeText()}\n\n${SUBTLE(`Hint: ${promptHint}`)}`;

    let action: PromptSessionResult["action"] | null = null;
    let interrupting = false;

    const interrupt = async (nextAction: PromptSessionResult["action"]) => {
      if (interrupting || action) {
        return;
      }

      interrupting = true;
      action = nextAction;
      await promptInstance.cancel("");
    };

    promptInstance.on("keypress", (input: string, key: { ctrl?: boolean; name?: string; sequence?: string }) => {
      if (key.ctrl && key.name === "q") {
        void interrupt("quit");
        return;
      }

      if (key.ctrl && key.name === "c") {
        void interrupt("abort");
        return;
      }

      if (key.ctrl && key.name === "l") {
        void interrupt("clear");
        return;
      }

      if (key.name === "tab") {
        void interrupt("mode");
        return;
      }

      if (key.ctrl && key.name === "o") {
        void interrupt("settings");
        return;
      }

      if (key.ctrl && key.name === "h") {
        void interrupt("help");
        return;
      }

      if (
        key.name === "backspace" &&
        (input === "\b" || key.sequence === "\b") &&
        String(promptInstance.input ?? "").length === 0
      ) {
        void interrupt("help");
      }
    });

    try {
      process.stdout.write(`\n${SUBTLE(`Hint: ${this.getPromptHint()}`)}\n\n`);
      const response = await promptInstance.run();
      return {
        action: "submit",
        value: response.trim().length > 0 ? response.trim() : initial.trim(),
      };
    } catch (error) {
      if (action) {
        return {
          action,
          value: String(promptInstance.input ?? "").trim(),
        };
      }

      throw error;
    }
  }

  private async rerenderMainScreen(): Promise<void> {
    this.clearScreen();

    if (this.mainScreenRenderer) {
      await this.mainScreenRenderer();
      return;
    }

    this.renderHeader();
  }

  private async waitForAnyKey(): Promise<void> {
    emitKeypressEvents(process.stdin);
    const wasRawMode = process.stdin.isTTY ? process.stdin.isRaw : false;

    await new Promise<void>((resolve) => {
      const onKeypress = () => {
        process.stdin.off("keypress", onKeypress);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(Boolean(wasRawMode));
        }
        resolve();
      };

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      process.stdin.once("keypress", onKeypress);
    });
  }

  private writeSpinnerFrame(): void {
    const frame = chalk.hex("#7a8699")(SPINNER_FRAMES[this.spinnerFrameIndex]);
    const text = chalk.hex("#7a8699")(this.spinnerText);
    process.stdout.write(`\r${frame} ${text}`);
  }

  private getPromptHint(): string {
    return PROMPT_HINTS[Math.floor(Math.random() * PROMPT_HINTS.length)];
  }

  private getModeText(): string {
    const color =
      this.mode === "PLAN"
        ? chalk.hex("#4db6ff")
        : this.mode === "APPROVAL"
          ? chalk.hex("#f59e0b")
          : chalk.hex("#31c48d");

    return `${color(`Mode: ${this.mode}`)} ${SUBTLE("(press Tab to change)")}`;
  }

  private cycleMode(): AgentMode {
    const currentIndex = MODE_ORDER.indexOf(this.mode);
    this.mode = MODE_ORDER[(currentIndex + 1) % MODE_ORDER.length] ?? "APPROVAL";
    return this.mode;
  }

  private getFooterText(): string {
    const fullText = FULL_SHORTCUT_ITEMS.join(" • ");
    const mediumText = MEDIUM_SHORTCUT_ITEMS.join(" • ");
    const compactText = COMPACT_SHORTCUT_ITEMS.join(" • ");
    const columns = process.stdout.columns ?? fullText.length;
    const text =
      columns >= fullText.length + 2
        ? fullText
        : columns >= mediumText.length + 2
          ? mediumText
          : compactText;

    return SUBTLE(text);
  }

  private formatToolEvent(message: string): string {
    const dot = chalk.hex("#f59e0b")("●");
    const runningMatch = message.match(/^Running ([a-z_]+)\.\.\.$/);
    if (runningMatch) {
      return `${dot} ${chalk.hex("#7a8699")("Running")} ${chalk.hex("#f59e0b")(runningMatch[1])}${chalk.hex("#7a8699")("...")}`;
    }

    const failedMatch = message.match(/^([a-z_]+) failed\. Retrying\.\.\.$/);
    if (failedMatch) {
      return `${dot} ${chalk.hex("#f59e0b")(failedMatch[1])} ${chalk.hex("#7a8699")("failed. Retrying...")}`;
    }

    const cancelledMatch = message.match(/^([a-z_]+) cancelled by user\.$/);
    if (cancelledMatch) {
      return `${dot} ${chalk.hex("#f59e0b")(cancelledMatch[1])} ${chalk.hex("#7a8699")("cancelled by user.")}`;
    }

    return `${dot} ${chalk.hex("#7a8699")(message)}`;
  }

  private formatSuccess(summary: string): string {
    const normalized = summary.trim();

    if (normalized.startsWith("Wrote ")) {
      return `Successfully created ${normalized.slice("Wrote ".length)}`;
    }

    if (normalized.startsWith("Read ")) {
      return `Successfully read ${normalized.slice("Read ".length)}`;
    }

    if (normalized.startsWith("Listed files under ")) {
      return `Successfully listed files under ${normalized.slice("Listed files under ".length)}`;
    }

    if (normalized.startsWith("Command finished with exit code ")) {
      return `Successfully ran command (${normalized.toLowerCase()})`;
    }

    return `Successfully ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
  }
}

export function isExitRequestedError(error: unknown): boolean {
  return error instanceof ExitRequestedError;
}

export function isResetRequestedError(error: unknown): boolean {
  return error instanceof ResetRequestedError;
}
