export interface ProviderConfig {
  api_key: string;
  base_url: string;
  model: string;
  provider: "openai-compatible";
}

export interface ForgeCodeConfig extends ProviderConfig {}
