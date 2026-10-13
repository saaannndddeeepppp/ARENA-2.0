import {
  mkdir,
  realpath,
  stat,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve, sep, relative, extname } from "node:path";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

const ignored = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  ".galaxy-uploads",
  ".arena-uploads",
]);
export function workspacePath(sessionId: string): string {
  return resolve(config.workspacesDir, sessionId);
}
export function safePath(root: string, input: string): string {
  const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error("Path is outside this session workspace.");
  return target;
}
export async function assertConfined(
  root: string,
  target: string,
  allowNew = false,
): Promise<void> {
  const base = await realpath(root);
  let candidate = target;
  if (allowNew && !(await exists(target))) {
    let parent = resolve(target, "..");
    while (parent !== root && !(await exists(parent)))
      parent = resolve(parent, "..");
    candidate = parent;
  }
  const actual = await realpath(candidate);
  if (actual !== base && !actual.startsWith(base + sep))
    throw new Error("Path resolves outside this session workspace.");
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
export async function listTree(root: string): Promise<
  Array<{
    path: string;
    size: number;
    kind: "file" | "directory";
    modifiedAt: number;
  }>
> {
  const out: Array<{
    path: string;
    size: number;
    kind: "file" | "directory";
    modifiedAt: number;
  }> = [];
  async function visit(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        ignored.has(entry.name) ||
        entry.name.endsWith(".log") ||
        entry.isSymbolicLink()
      )
        continue;
      const full = resolve(dir, entry.name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      const rel = relative(root, full);
      out.push({
        path: rel,
        size: info.isFile() ? info.size : 0,
        kind: info.isDirectory() ? "directory" : "file",
        modifiedAt: info.mtimeMs,
      });
      if (info.isDirectory()) await visit(full);
    }
  }
  await visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
export async function ensureFile(
  root: string,
  path: string,
  content: string,
): Promise<{ path: string; bytesWritten: number; created: boolean }> {
  const target = safePath(root, path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await assertConfined(root, target, true);
  let created = true;
  try {
    await stat(target);
    created = false;
  } catch {}
  const bytes = Buffer.byteLength(content);
  await writeFile(target, content, { encoding: "utf8" });
  return { path: relative(root, target), bytesWritten: bytes, created };
}
export async function makeZip(
  root: string,
  destination: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", () => resolvePromise());
    archive.on("error", reject);
    output.on("error", reject);
    archive.pipe(output);
    archive.glob("**/*", {
      cwd: root,
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "**/*.log"],
    });
    void archive.finalize();
  });
}
export function fileKind(path: string): string {
  const ext = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".csv", ".tsv"].includes(ext)) return "csv";
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".flac"].includes(ext))
    return "audio";
  return "code";
}
