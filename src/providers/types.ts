export interface GenerateResponseOptions {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  temperature?: number;
}

export type ProviderErrorKind = "rate_limit" | "network" | "provider";

export class ProviderRequestError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly statusCode?: number;
  public readonly cause?: unknown;

  public constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.kind = kind;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }
}

export interface Provider {
  generateResponse(prompt: string, options?: GenerateResponseOptions): Promise<string>;
}
