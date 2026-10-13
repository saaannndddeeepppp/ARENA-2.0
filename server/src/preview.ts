import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { workspacePath } from "./workspace.js";

type Preview = {
  id: string;
  sessionId: string;
  port: number;
  command: string;
  pid: number | undefined;
  child: ChildProcess;
  state: "starting" | "ready" | "error" | "stopped";
  startedAt: number;
  output: string;
  lastError?: string;
};
const previews = new Map<string, Preview>();
const keyOf = (sessionId: string, port: number) => `${sessionId}:${port}`;
const safePort = (port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65535;
const clip = (value: string, limit = 12000) =>
  value.length > limit ? value.slice(-limit) : value;

export type PreviewInfo = {
  id: string;
  sessionId: string;
  port: number;
  command: string;
  state: Preview["state"];
  url: string;
  pid?: number;
  startedAt: number;
  output: string;
  lastError?: string;
};
function info(item: Preview): PreviewInfo {
  return {
    id: item.id,
    sessionId: item.sessionId,
    port: item.port,
    command: item.command,
    state: item.state,
    url: `http://127.0.0.1:${item.port}/`,
    ...(item.pid ? { pid: item.pid } : {}),
    startedAt: item.startedAt,
    output: item.output,
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}
function isAlive(item: Preview) {
  return item.child.exitCode === null && item.child.signalCode === null;
}
function killTree(item: Preview) {
  if (!isAlive(item)) return;
  try {
    if (item.pid && process.platform !== "win32")
      process.kill(-item.pid, "SIGTERM");
    else item.child.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      if (item.pid && process.platform !== "win32")
        process.kill(-item.pid, "SIGKILL");
      else item.child.kill("SIGKILL");
    } catch {}
  }, 3000);
  timer.unref();
}
async function waitUntilReady(
  item: Preview,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error("Preview start was cancelled.");
    if (!isAlive(item))
      throw new Error(
        `Preview process exited before becoming ready. ${item.output.slice(-1800)}`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${item.port}/`, {
        signal: AbortSignal.timeout(1200),
        redirect: "manual",
      });
      if (response.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(
    `No HTTP server became ready on 127.0.0.1:${item.port} within ${timeoutMs / 1000}s. ${item.output.slice(-1800)}`,
  );
}
export async function startPreview(
  sessionId: string,
  command: string,
  port: number,
  timeoutMs = 20000,
  signal?: AbortSignal,
): Promise<PreviewInfo> {
  if (!safePort(port))
    throw new Error("Preview port must be an integer from 1 to 65535.");
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 4000)
    throw new Error(
      "Provide a non-empty preview start command (max 4000 characters).",
    );
  const key = keyOf(sessionId, port);
  const prior = previews.get(key);
  if (prior && isAlive(prior)) {
    if (prior.state === "ready") return info(prior);
    killTree(prior);
  }
  const cwd = resolve(workspacePath(sessionId));
  const child = spawn("bash", ["-lc", trimmed], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TZ: process.env.TZ ?? "UTC",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const entry: Preview = {
    id: randomUUID(),
    sessionId,
    port,
    command: trimmed,
    pid: child.pid,
    child,
    state: "starting",
    startedAt: Date.now(),
    output: "",
  };
  previews.set(key, entry);
  child.stdout?.on("data", (b: Buffer) => {
    entry.output = clip(entry.output + b.toString());
  });
  child.stderr?.on("data", (b: Buffer) => {
    entry.output = clip(entry.output + b.toString());
  });
  child.on("error", (error) => {
    entry.state = "error";
    entry.lastError = error.message;
  });
  child.on("exit", (code, sig) => {
    if (entry.state !== "stopped") {
      entry.state = "error";
      entry.lastError = `Preview process exited (${code ?? sig ?? "unknown"}).`;
    }
  });
  try {
    await waitUntilReady(entry, timeoutMs, signal);
    entry.state = "ready";
    return info(entry);
  } catch (error) {
    entry.state = "error";
    entry.lastError = error instanceof Error ? error.message : String(error);
    killTree(entry);
    throw error;
  }
}
export function getPreview(
  sessionId: string,
  port: number,
): PreviewInfo | null {
  const item = previews.get(keyOf(sessionId, port));
  if (!item) return null;
  if (item.state === "ready" && !isAlive(item)) item.state = "error";
  return info(item);
}
export function listPreviews(sessionId: string): PreviewInfo[] {
  return [...previews.values()]
    .filter((p) => p.sessionId === sessionId)
    .map((p) => {
      if (p.state === "ready" && !isAlive(p)) p.state = "error";
      return info(p);
    });
}
export function stopPreview(sessionId: string, port?: number) {
  const targets = [...previews.entries()].filter(
    ([, item]) =>
      item.sessionId === sessionId &&
      (port === undefined || item.port === port),
  );
  for (const [key, item] of targets) {
    killTree(item);
    item.state = "stopped";
    previews.delete(key);
  }
  return { stopped: targets.length };
}
export function stopAllPreviews() {
  for (const item of previews.values()) {
    killTree(item);
    item.state = "stopped";
  }
  const count = previews.size;
  previews.clear();
  return count;
}
export function getPreviewOutput(sessionId: string, port: number) {
  return getPreview(sessionId, port)?.output ?? "";
}
