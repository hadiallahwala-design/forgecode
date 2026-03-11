import { ProtocolStreamParser, parseDirective } from "../agent/protocol.js";
import { buildPrompt, type ConversationEntry } from "../context/contextBuilder.js";
import type { ProjectMemoryManager } from "../context/projectMemory.js";
import type { ProjectIndexer } from "../context/projectIndexer.js";
import { ProviderRequestError, type Provider } from "../providers/types.js";
import { ToolExecutor } from "./toolExecutor.js";

export type AgentMode = "PLAN" | "APPROVAL" | "AUTO";

export interface RuntimeHooks {
  onAssistantToken?: (token: string) => void;
  onToolStart?: (toolName: string, input: Record<string, string>) => void;
  onToolEnd?: (toolName: string, result: { summary: string; status?: string }) => void;
  onDebug?: (message: string) => void;
}

export interface RuntimeOptions {
  mode?: AgentMode;
}

export interface RuntimeResponse {
  kind: "final_message" | "ask_user";
  message: string;
  streamed: boolean;
}

const MAX_TOOL_CALLS_PER_REQUEST = 20;

function claimsFileMutation(message: string): boolean {
  return /\b(created|wrote|written|updated|modified|changed|edited|saved|deleted|removed)\b/i.test(message);
}

export class AgentRuntime {
  private readonly history: ConversationEntry[] = [];

  public constructor(
    private readonly provider: Provider,
    private readonly toolExecutor: ToolExecutor,
    private readonly projectIndexer: ProjectIndexer,
    private readonly projectMemory: ProjectMemoryManager,
  ) {}

  public async processUserMessage(
    message: string,
    options: RuntimeOptions = {},
    hooks: RuntimeHooks = {},
  ): Promise<RuntimeResponse> {
    const mode = options.mode ?? "APPROVAL";
    this.toolExecutor.beginRequest();
    this.history.push({ role: "user", content: message });
    let toolCalls = 0;
    let sawFileMutation = false;

    for (let iteration = 0; iteration < MAX_TOOL_CALLS_PER_REQUEST + 2; iteration += 1) {
      const prompt = await buildPrompt(this.projectIndexer, this.projectMemory, this.history);
      const streamParser = new ProtocolStreamParser();
      let streamedVisibleContent = false;

      let rawResponse: string;
      try {
        rawResponse = await this.provider.generateResponse(prompt, {
          onToken: (token) => {
            const visibleToken = streamParser.consume(token);
            if (visibleToken) {
              streamedVisibleContent = true;
              hooks.onAssistantToken?.(visibleToken);
            }
          },
        });
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          hooks.onDebug?.(
            `Provider request failed (${error.kind}${error.statusCode ? `:${error.statusCode}` : ""}).`,
          );
        }
        throw error;
      }

      this.history.push({ role: "assistant", content: rawResponse });
      const directive = parseDirective(rawResponse);

      if (directive.type === "final_message") {
        if (!sawFileMutation && claimsFileMutation(directive.message)) {
          this.history.push({
            role: "tool",
            content:
              "Runtime validation: You claimed file changes without calling write_file or delete_file. Respond again using the protocol and accurately reflect what happened.",
          });
          hooks.onDebug?.("Blocked an invalid file-change claim in FINAL_MESSAGE.");
          continue;
        }

        return {
          kind: "final_message",
          message: directive.message,
          streamed: streamedVisibleContent,
        };
      }

      if (directive.type === "ask_user") {
        return {
          kind: "ask_user",
          message: directive.question,
          streamed: streamedVisibleContent,
        };
      }

      if (toolCalls >= MAX_TOOL_CALLS_PER_REQUEST) {
        return {
          kind: "final_message",
          message: "I stopped after 20 tool calls for this request. Please narrow the task or be more specific.",
          streamed: false,
        };
      }

      toolCalls += 1;
      if (mode === "PLAN") {
        this.history.push({
          role: "tool",
          content: [
            `Tool: ${directive.toolName}`,
            "Summary: Execution skipped because the current mode is PLAN.",
            "Details: Do not call tools in PLAN mode. Respond with FINAL_MESSAGE only and provide a numbered execution plan.",
          ].join("\n"),
        });
        hooks.onDebug?.(`Skipped ${directive.toolName} because execution mode is PLAN.`);
        continue;
      }

      hooks.onToolStart?.(directive.toolName, directive.input);
      const toolResult = await this.toolExecutor.execute(directive.toolName, directive.input, {
        mode,
      });
      hooks.onToolEnd?.(directive.toolName, {
        summary: toolResult.summary,
        status: toolResult.status,
      });
      if (
        (directive.toolName === "write_file" || directive.toolName === "delete_file") &&
        toolResult.status === "success"
      ) {
        sawFileMutation = true;
      }

      this.history.push({
        role: "tool",
        content: [
          `Tool: ${directive.toolName}`,
          `Summary: ${toolResult.summary}`,
          toolResult.details ? `Details: ${toolResult.details}` : "",
          toolResult.data,
        ]
          .filter(Boolean)
          .join("\n"),
      });

      if (toolResult.status === "validation_error") {
        hooks.onDebug?.(`Tool ${directive.toolName} failed validation: ${toolResult.details ?? ""}`);
      }
    }

    throw new Error("Agent loop stopped after reaching the maximum iteration limit.");
  }
}
