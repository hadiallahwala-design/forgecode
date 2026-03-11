import type { ForgeCodeConfig } from "../config/types.js";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import type { Provider } from "./types.js";

export function createProvider(config: ForgeCodeConfig): Provider {
  if (config.provider === "openai-compatible") {
    return new OpenAICompatibleProvider(config);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}
