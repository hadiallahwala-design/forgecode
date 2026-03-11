import type { ForgeCodeConfig } from "../config/types.js";
import { ProviderRequestError, type GenerateResponseOptions, type Provider } from "./types.js";

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class OpenAICompatibleProvider implements Provider {
  public constructor(private readonly config: ForgeCodeConfig) {}

  public async generateResponse(
    prompt: string,
    options: GenerateResponseOptions = {},
  ): Promise<string> {
    try {
      const response = await this.fetchChatCompletion(prompt, options, true);
      if (!response.body) {
        throw new ProviderRequestError(
          "provider",
          "Provider response did not include a stream.",
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        const parts = buffered.split("\n\n");
        buffered = parts.pop() ?? "";

        for (const part of parts) {
          const line = part
            .split("\n")
            .find((candidate) => candidate.startsWith("data: "));

          if (!line) {
            continue;
          }

          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            continue;
          }

          const chunk = JSON.parse(payload) as ChatCompletionChunk;
          const token = chunk.choices?.[0]?.delta?.content ?? "";

          if (!token) {
            continue;
          }

          fullText += token;
          options.onToken?.(token);
        }
      }

      if (fullText.trim().length > 0) {
        return fullText;
      }

      const fallbackResponse = await this.fetchChatCompletion(prompt, options, false);
      const payload = (await fallbackResponse.json()) as ChatCompletionResponse;
      return payload.choices?.[0]?.message?.content ?? "";
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private getEndpoint(): string {
    return `${this.config.base_url.replace(/\/$/, "")}/chat/completions`;
  }

  private async fetchChatCompletion(
    prompt: string,
    options: GenerateResponseOptions,
    stream: boolean,
  ): Promise<Response> {
    const response = await fetch(this.getEndpoint(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: options.temperature ?? 0.1,
        stream,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ProviderRequestError(
        response.status === 429 ? "rate_limit" : "provider",
        `Provider request failed (${response.status}): ${body}`,
        { statusCode: response.status },
      );
    }

    return response;
  }

  private normalizeError(error: unknown): ProviderRequestError {
    if (error instanceof ProviderRequestError) {
      return error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new ProviderRequestError("network", error.message, { cause: error });
    }

    if (error instanceof TypeError) {
      return new ProviderRequestError("network", error.message, { cause: error });
    }

    if (error instanceof Error) {
      return new ProviderRequestError("provider", error.message, { cause: error });
    }

    return new ProviderRequestError("provider", "Unknown provider failure.", { cause: error });
  }
}
