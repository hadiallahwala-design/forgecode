import process from "node:process";
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
const TEXT = chalk.hex("#d7dde8");
const USER = chalk.hex("#5fb3ff");
const SUCCESS = chalk.hex("#31c48d");
const WARNING = chalk.hex("#f59e0b");
const ERROR = chalk.hex("#ef4444");
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

type DiffReviewAction = "apply" | "cancel";
type QueueMessageHandler = (message: string) => void;
type MainScreenRenderer = (() => Promise<void> | void) | null;
type SettingsOverlayHandler = (() => Promise<"continue" | "reset">) | null;

interface InputHistoryStore {
  get: (key: string) => { past: string[]; present: string } | undefined;
  set: (key: string, value: { past: string[]; present: string }) => void;
}

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
  private gitStatusLine = "branch: none";
  private lastStatusMessage = "Ready";
  private readonly promptHistoryStore: InputHistoryStore;
  private queueCaptureCleanup: (() => void) | null = null;
  private queuedDraft = "";
  private readonly transcript: string[] = [];

  public constructor(options: TerminalUIOptions = {}) {
    this.debugEnabled = options.debug ?? false;
    const historyState = { values: { past: [] as string[], present: "" } };
    this.promptHistoryStore = {
      get: (key) => (key === "values" ? historyState.values : undefined),
      set: (key, value) => {
        if (key === "values") {
          historyState.values = value;
        }
      },
    };
  }

  public renderHeader(): void {
    const title = chalk.bold.hex("#ff8a00")("ForgeCode");
    const separator = chalk.hex("#7a8699")("•");
    const gitStatus = chalk.hex("#7a8699")(this.gitStatusLine);
    const mode = this.getModeBadge();
    process.stdout.write(`\n${title} ${separator} ${gitStatus} ${separator} ${mode}\n`);
    process.stdout.write(`${SUBTLE(this.buildRule())}\n`);
    process.stdout.write(`${SUBTLE(`Status: ${this.lastStatusMessage}`)}\n\n`);
  }

  public renderWelcomeSetup(): void {
    process.stdout.write(`\n${chalk.white("Welcome to ForgeCode.")}\n\n`);
    process.stdout.write(`${chalk.white("Let's quickly set things up.")}\n\n`);
    process.stdout.write(`${chalk.hex("#7a8699")("This wizard should take less than 30 seconds.")}\n`);
  }

  public renderGettingStarted(): void {
    return;
  }

  public async renderEmptyProjectHint(hasIndexedFiles: boolean): Promise<void> {
    if (hasIndexedFiles) {
      return;
    }

    process.stdout.write(`\n${SUBTLE("This folder is empty. Try: \"Create a starter project\"")}\n`);
  }

  public renderUserMessage(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    this.transcript.push(`You\n${message}`);
    process.stdout.write(`\n${USER("›")} ${TEXT(message)}\n`);
  }

  public renderAssistantStart(): void {
    this.renderSpinnerStop();
    if (this.assistantStreaming) {
      return;
    }

    process.stdout.write(`\n${SUCCESS("ForgeCode")}\n`);
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

  public renderAssistantMessage(message: string): void {
    this.renderAssistantStart();
    this.renderAssistantToken(message);
    this.renderAssistantEnd();
    this.recordAssistantMessage(message);
  }

  public recordAssistantMessage(message: string): void {
    if (!message.trim()) {
      return;
    }

    this.transcript.push(`ForgeCode\n${message}`);
  }

  public renderToolEvent(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    this.lastStatusMessage = message;
    process.stdout.write(`${this.formatToolEvent(message)}\n`);
  }

  public renderSuccess(summary: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    this.lastStatusMessage = summary;
    process.stdout.write(`${SUCCESS("✓")} ${SUCCESS(this.formatSuccess(summary))}\n`);
  }

  public renderSpinnerStart(label = "thinking..."): void {
    this.renderAssistantEnd();
    this.spinnerText = label;
    this.lastStatusMessage = label;

    if (this.spinnerTimer) {
      return;
    }
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
    process.stdout.write(`\n${SUBTLE("[debug]")} ${SUBTLE(message)}\n`);
  }

  public renderInfo(message: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    this.lastStatusMessage = this.singleLine(message);
    process.stdout.write(`\n${SUBTLE("•")} ${SUBTLE(message)}\n`);
  }

  public renderContextSuggestion(files: string[]): void {
    if (files.length === 0) {
      return;
    }

    const label = files.length === 1 ? "Hint" : "Hints";
    this.renderInfo(`${label}: ${files.join(", ")} may be relevant.`);
  }

  public renderProviderError(error: ProviderRequestError): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();

    const message =
      error.kind === "rate_limit"
        ? [
            WARNING("Rate limit reached"),
            TEXT("The selected model is currently overloaded."),
            SUBTLE("Try again shortly or switch models in settings."),
          ]
        : error.kind === "network"
          ? [
              WARNING("Network error"),
              TEXT("Unable to reach the AI provider."),
              SUBTLE("Check your connection and try again."),
            ]
          : [
              WARNING("AI provider error"),
              TEXT("The model request failed."),
              SUBTLE("Try again or check your configuration."),
            ];

    this.lastStatusMessage = "Provider error";
    process.stdout.write(`\n${ERROR("!")} ${message.join("\n")}\n\n`);
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

  public setGitStatusLine(statusLine: string): void {
    this.gitStatusLine = statusLine;
  }

  public getMode(): AgentMode {
    return this.mode;
  }

  public renderSectionTitle(title: string): void {
    this.renderSpinnerStop();
    this.renderAssistantEnd();
    process.stdout.write(`\n${chalk.bold.hex("#ff8a00")(title)}\n${SUBTLE(this.buildRule())}\n\n`);
  }

  public async showHelpPanel(): Promise<void> {
    this.clearScreen();
    process.stdout.write(`${chalk.bold.hex("#ff8a00")("ForgeCode Help")}\n`);
    process.stdout.write(`${SUBTLE(this.buildRule())}\n\n`);
    process.stdout.write(`${TEXT("Keyboard shortcuts")}\n\n`);
    process.stdout.write(`${USER("Ctrl+Q")} ${TEXT("Quit")}\n`);
    process.stdout.write(`${USER("Ctrl+O")} ${TEXT("Settings")}\n`);
    process.stdout.write(`${USER("Ctrl+H")} ${TEXT("Help")}\n`);
    process.stdout.write(`${USER("Ctrl+L")} ${TEXT("Clear screen")}\n`);
    process.stdout.write(`${USER("Tab")} ${TEXT("Switch mode")}\n\n`);
    process.stdout.write(`${TEXT("Slash commands")}\n\n`);
    process.stdout.write(`${USER("/explain")} ${TEXT("Explain the current project")}\n`);
    process.stdout.write(`${USER("/fix")} ${TEXT("Fix issues in the current project")}\n`);
    process.stdout.write(`${USER("/refactor")} ${TEXT("Refactor the relevant code")}\n`);
    process.stdout.write(`${USER("/test")} ${TEXT("Add or update tests")}\n`);
    process.stdout.write(`${USER("/history")} ${TEXT("Open in-session chat history")}\n\n`);
    process.stdout.write(`${TEXT("Try asking")}\n`);
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

  public async reviewDiffPreview(summaryLines: string[], diff: string): Promise<DiffReviewAction> {
    while (true) {
      this.renderSectionTitle("ForgeCode Proposes Changes");
      for (const summaryLine of summaryLines) {
        process.stdout.write(`${TEXT(summaryLine)}\n`);
      }
      process.stdout.write(`\n${SUBTLE(`Files modified: ${summaryLines.length}`)}\n\n`);

      const action = await this.select("Choose an action:", [
        { name: "apply", message: "[y] Apply changes" },
        { name: "view", message: "[v] View full diff" },
        { name: "cancel", message: "[n] Cancel" },
      ]);

      if (action === "apply") {
        return "apply";
      }

      if (action === "cancel") {
        return "cancel";
      }

      this.clearScreen();
      this.renderSectionTitle("Full Diff");
      process.stdout.write(`${chalk.white(diff || "<no diff available>")}\n\n`);
      await this.prompt("Press Enter to return");
      await this.rerenderMainScreen();
    }
  }

  public renderToolSummary(toolNames: string[]): void {
    if (toolNames.length === 0) {
      return;
    }

    const uniqueToolNames = [...new Set(toolNames)];
    this.renderInfo(`Tools used (${toolNames.length}) ▸ ${uniqueToolNames.join(", ")}`);
  }

  public async showConversationHistory(): Promise<void> {
    this.clearScreen();
    process.stdout.write(`${chalk.bold.hex("#ff8a00")("Session History")}\n`);
    process.stdout.write(`${SUBTLE(this.buildRule())}\n\n`);

    if (this.transcript.length === 0) {
      process.stdout.write(`${SUBTLE("No messages yet.")}\n`);
    } else {
      const visibleEntries = this.transcript.slice(-20);
      for (const entry of visibleEntries) {
        process.stdout.write(`${TEXT(entry)}\n\n`);
      }
    }

    process.stdout.write(`${SUBTLE("Press any key to return.")}\n`);
    await this.waitForAnyKey();
    await this.rerenderMainScreen();
  }

  public startQueueCapture(onMessage: QueueMessageHandler): void {
    if (this.queueCaptureCleanup || !process.stdin.isTTY) {
      return;
    }

    emitKeypressEvents(process.stdin);
    const wasRawMode = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.queuedDraft = "";

    const handleData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;

      if (value === "\u0003") {
        return;
      }

      if (value === "\r" || value === "\n") {
        const queuedMessage = this.queuedDraft.trim();
        this.queuedDraft = "";
        if (queuedMessage) {
          onMessage(queuedMessage);
        }
        return;
      }

      if (value === "\u007f") {
        this.queuedDraft = this.queuedDraft.slice(0, -1);
        return;
      }

      if (value.startsWith("\u001b")) {
        return;
      }

      this.queuedDraft += value;
    };

    process.stdin.on("data", handleData);
    this.queueCaptureCleanup = () => {
      process.stdin.off("data", handleData);
      this.queuedDraft = "";
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(Boolean(wasRawMode));
      }
      this.queueCaptureCleanup = null;
    };
  }

  public stopQueueCapture(): void {
    this.queueCaptureCleanup?.();
  }

  private async runPromptSession(message: string, initial = ""): Promise<PromptSessionResult> {
    const promptHint = this.getPromptHint();
    const promptInstance = new InputPrompt({
      name: "",
      initial,
      stdin: process.stdin,
      stdout: process.stdout,
      multiline: false,
      history: {
        store: this.promptHistoryStore,
        autosave: true,
      },
      actions: {
        keys: {
          up: "altUp",
          down: "altDown",
        },
        shift: {
          return: "appendNewline",
          enter: "appendNewline",
        },
      },
    });
    (promptInstance as any).appendNewline = () => {
      promptInstance.append("\n");
    };
    promptInstance.prefix = async () => "";
    promptInstance.message = async () => USER(message);
    promptInstance.separator = async () => "";
    promptInstance.footer = async () => this.getFooterText();
    promptInstance.header = async () =>
      `${this.getPromptStatusLine()}\n${SUBTLE(`Hint: ${promptHint}`)}\n`;

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
        ? USER
        : this.mode === "APPROVAL"
          ? WARNING
          : SUCCESS;

    return `${color(`Mode: ${this.mode}`)} ${SUBTLE("(press Tab to change)")}`;
  }

  private getModeBadge(): string {
    const color =
      this.mode === "PLAN"
        ? USER
        : this.mode === "APPROVAL"
          ? WARNING
          : SUCCESS;

    return color(`Mode ${this.mode}`);
  }

  private getPromptStatusLine(): string {
    return `${this.getModeText()} ${SUBTLE("•")} ${SUBTLE(this.gitStatusLine)}`;
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

  private buildRule(): string {
    const columns = Math.max(24, Math.min(process.stdout.columns ?? 60, 72));
    return "─".repeat(columns);
  }

  private singleLine(message: string): string {
    return message.replace(/\s+/g, " ").trim();
  }

  private formatToolEvent(message: string): string {
    const dot = WARNING("●");
    const runningMatch = message.match(/^Running ([a-z_]+)\.\.\.$/);
    if (runningMatch) {
      return `${dot} ${SUBTLE("Running")} ${WARNING(runningMatch[1])}${SUBTLE("...")}`;
    }

    const failedMatch = message.match(/^([a-z_]+) failed\. Retrying\.\.\.$/);
    if (failedMatch) {
      return `${dot} ${WARNING(failedMatch[1])} ${SUBTLE("failed. Retrying...")}`;
    }

    const cancelledMatch = message.match(/^([a-z_]+) cancelled by user\.$/);
    if (cancelledMatch) {
      return `${dot} ${WARNING(cancelledMatch[1])} ${SUBTLE("cancelled by user.")}`;
    }

    return `${dot} ${SUBTLE(message)}`;
  }

  private formatSuccess(summary: string): string {
    const normalized = summary.trim();

    if (normalized.startsWith("Prepared deletion of ")) {
      return `Prepared deletion of ${normalized.slice("Prepared deletion of ".length)}`;
    }

    if (normalized.startsWith("Prepared ")) {
      return `Prepared ${normalized.slice("Prepared ".length)}`;
    }

    if (normalized.startsWith("Wrote ")) {
      return `Updated ${normalized.slice("Wrote ".length)}`;
    }

    if (normalized.startsWith("Read ")) {
      return `Read ${normalized.slice("Read ".length)}`;
    }

    if (normalized.startsWith("Listed files under ")) {
      return `Listed ${normalized.slice("Listed files under ".length)}`;
    }

    if (normalized.startsWith("Command finished with exit code ")) {
      return normalized;
    }

    return normalized;
  }
}

export function isExitRequestedError(error: unknown): boolean {
  return error instanceof ExitRequestedError;
}

export function isResetRequestedError(error: unknown): boolean {
  return error instanceof ResetRequestedError;
}
