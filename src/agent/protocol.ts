export interface ActionDirective {
  type: "action";
  toolName: string;
  input: Record<string, string>;
  raw: string;
}

export interface AskUserDirective {
  type: "ask_user";
  question: string;
  raw: string;
}

export interface FinalMessageDirective {
  type: "final_message";
  message: string;
  raw: string;
}

export type ParsedDirective = ActionDirective | AskUserDirective | FinalMessageDirective;

type DirectiveKind = ParsedDirective["type"];

const FINAL_MESSAGE_PREFIX = "FINAL_MESSAGE:";
const ASK_USER_PREFIX = "ASK_USER:";
const ACTION_PREFIX = "ACTION:";

function normalizeKey(rawKey: string): string {
  return rawKey.trim().toLowerCase();
}

export class ProtocolStreamParser {
  private raw = "";
  private mode: DirectiveKind | "unknown" = "unknown";
  private visibleOffset = 0;

  public consume(token: string): string {
    this.raw += token;

    if (this.mode === "action") {
      return "";
    }

    if (this.mode === "final_message" || this.mode === "ask_user") {
      const nextChunk = this.raw.slice(this.visibleOffset);
      this.visibleOffset = this.raw.length;
      return nextChunk;
    }

    const trimmed = this.raw.trimStart();
    const leadingWhitespaceLength = this.raw.length - trimmed.length;

    if (FINAL_MESSAGE_PREFIX.startsWith(trimmed)) {
      if (trimmed.startsWith(FINAL_MESSAGE_PREFIX)) {
        this.mode = "final_message";
        this.visibleOffset = leadingWhitespaceLength + FINAL_MESSAGE_PREFIX.length;
        const nextChunk = this.raw.slice(this.visibleOffset);
        this.visibleOffset = this.raw.length;
        return nextChunk;
      }

      return "";
    }

    if (ASK_USER_PREFIX.startsWith(trimmed)) {
      if (trimmed.startsWith(ASK_USER_PREFIX)) {
        this.mode = "ask_user";
        this.visibleOffset = leadingWhitespaceLength + ASK_USER_PREFIX.length;
        const nextChunk = this.raw.slice(this.visibleOffset);
        this.visibleOffset = this.raw.length;
        return nextChunk;
      }

      return "";
    }

    if (ACTION_PREFIX.startsWith(trimmed)) {
      if (trimmed.startsWith(ACTION_PREFIX)) {
        this.mode = "action";
      }

      return "";
    }

    return "";
  }

  public getRawResponse(): string {
    return this.raw;
  }
}

export function parseDirective(rawResponse: string): ParsedDirective {
  const normalized = rawResponse.trim();

  if (normalized.startsWith(FINAL_MESSAGE_PREFIX)) {
    return {
      type: "final_message",
      message: normalized.slice(FINAL_MESSAGE_PREFIX.length).trim(),
      raw: rawResponse,
    };
  }

  if (normalized.startsWith(ASK_USER_PREFIX)) {
    return {
      type: "ask_user",
      question: normalized.slice(ASK_USER_PREFIX.length).trim(),
      raw: rawResponse,
    };
  }

  if (!normalized.startsWith(ACTION_PREFIX)) {
    throw new Error("Model response did not follow the ForgeCode action protocol.");
  }

  const lines = normalized.split(/\r?\n/);
  const toolName = lines[0].slice(ACTION_PREFIX.length).trim();
  const input: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of lines.slice(1)) {
    const match = line.match(/^([A-Z_]+):\s?(.*)$/);
    if (match) {
      currentKey = normalizeKey(match[1]);
      input[currentKey] = match[2] ?? "";
      continue;
    }

    if (currentKey) {
      input[currentKey] = `${input[currentKey]}\n${line}`.trimEnd();
    }
  }

  return {
    type: "action",
    toolName,
    input,
    raw: rawResponse,
  };
}
