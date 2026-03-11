import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface GitStatusInfo {
  isRepository: boolean;
  branch: string | null;
  clean: boolean;
  changedFiles: number;
}

export interface PendingGitChange {
  kind: "write" | "delete";
  path: string;
  absolutePath: string;
  content: string | null;
  previousContent: string | null;
}

export interface DiffPreview {
  filesChanged: number;
  summaryLines: string[];
  diff: string;
}

interface RunGitOptions {
  allowedExitCodes?: number[];
}

export class GitOperationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitOperationError";
  }
}

function slugifyRequest(message: string): string {
  const stopWords = new Set(["the", "a", "an", "this", "that", "to", "for", "in", "on", "of", "with", "and"]);
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !stopWords.has(word));

  const slug = words.slice(0, 4).join("-") || "update";
  return slug.slice(0, 48).replace(/-+/g, "-");
}

export class GitManager {
  public constructor(private readonly projectRoot: string) {}

  public getProjectRoot(): string {
    return this.projectRoot;
  }

  public async isRepository(): Promise<boolean> {
    try {
      const gitDir = resolve(this.projectRoot, ".git");
      await lstat(gitDir);
      return true;
    } catch {
      return false;
    }
  }

  public async initializeRepository(): Promise<void> {
    await this.runGit(["init"]);
  }

  public async getStatus(): Promise<GitStatusInfo> {
    if (!(await this.isRepository())) {
      return {
        isRepository: false,
        branch: null,
        clean: true,
        changedFiles: 0,
      };
    }

    const branchResult = await this.tryRunGit(["branch", "--show-current"]);
    const branch = branchResult.ok ? branchResult.stdout.trim() || "main" : "main";
    const porcelain = (await this.runGit(["status", "--porcelain"])).trim();
    const changedFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;

    return {
      isRepository: true,
      branch,
      clean: changedFiles === 0,
      changedFiles,
    };
  }

  public formatStatusLine(status: GitStatusInfo): string {
    if (!status.isRepository || !status.branch) {
      return "branch: none";
    }

    return status.clean
      ? `branch: ${status.branch} • clean`
      : `branch: ${status.branch} • ${status.changedFiles} files changed`;
  }

  public async ensureForgeBranch(userRequest: string): Promise<string | null> {
    const status = await this.getStatus();
    if (!status.isRepository) {
      return null;
    }

    if (status.branch?.startsWith("forge/")) {
      return status.branch;
    }

    const branchName = `forge/${slugifyRequest(userRequest)}`;
    await this.runGit(["checkout", "-b", branchName]);
    return branchName;
  }

  public async buildDiffPreview(changes: PendingGitChange[]): Promise<DiffPreview> {
    const previewRoot = await mkdtemp(join(tmpdir(), "forgecode-diff-"));
    try {
      const summaryLines: string[] = [];
      const patches: string[] = [];

      for (const change of changes) {
        const beforePath = join(previewRoot, "before", change.path);
        const afterPath = join(previewRoot, "after", change.path);

        if (change.previousContent !== null) {
          await mkdir(dirname(beforePath), { recursive: true });
          await writeFile(beforePath, change.previousContent, "utf8");
        }

        let patch = "";
        if (change.kind === "delete") {
          const afterTarget = "/dev/null";
          patch = await this.runGit(
            ["diff", "--no-index", "--", beforePath, afterTarget],
            { allowedExitCodes: [0, 1] },
          );
        } else {
          await mkdir(dirname(afterPath), { recursive: true });
          await writeFile(afterPath, change.content ?? "", "utf8");
          const beforeTarget = change.previousContent === null ? "/dev/null" : beforePath;
          patch = await this.runGit(
            ["diff", "--no-index", "--", beforeTarget, afterPath],
            { allowedExitCodes: [0, 1] },
          );
        }

        patches.push(patch.trimEnd());
        summaryLines.push(
          `${change.path} • ${
            change.kind === "delete"
              ? "delete"
              : change.previousContent === null
                ? "create"
                : "update"
          }`,
        );
      }

      return {
        filesChanged: changes.length,
        summaryLines,
        diff: patches.filter(Boolean).join("\n\n"),
      };
    } finally {
      await rm(previewRoot, { recursive: true, force: true });
    }
  }

  public async commitFiles(message: string, filePaths: string[]): Promise<void> {
    if (!(await this.isRepository())) {
      return;
    }

    if (filePaths.length === 0) {
      return;
    }

    await this.runGit(["add", "--", ...filePaths]);
    await this.runGit(["commit", "-m", message, "--", ...filePaths]);
  }

  public async commitAllChanges(message: string): Promise<void> {
    if (!(await this.isRepository())) {
      throw new GitOperationError("Git operation failed. Please check repository state.");
    }

    await this.runGit(["add", "."]);
    await this.runGit(["commit", "-m", message]);
  }

  public async undoLastAiCommit(count = 1): Promise<"undone" | "no_changes"> {
    if (!(await this.isRepository())) {
      return "no_changes";
    }

    const undoCount = Math.max(1, count);
    for (let index = 0; index < undoCount; index += 1) {
      const hasParent = await this.tryRunGit(["rev-parse", "--verify", "HEAD~1"]);
      if (!hasParent.ok) {
        return index === 0 ? "no_changes" : "undone";
      }

      const subject = (await this.runGit(["log", "-1", "--pretty=%s"])).trim();
      if (!subject.startsWith("forge: ")) {
        return index === 0 ? "no_changes" : "undone";
      }

      await this.runGit(["reset", "--hard", "HEAD~1"]);
    }

    return "undone";
  }

  public async getWorkingTreeSnapshot(): Promise<string> {
    if (!(await this.isRepository())) {
      throw new GitOperationError("Git operation failed. Please check repository state.");
    }

    const status = (await this.runGit(["status", "--porcelain"])).trim();
    if (!status) {
      return "";
    }

    const diff = (await this.runGit(["diff", "--", "."], { allowedExitCodes: [0, 1] })).trim();
    const stagedDiff = (
      await this.runGit(["diff", "--cached", "--", "."], { allowedExitCodes: [0, 1] })
    ).trim();
    const untrackedFiles = status
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3));
    const untrackedBlocks: string[] = [];

    for (const filePath of untrackedFiles.slice(0, 10)) {
      try {
        const content = await readFile(resolve(this.projectRoot, filePath), "utf8");
        untrackedBlocks.push(`Untracked file: ${filePath}\n${content.slice(0, 4000)}`);
      } catch {
        untrackedBlocks.push(`Untracked file: ${filePath}`);
      }
    }

    return [diff, stagedDiff, untrackedBlocks.join("\n\n")].filter(Boolean).join("\n\n");
  }

  private async runGit(args: string[], options: RunGitOptions = {}): Promise<string> {
    const result = await this.tryRunGit(args, options);
    if (result.ok) {
      return result.stdout;
    }

    throw new GitOperationError(
      result.stderr.trim() || "Git operation failed. Please check repository state.",
    );
  }

  private async tryRunGit(
    args: string[],
    options: RunGitOptions = {},
  ): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
    return await new Promise((resolvePromise) => {
      const child = spawn("git", args, {
        cwd: this.projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        resolvePromise({
          ok: false,
          stdout,
          stderr: error.message,
          exitCode: null,
        });
      });

      child.on("close", (exitCode) => {
        const allowed = new Set(options.allowedExitCodes ?? [0]);
        resolvePromise({
          ok: allowed.has(exitCode ?? 0),
          stdout,
          stderr,
          exitCode,
        });
      });
    });
  }
}
