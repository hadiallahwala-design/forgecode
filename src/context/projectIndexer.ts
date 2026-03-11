import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface IndexedFile {
  path: string;
  absolutePath: string;
  size: number;
  type: string;
  mtimeMs: number;
}

export interface ProjectIndexerOptions {
  maxFiles?: number;
  maxDirectorySizeBytes?: number;
  onIndexChange?: (indexer: ProjectIndexer) => Promise<void> | void;
}

interface DirectoryScanResult {
  totalSize: number;
  indexedFilePaths: string[];
}

const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
] as const;

const IGNORED_NAMES = new Set([
  ".forgecode",
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".Trash",
  "Library",
  "System",
  "Applications",
  ".DS_Store",
]);

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DIRECTORY_SIZE_BYTES = 50 * 1024 * 1024;
const README_PATTERN = /^readme(\.[^.]+)?$/i;
const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  ".env",
  ".env.example",
]);
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".css",
  ".scss",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
]);

function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

function isSafeFsError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["EPERM", "EACCES", "ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code));
}

function normalizeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return extension ? extension.slice(1) : "file";
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(rootDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 512);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }

  return false;
}

function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

export class ProjectIndexer {
  private readonly files = new Map<string, IndexedFile>();
  private watcher: FSWatcher | null = null;
  private readonly maxFiles: number;
  private readonly maxDirectorySizeBytes: number;
  private readonly onIndexChange?: (indexer: ProjectIndexer) => Promise<void> | void;

  public constructor(
    private readonly projectRoot: string,
    options: ProjectIndexerOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDirectorySizeBytes = options.maxDirectorySizeBytes ?? DEFAULT_MAX_DIRECTORY_SIZE_BYTES;
    this.onIndexChange = options.onIndexChange;
  }

  public static async detectProjectRoot(startDir: string): Promise<string> {
    let currentDir = resolve(startDir);

    while (true) {
      if (await this.hasProjectMarker(currentDir)) {
        return currentDir;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        return resolve(startDir);
      }

      currentDir = parentDir;
    }
  }

