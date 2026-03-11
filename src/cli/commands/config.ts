import { unlink } from "node:fs/promises";

import { getConfigPath, readConfig, writeConfig } from "../../config/configStore.js";
import type { ForgeCodeConfig } from "../../config/types.js";
import { TerminalUI } from "../../ui/terminal.js";

interface ConfigCommandOptions {
  firstRun?: boolean;
}

type ProviderKey = "openrouter" | "openai" | "anthropic" | "custom";
type SettingsCommandResult = "back" | "reset";

interface ProviderPreset {
  key: ProviderKey;
  label: string;
  baseUrl?: string;
  requiresCustomBaseUrl?: boolean;
  models: string[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openrouter",
    label: "OpenRouter (recommended)",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "deepseek/deepseek-chat",
      "anthropic/claude-3.7-sonnet",
      "openai/gpt-4o-mini",
    ],
  },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4.1", "gpt-4o"],
  },
  {
    key: "anthropic",
    label: "Anthropic",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-3.5-haiku",
      "anthropic/claude-3-opus",
    ],
  },
  {
    key: "custom",
    label: "Custom OpenAI-compatible API",
    requiresCustomBaseUrl: true,
    models: [],
  },
];

function formatModelLabel(model: string): string {
  if (model === "deepseek/deepseek-chat") {
    return "deepseek/deepseek-chat (fast and cheap)";
  }

  if (model === "anthropic/claude-3.7-sonnet") {
    return "anthropic/claude-3.7-sonnet (best quality)";
  }

  if (model === "openai/gpt-4o-mini" || model === "gpt-4o-mini") {
    return `${model} (balanced)`;
  }

  return model;
}

function getProviderPresetByKey(key: ProviderKey): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.key === key);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${key}`);
  }

  return preset;
}

function inferProviderKey(config: ForgeCodeConfig): ProviderKey {
  if (config.base_url === "https://api.openai.com/v1") {
    return "openai";
  }

  if (config.base_url === "https://openrouter.ai/api/v1") {
    if (config.model.startsWith("anthropic/")) {
      return "anthropic";
    }

    return "openrouter";
  }

  return "custom";
}

async function chooseProvider(ui: TerminalUI, initial?: ProviderKey): Promise<ProviderPreset> {
  const providerKey = await ui.select(
    "Choose your AI provider:",
    PROVIDER_PRESETS.map((preset) => ({
      name: preset.key,
      message: preset.label,
      hint:
        preset.key === "anthropic"
          ? "Uses OpenRouter-compatible access for Anthropic models."
          : undefined,
    })),
    {
      initial,
    },
  );

  return getProviderPresetByKey(providerKey as ProviderKey);
}

async function chooseModel(
  ui: TerminalUI,
  provider: ProviderPreset,
  initial?: string,
): Promise<string> {
  if (provider.models.length === 0) {
    return ui.prompt("Preferred model", initial ?? "");
  }

  const choices = [
    ...provider.models.map((candidate) => ({
      name: candidate,
      message: formatModelLabel(candidate),
    })),
    { name: "__custom__", message: "Custom model" },
  ];

  const modelChoice = await ui.select("Choose your preferred model:", choices, {
    initial: provider.models.includes(initial ?? "") ? initial : undefined,
  });

  if (modelChoice === "__custom__") {
    return ui.prompt("Custom model", initial ?? "");
  }

  return modelChoice;
}

async function chooseBaseUrl(
  ui: TerminalUI,
  provider: ProviderPreset,
  initial?: string,
): Promise<string> {
  if (provider.requiresCustomBaseUrl) {
    return ui.prompt("Base URL", initial ?? "");
  }

  return provider.baseUrl ?? initial ?? "https://api.openai.com/v1";
}

async function collectConfig(ui: TerminalUI, initialConfig?: ForgeCodeConfig): Promise<ForgeCodeConfig> {
  const initialProviderKey = initialConfig ? inferProviderKey(initialConfig) : "openrouter";
  const provider = await chooseProvider(ui, initialProviderKey);

  if (provider.key === "anthropic") {
    ui.renderInfo("Anthropic models currently use OpenRouter-compatible access in ForgeCode.");
  }

  const apiKey = await ui.promptSecret("API key", initialConfig?.api_key ?? "");
  const model = await chooseModel(ui, provider, initialConfig?.model);
  const baseUrl = await chooseBaseUrl(ui, provider, initialConfig?.base_url);

  ui.renderInfo(`Provider: ${provider.label}`);
  ui.renderInfo(`Model: ${model}`);
  await ui.prompt("Press Enter to confirm");

  return {
    provider: "openai-compatible",
    base_url: baseUrl,
    model,
    api_key: apiKey,
  };
}

export async function runConfigCommand(
  ui: TerminalUI,
  options: ConfigCommandOptions = {},
): Promise<void> {
  if (options.firstRun) {
    ui.renderWelcomeSetup();
  } else {
    ui.renderInfo(`ForgeCode config path: ${getConfigPath()}`);
  }

  const nextConfig = await collectConfig(ui);
  await writeConfig(nextConfig);
  ui.renderInfo("Configuration saved.");
}

async function runResetCommand(ui: TerminalUI): Promise<boolean> {
  const configPath = getConfigPath();

  const confirmed = await ui.confirmSelection(
    "Reset ForgeCode configuration?\n\nThis will delete your saved API key and model settings.",
    "Yes",
    "No",
    "no",
  );
  if (!confirmed) {
    return false;
  }

  try {
    await unlink(configPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      ui.renderInfo("No configuration file found.");
      return false;
    }

    ui.renderInfo("Failed to reset configuration.");
    return false;
  }
}

export async function runSettingsCommand(ui: TerminalUI): Promise<SettingsCommandResult> {
  while (true) {
    const config = await readConfig();
    if (!config) {
      ui.renderInfo("No configuration found.");
      return "back";
    }

    ui.clearScreen();
    ui.renderSectionTitle("ForgeCode Settings");

    const choice = await ui.select("Choose a setting:", [
      { name: "provider", message: "Change AI provider" },
      { name: "model", message: "Change model" },
      { name: "api_key", message: "Update API key" },
      { name: "reset", message: "Reset configuration" },
      { name: "back", message: "Back" },
    ]);

    if (choice === "back") {
      ui.clearScreen();
      return "back";
    }

    if (choice === "provider") {
      const provider = await chooseProvider(ui, inferProviderKey(config));
      const baseUrl = await chooseBaseUrl(ui, provider, config.base_url);
      await writeConfig({
        ...config,
        base_url: baseUrl,
      });
      ui.renderInfo(`Provider updated to ${provider.label}.`);
      await ui.prompt("Press Enter to return");
      continue;
    }

    if (choice === "model") {
      const provider = getProviderPresetByKey(inferProviderKey(config));
      const model = await chooseModel(ui, provider, config.model);
      await writeConfig({
        ...config,
        model,
      });
      ui.renderInfo(`Model updated to ${model}.`);
      await ui.prompt("Press Enter to return");
      continue;
    }

    if (choice === "api_key") {
      const apiKey = await ui.promptSecret("New API key", config.api_key);
      await writeConfig({
        ...config,
        api_key: apiKey,
      });
      ui.renderInfo("API key updated.");
      await ui.prompt("Press Enter to return");
      continue;
    }

    const reset = await runResetCommand(ui);
    if (reset) {
      ui.clearScreen();
      return "reset";
    }
  }
}
