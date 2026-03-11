import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { IndexedFile, ProjectIndexer } from "./projectIndexer.js";

export interface ProjectMemory {
  project_name: string;
  language: string;
  framework: string;
  architecture: string;
  important_files: string[];
  coding_conventions: string[];
  recent_changes: string[];
}

interface PersistedIndexSnapshot {
  updated_at: string;
  files: Array<Pick<IndexedFile, "path" | "size" | "type" | "mtimeMs">>;
}

interface ProjectSettingsSnapshot {
  project_root: string;
  initialized_at: string;
  last_indexed_at: string | null;
}

const DEFAULT_MEMORY: ProjectMemory = {
  project_name: "",
  language: "",
  framework: "",
  architecture: "",
  important_files: [],
  coding_conventions: [],
  recent_changes: [],
};

function isSafeFsError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return ["ENOENT", "EPERM", "EACCES", "ENOTDIR"].includes(String(error.code));
}

async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isSafeFsError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function detectPrimaryLanguage(files: IndexedFile[]): string {
  const scores = new Map<string, number>();
  const labels = new Map<string, string>([
    [".ts", "TypeScript"],
    [".tsx", "TypeScript"],
    [".js", "JavaScript"],
    [".jsx", "JavaScript"],
    [".py", "Python"],
    [".rs", "Rust"],
    [".go", "Go"],
    [".java", "Java"],
  ]);

  for (const file of files) {
    const extension = extname(file.path).toLowerCase();
    const label = labels.get(extension);
    if (!label) {
      continue;
    }

    scores.set(label, (scores.get(label) ?? 0) + 1);
  }

  return [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "Unknown";
}

function detectFramework(files: IndexedFile[]): string {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has("next.config.js") || paths.has("next.config.mjs")) {
    return "Next.js";
  }

  if (paths.has("package.json")) {
    if ([...paths].some((path) => path.startsWith("src/components/"))) {
      return "React";
    }

    return "Node.js";
  }

  if (paths.has("pyproject.toml")) {
    return "Python";
  }

  if (paths.has("Cargo.toml")) {
    return "Rust";
  }

  if (paths.has("go.mod")) {
    return "Go";
  }

  return "Unknown";
}

function detectArchitecture(files: IndexedFile[]): string {
  const paths = files.map((file) => file.path);
  if (paths.some((path) => path.startsWith("packages/"))) {
    return "Monorepo";
  }

  if (paths.some((path) => path.startsWith("src/components/")) && paths.some((path) => path.startsWith("src/pages/"))) {
    return "Frontend app";
  }

  if (paths.some((path) => path.startsWith("src/")) && paths.some((path) => path.startsWith("tests/"))) {
    return "Layered application";
  }

  return "Project";
}

function detectImportantFiles(files: IndexedFile[]): string[] {
  const candidates = files
    .map((file) => file.path)
    .filter((path) =>
      /^readme(\.[^.]+)?$/i.test(basename(path)) ||
      ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"].includes(path) ||
      path.startsWith("src/index.") ||
      path.startsWith("src/main.") ||
      path.startsWith("src/app."),
    );

  return [...new Set(candidates)].slice(0, 10);
}

function detectConventions(files: IndexedFile[]): string[] {
  const conventions: string[] = [];
  const paths = files.map((file) => file.path);

  if (paths.some((path) => path.endsWith(".ts") || path.endsWith(".tsx"))) {
    conventions.push("Prefer TypeScript source files.");
  }

  if (paths.some((path) => path === "package-lock.json")) {
    conventions.push("npm lockfile is committed.");
  }

  if (paths.some((path) => path.startsWith("src/"))) {
    conventions.push("Source code lives under src/.");
  }

  return conventions.slice(0, 8);
}

export class ProjectMemoryManager {
  private readonly stateDir: string;
  private readonly memoryPath: string;
  private readonly indexPath: string;
  private readonly settingsPath: string;
  private memory: ProjectMemory = { ...DEFAULT_MEMORY };

  public constructor(private readonly projectRoot: string) {
    this.stateDir = join(projectRoot, ".forgecode");
    this.memoryPath = join(this.stateDir, "memory.json");
    this.indexPath = join(this.stateDir, "index.json");
    this.settingsPath = join(this.stateDir, "settings.json");
  }

  public async initialize(projectIndexer: ProjectIndexer): Promise<void> {
    await this.ensureStateDirectory();

    const existingMemory = await safeReadJson<ProjectMemory>(this.memoryPath);
    this.memory = { ...DEFAULT_MEMORY, ...existingMemory };
    this.refreshDerivedMemory(projectIndexer.getIndexedFiles());
    await this.persistMemory();

    const settings = (await safeReadJson<ProjectSettingsSnapshot>(this.settingsPath)) ?? {
      project_root: this.projectRoot,
      initialized_at: new Date().toISOString(),
      last_indexed_at: null,
    };
    settings.project_root = this.projectRoot;
    settings.last_indexed_at = new Date().toISOString();
    await writeJson(this.settingsPath, settings);

    await this.persistIndex(projectIndexer);
  }

  public getMemory(): ProjectMemory {
    return { ...this.memory };
  }

  public buildPromptContext(): string {
    return [
      `Project name: ${this.memory.project_name || "Unknown"}`,
      `Primary language: ${this.memory.language || "Unknown"}`,
      `Framework: ${this.memory.framework || "Unknown"}`,
      `Architecture: ${this.memory.architecture || "Unknown"}`,
      `Important files: ${this.memory.important_files.join(", ") || "None"}`,
      `Coding conventions: ${this.memory.coding_conventions.join("; ") || "None recorded"}`,
      `Recent AI changes: ${this.memory.recent_changes.join(" | ") || "None recorded"}`,
    ].join("\n");
  }

  public async persistIndex(projectIndexer: ProjectIndexer): Promise<void> {
    await this.ensureStateDirectory();
    const snapshot: PersistedIndexSnapshot = {
      updated_at: new Date().toISOString(),
      files: projectIndexer.getIndexedFiles().map((file) => ({
        path: file.path,
        size: file.size,
        type: file.type,
        mtimeMs: file.mtimeMs,
      })),
    };

    await writeJson(this.indexPath, snapshot);
  }

  public async recordRecentChange(
    request: string,
    filePaths: string[],
    commitMessage?: string,
  ): Promise<void> {
    await this.ensureStateDirectory();
    const summary = [request.trim(), filePaths.length > 0 ? `${filePaths.length} files` : "", commitMessage ?? ""]
      .filter(Boolean)
      .join(" • ");

    this.memory.recent_changes = [summary, ...this.memory.recent_changes].slice(0, 12);
    await this.persistMemory();
  }

  public async refreshFromIndexer(projectIndexer: ProjectIndexer): Promise<void> {
    await this.ensureStateDirectory();
    this.refreshDerivedMemory(projectIndexer.getIndexedFiles());
    await this.persistMemory();
    await this.persistIndex(projectIndexer);
  }

  private refreshDerivedMemory(files: IndexedFile[]): void {
    this.memory.project_name = this.memory.project_name || basename(this.projectRoot);
    this.memory.language = detectPrimaryLanguage(files);
    this.memory.framework = detectFramework(files);
    this.memory.architecture = detectArchitecture(files);
    this.memory.important_files = detectImportantFiles(files);
    this.memory.coding_conventions = detectConventions(files);
  }

  private async persistMemory(): Promise<void> {
    await this.ensureStateDirectory();
    await writeJson(this.memoryPath, this.memory);
  }

  private async ensureStateDirectory(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
  }
}