  private static async hasProjectMarker(directoryPath: string): Promise<boolean> {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        await lstat(join(directoryPath, marker));
        return true;
      } catch (error) {
        if (isSafeFsError(error)) {
          continue;
        }

        throw error;
      }
    }

    return false;
  }

  public async initialize(): Promise<number> {
    this.files.clear();
    await this.scanDirectory(this.projectRoot);
    this.startWatcher();
    await this.notifyIndexChanged();
    return this.files.size;
  }

  public close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  public getProjectRoot(): string {
    return this.projectRoot;
  }

  public getFileCount(): number {
    return this.files.size;
  }

  public hasIndexedFiles(): boolean {
    return this.files.size > 0;
  }

  public async refreshPath(relativePath: string): Promise<void> {
    const absolutePath = join(this.projectRoot, relativePath);
    await this.handleWatchEvent("change", relativePath);
    if (!isWithinRoot(this.projectRoot, absolutePath)) {
      return;
    }
  }

  public getIndexedFiles(): IndexedFile[] {
    return [...this.files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  public getFilesUnder(targetPath = ".", maxDepth = 3): string[] {
    const absoluteTargetPath = resolve(this.projectRoot, targetPath);
    if (!isWithinRoot(this.projectRoot, absoluteTargetPath)) {
      throw new Error("Access outside the project directory is not allowed.");
    }

    const relativeBase = relative(this.projectRoot, absoluteTargetPath);
    const basePrefix = relativeBase ? `${relativeBase}/` : "";
    const directories = new Set<string>();
    const output: string[] = [];

    for (const file of this.getIndexedFiles()) {
      if (relativeBase && file.path !== relativeBase && !file.path.startsWith(basePrefix)) {
        continue;
      }

      const scopedPath = relativeBase ? relative(relativeBase, file.path) : file.path;
      if (!scopedPath || scopedPath.startsWith("..")) {
        continue;
      }

      const segments = scopedPath.split("/");
      const depth = segments.length - 1;
      if (depth > maxDepth) {
        continue;
      }

      for (let index = 0; index < Math.min(segments.length - 1, maxDepth); index += 1) {
        const directoryPath = segments.slice(0, index + 1).join("/");
        if (!directoryPath || directories.has(directoryPath)) {
          continue;
        }

        directories.add(directoryPath);
        output.push(`${directoryPath}/`);
      }

      output.push(scopedPath);
    }

    return output.sort((left, right) => left.localeCompare(right));
  }

  public buildFileTree(maxDepth = 2): string[] {
    const lines: string[] = [];
    const directories = new Set<string>();

    for (const file of this.getIndexedFiles()) {
      const segments = file.path.split("/");
      for (let index = 0; index < segments.length - 1 && index < maxDepth; index += 1) {
        const directoryPath = segments.slice(0, index + 1).join("/");
        if (directories.has(directoryPath)) {
          continue;
        }

        directories.add(directoryPath);
        lines.push(`${"  ".repeat(index)}- ${directoryPath}/`);
      }

      if (segments.length - 1 <= maxDepth) {
        lines.push(`${"  ".repeat(segments.length - 1)}- ${file.path}`);
      }
    }

    return lines;
  }

  public async selectContextFiles(
    prompt: string,
    budgetBytes = 32_000,
  ): Promise<Array<{ file: IndexedFile; content: string }>> {
    const scoredFiles = this.scoreFiles(prompt);
    const selected: Array<{ file: IndexedFile; content: string }> = [];
    let usedBytes = 0;

    for (const file of scoredFiles) {
      if (usedBytes >= budgetBytes) {
        break;
      }

      if (file.size > 64_000) {
        continue;
      }

      const content = await this.safeReadTextFile(file.absolutePath, 8_000);
      if (!content) {
        continue;
      }

      const estimatedBytes = Buffer.byteLength(content, "utf8");
      if (usedBytes + estimatedBytes > budgetBytes && selected.length > 0) {
        continue;
      }

      selected.push({ file, content });
      usedBytes += estimatedBytes;
    }

    return selected;
  }

  public suggestRelevantFiles(prompt: string, limit = 3): string[] {
    return this.scoreFiles(prompt)
      .slice(0, limit)
      .map((file) => file.path);
  }

  private scoreFiles(prompt: string): IndexedFile[] {
    const normalizedPrompt = prompt.toLowerCase();
    const mentionedPaths = new Set<string>();
    const quotedMatches = [...prompt.matchAll(/["'`]([^"'`\n]+?\.[^"'`\s]+)["'`]/g)];
    const bareMatches = [...prompt.matchAll(/\b[\w./-]+\.[A-Za-z0-9]+\b/g)];

    for (const match of [...quotedMatches, ...bareMatches]) {
      const candidate = match[1] ?? match[0];
      mentionedPaths.add(candidate.toLowerCase());
    }

    return this.getIndexedFiles()
      .map((file) => {
        let score = 0;
        const lowerPath = file.path.toLowerCase();
        const lowerBaseName = basename(lowerPath);

        if (mentionedPaths.has(lowerPath) || [...mentionedPaths].some((value) => lowerPath.endsWith(value))) {
          score += 100;
        }

        if (normalizedPrompt.includes(lowerBaseName)) {
          score += 60;
        }

        if (README_PATTERN.test(lowerBaseName)) {
          score += 40;
        }

        if (CONFIG_FILE_NAMES.has(lowerBaseName)) {
          score += 35;
        }

        if (SOURCE_FILE_EXTENSIONS.has(extname(lowerPath))) {
          score += 20;
        }

        if (file.size <= 8_000) {
          score += 20;
        } else if (file.size <= 24_000) {
          score += 10;
        } else {
          score -= 20;
        }

        const minutesAgo = Math.max(1, (Date.now() - file.mtimeMs) / 60_000);
        score += Math.max(0, 30 - Math.log10(minutesAgo + 1) * 10);

        return { file, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
      .map((entry) => entry.file);
  }

  private async safeReadTextFile(filePath: string, maxLength: number): Promise<string | null> {
    try {
      const buffer = await readFile(filePath);
      if (isBinaryBuffer(buffer)) {
        return null;
      }

      return clampText(buffer.toString("utf8"), maxLength);
    } catch (error) {
      if (isSafeFsError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async scanDirectory(directoryPath: string): Promise<DirectoryScanResult> {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isSafeFsError(error)) {
        return { totalSize: 0, indexedFilePaths: [] };
      }

      throw error;
    }

    let totalSize = 0;
    const indexedFilePaths: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (isIgnoredName(entry.name) || this.files.size >= this.maxFiles) {
        continue;
      }

      const absolutePath = join(directoryPath, entry.name);
      const relativePath = relative(this.projectRoot, absolutePath);
      if (!relativePath || relativePath.startsWith("..")) {
        continue;
      }

      if (entry.isDirectory()) {
        const result = await this.scanDirectory(absolutePath);
        totalSize += result.totalSize;
        indexedFilePaths.push(...result.indexedFilePaths);
        if (totalSize > this.maxDirectorySizeBytes) {
          for (const filePath of indexedFilePaths) {
            this.files.delete(filePath);
          }

          return { totalSize, indexedFilePaths: [] };
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStats = await this.safeStat(absolutePath);
      if (!fileStats) {
        continue;
      }

      const indexedFile: IndexedFile = {
        path: relativePath,
        absolutePath,
        size: fileStats.size,
        type: normalizeType(relativePath),
        mtimeMs: fileStats.mtimeMs,
      };

      this.files.set(relativePath, indexedFile);
      indexedFilePaths.push(relativePath);
      totalSize += fileStats.size;
      if (totalSize > this.maxDirectorySizeBytes) {
        for (const filePath of indexedFilePaths) {
          this.files.delete(filePath);
        }

        return { totalSize, indexedFilePaths: [] };
      }
    }

    return { totalSize, indexedFilePaths };
  }

  private async safeStat(targetPath: string) {
    try {
      return await stat(targetPath);
    } catch (error) {
      if (isSafeFsError(error)) {
        return null;
      }

      throw error;
    }
  }

  private startWatcher(): void {
    this.close();

    try {
      this.watcher = watch(this.projectRoot, { recursive: true }, (eventType, fileName) => {
        void this.handleWatchEvent(eventType, fileName?.toString() ?? "");
      });
      this.watcher.on("error", () => {
        this.close();
      });
    } catch {
      this.watcher = null;
    }
  }

  private async handleWatchEvent(_eventType: string, rawPath: string): Promise<void> {
    if (!rawPath) {
      return;
    }

    const relativePath = rawPath.replaceAll("\\", "/");
    const pathSegments = relativePath.split("/");
    if (pathSegments.some((segment) => isIgnoredName(segment))) {
      return;
    }

    const absolutePath = join(this.projectRoot, relativePath);
    if (!isWithinRoot(this.projectRoot, absolutePath)) {
      return;
    }

    const fileStats = await this.safeStat(absolutePath);
    if (!fileStats) {
      this.removePath(relativePath);
      await this.notifyIndexChanged();
      return;
    }

    if (fileStats.isDirectory()) {
      this.removePath(relativePath);
      await this.scanDirectory(absolutePath);
      await this.notifyIndexChanged();
      return;
    }

    if (!fileStats.isFile()) {
      return;
    }

    this.files.set(relativePath, {
      path: relativePath,
      absolutePath,
      size: fileStats.size,
      type: normalizeType(relativePath),
      mtimeMs: fileStats.mtimeMs,
    });
    await this.notifyIndexChanged();
  }

  private removePath(relativePath: string): void {
    const normalizedPrefix = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
    this.files.delete(relativePath);
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(normalizedPrefix)) {
        this.files.delete(filePath);
      }
    }
  }

  private async notifyIndexChanged(): Promise<void> {
    if (!this.onIndexChange) {
      return;
    }

    try {
      await this.onIndexChange(this);
    } catch {
      return;
    }
  }
}
