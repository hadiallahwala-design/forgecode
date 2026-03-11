import { access, readFile } from "node:fs/promises";
import { relative } from "node:path";

import type { ProjectIndexer } from "../context/projectIndexer.js";

export interface PendingFileChange {
  kind: "write" | "delete";
  path: string;
  absolutePath: string;
  content: string | null;
  previousContent: string | null;
}

function isSafeFsError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(String(error.code));
}

export class ToolExecutionSession {
  private readonly pendingChanges = new Map<string, PendingFileChange>();

  public constructor(
    private readonly workspaceRoot: string,
    private readonly projectIndexer: ProjectIndexer,
  ) {}

  public async stageWrite(absolutePath: string, content: string): Promise<PendingFileChange> {
    const path = relative(this.workspaceRoot, absolutePath);
    const existing = this.pendingChanges.get(path);
    const previousContent =
      existing?.previousContent ?? (await this.safeReadExistingFile(absolutePath));
    const nextWrite: PendingFileChange = {
      kind: "write",
      path,
      absolutePath,
      content,
      previousContent,
    };

    this.pendingChanges.set(path, nextWrite);
    return nextWrite;
  }

  public async stageDelete(absolutePath: string): Promise<PendingFileChange> {
    const path = relative(this.workspaceRoot, absolutePath);
    const existing = this.pendingChanges.get(path);
    const previousContent =
      existing?.previousContent ?? (await this.safeReadExistingFile(absolutePath));
    const nextChange: PendingFileChange = {
      kind: "delete",
      path,
      absolutePath,
      content: null,
      previousContent,
    };

    this.pendingChanges.set(path, nextChange);
    return nextChange;
  }

  public async readFile(absolutePath: string): Promise<string> {
    const path = relative(this.workspaceRoot, absolutePath);
    const pendingChange = this.pendingChanges.get(path);
    if (pendingChange?.kind === "delete") {
      throw new Error(`File is staged for deletion: ${path}`);
    }

    if (pendingChange?.kind === "write" && pendingChange.content !== null) {
      return pendingChange.content;
    }

    return await readFile(absolutePath, "utf8");
  }

  public getVisibleFiles(targetPath = ".", maxDepth = 3): string[] {
    const indexedFiles = new Set(this.projectIndexer.getFilesUnder(targetPath, maxDepth));
    const basePrefix = targetPath === "." ? "" : `${targetPath.replace(/\/$/, "")}/`;

    for (const pendingChange of this.pendingChanges.values()) {
      if (basePrefix && pendingChange.path !== targetPath && !pendingChange.path.startsWith(basePrefix)) {
        continue;
      }

      const visiblePath = basePrefix ? pendingChange.path.slice(basePrefix.length) : pendingChange.path;
      if (!visiblePath) {
        continue;
      }

      if (pendingChange.kind === "delete") {
        indexedFiles.delete(visiblePath);
        continue;
      }

      const segments = visiblePath.split("/");
      if (segments.length - 1 > maxDepth) {
        continue;
      }

      for (let index = 0; index < segments.length - 1; index += 1) {
        indexedFiles.add(`${segments.slice(0, index + 1).join("/")}/`);
      }

      indexedFiles.add(visiblePath);
    }

    return [...indexedFiles].sort((left, right) => left.localeCompare(right));
  }

  public peekPendingChanges(): PendingFileChange[] {
    return [...this.pendingChanges.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  public getModifiedFiles(): string[] {
    return [...this.pendingChanges.values()]
      .map((change) => change.path)
      .sort((left, right) => left.localeCompare(right));
  }

  public clearPendingChanges(): void {
    this.pendingChanges.clear();
  }

  private async safeReadExistingFile(absolutePath: string): Promise<string | null> {
    try {
      await access(absolutePath);
      return await readFile(absolutePath, "utf8");
    } catch (error) {
      if (isSafeFsError(error)) {
        return null;
      }

      throw error;
    }
  }
}
