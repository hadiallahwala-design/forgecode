import { resolve, relative } from "node:path";

export class WorkspaceGuard {
  public constructor(private readonly rootDir: string) {}

  public resolvePath(targetPath: string): string {
    if (targetPath.includes("../") || targetPath.includes("..\\")) {
      throw new Error("Parent directory segments are not allowed.");
    }

    const absolutePath = resolve(this.rootDir, targetPath);
    const relativePath = relative(this.rootDir, absolutePath);

    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new Error("Access outside the project directory is not allowed.");
    }

    return absolutePath;
  }

  public getRootDir(): string {
    return this.rootDir;
  }
}
