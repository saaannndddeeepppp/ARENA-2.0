import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, now } from "./db.js";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { workspacePath } from "./workspace.js";

const execFile = promisify(execFileCb);
const ghApi = "https://api.github.com";
const tokenSchema = z.string().min(20).max(500);
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const branchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((s) => !s.includes("..") && !s.startsWith("-") && !s.endsWith("/"));

type GitHubRow = { credential_enc: string; config_json: string };
type Repo = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  html_url: string;
  description: string | null;
};
export type GitHubStatus = {
  connected: boolean;
  user?: { login: string; name?: string | null; avatar_url?: string };
  selectedRepos: string[];
  rateLimit?: { remaining: number; resetAt: number };
};

function row(): GitHubRow | undefined {
  return db
    .prepare(
      "SELECT credential_enc,config_json FROM connectors WHERE id='github'",
    )
    .get() as GitHubRow | undefined;
}
function configValue(): Record<string, unknown> {
  try {
    return JSON.parse(row()?.config_json ?? "{}");
  } catch {
    return {};
  }
}
function token(): string {
  const value = row()?.credential_enc;
  return value ? decrypt(value) : "";
}
function save(tokenValue: string, value: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO connectors(id,credential_enc,config_json,updated_at) VALUES('github',?,?,?) ON CONFLICT(id) DO UPDATE SET credential_enc=excluded.credential_enc,config_json=excluded.config_json,updated_at=excluded.updated_at",
  ).run(encrypt(tokenValue), JSON.stringify(value), now());
}
function headers(): Record<string, string> {
  const secret = token();
  if (!secret)
    throw new Error(
      "Connect a GitHub personal access token in Settings first.",
    );
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${secret}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GalaxyAgentLocal",
  };
}
async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; rateLimit: { remaining: number; resetAt: number } }> {
  const response = await fetch(`${ghApi}${path}`, {
    ...init,
    headers: {
      ...headers(),
      ...(init.headers as Record<string, string> | undefined),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: init.signal ?? AbortSignal.timeout(25000),
  });
  const text = await response.text();
  const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? -1);
  const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 1000);
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : String(body ?? "");
    const reset = resetAt
      ? ` Rate limit resets at ${new Date(resetAt).toLocaleTimeString()}.`
      : "";
    throw new Error(
      `GitHub API returned ${response.status}: ${detail.slice(0, 400)}${response.status === 403 && remaining === 0 ? reset : ""}`,
    );
  }
  return { data: body as T, rateLimit: { remaining, resetAt } };
}
export async function githubConnect(pat: string) {
  const credential = tokenSchema.parse(pat.trim());
  const response = await fetch(`${ghApi}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credential}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GalaxyAgentLocal",
    },
    signal: AbortSignal.timeout(20000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    login?: string;
    name?: string | null;
    avatar_url?: string;
    message?: string;
  };
  if (!response.ok || !payload.login)
    throw new Error(
      `GitHub token validation failed (${response.status}): ${payload.message ?? "No user returned."}`,
    );
  const old = configValue();
  save(credential, {
    ...old,
    user: {
      login: payload.login,
      name: payload.name,
      avatar_url: payload.avatar_url,
    },
    selectedRepos: Array.isArray(old.selectedRepos) ? old.selectedRepos : [],
  });
  return {
    connected: true,
    user: {
      login: payload.login,
      name: payload.name,
      avatar_url: payload.avatar_url,
    },
    repositories: await githubListRepos(),
  };
}
export async function githubStatus(): Promise<GitHubStatus> {
  const r = row();
  const cfg = configValue();
  const result: GitHubStatus = {
    connected: Boolean(r?.credential_enc),
    selectedRepos: Array.isArray(cfg.selectedRepos)
      ? cfg.selectedRepos.filter((x): x is string => typeof x === "string")
      : [],
  };
  if (cfg.user && typeof cfg.user === "object")
    result.user = cfg.user as NonNullable<GitHubStatus["user"]>;
  if (cfg.rateLimit && typeof cfg.rateLimit === "object")
    result.rateLimit = cfg.rateLimit as NonNullable<GitHubStatus["rateLimit"]>;
  return result;
}
export async function githubListRepos(): Promise<Repo[]> {
  const repos: Repo[] = [];
  let latestLimit: { remaining: number; resetAt: number } | undefined;
  for (let page = 1; page <= 10; page++) {
    const { data, rateLimit } = await request<Repo[]>(
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    );
    latestLimit = rateLimit;
    repos.push(...data);
    if (data.length < 100) break;
  }
  if (latestLimit) {
    const cfg = configValue();
    save(token(), { ...cfg, rateLimit: latestLimit });
  }
  return repos;
}
export function githubSelectRepos(fullNames: unknown) {
  const repos = z.array(repoSchema).max(1000).parse(fullNames);
  const cfg = configValue();
  save(token(), { ...cfg, selectedRepos: [...new Set(repos)] });
  return { selectedRepos: [...new Set(repos)] };
}
export function githubDisconnect() {
  const cfg = configValue();
  save("", { ...cfg, user: undefined });
  return {
    connected: false,
    selectedRepos: Array.isArray(cfg.selectedRepos) ? cfg.selectedRepos : [],
  };
}
async function git(
  sessionId: string,
  args: string[],
  timeout = 60000,
): Promise<string> {
  const cwd = workspacePath(sessionId);
  const tokenValue = token();
  if (!tokenValue) throw new Error("GitHub is disconnected.");
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${tokenValue}`).toString("base64")}`;
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    env,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
}
function boundSession(sessionId: string) {
  const s = db
    .prepare(
      "SELECT id,workspace_path,repo_full_name,repo_branch,repo_base_branch,github_pr_number,repo_locked FROM sessions WHERE id=?",
    )
    .get(sessionId) as
    | {
        id: string;
        workspace_path: string;
        repo_full_name: string | null;
        repo_branch: string | null;
        repo_base_branch: string | null;
        github_pr_number: number | null;
        repo_locked: number;
      }
    | undefined;
  if (!s) throw new Error("Session not found.");
  return s;
}
export async function githubClone(
  sessionId: string,
  fullNameRaw: string,
  baseBranchRaw: string,
) {
  const fullName = repoSchema.parse(fullNameRaw);
  const baseBranch = branchSchema.parse(baseBranchRaw);
  const session = boundSession(sessionId);
  if (session.repo_full_name)
    throw new Error("This session is already bound to a repository.");
  const selected = githubStatus();
  if (!(await selected).selectedRepos.includes(fullName))
    throw new Error(
      "Select this repository in GitHub settings before binding it to a session.",
    );
  const root = resolve(session.workspace_path);
  const existing = await readdir(root);
  if (existing.length)
    throw new Error(
      "The session workspace is not empty; repository clone cancelled.",
    );
  const temp = resolve(
    config.workspacesDir,
    `.clone-${sessionId}-${randomUUID()}`,
  );
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    await git(sessionId, [
      "clone",
      "--depth",
      "50",
      "--single-branch",
      "-b",
      baseBranch,
      `https://github.com/${fullName}.git`,
      temp,
    ]);
  } catch (e) {
    await rm(temp, { recursive: true, force: true });
    throw new Error(
      `Repository clone failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const slug =
    fullName
      .split("/")
      .at(-1)!
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 40) || "work";
  const branch = `galaxy/${sessionId.slice(0, 8)}-${slug}`;
  try {
    const { stdout, stderr } = await execFile(
      "git",
      ["checkout", "-b", branch],
      {
        cwd: temp,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
        timeout: 15000,
        windowsHide: true,
      },
    );
    void stdout;
    void stderr;
    await cp(temp, root, { recursive: true, force: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  db.prepare(
    "UPDATE sessions SET repo_full_name=?,repo_branch=?,repo_base_branch=?,repo_locked=0,updated_at=? WHERE id=?",
  ).run(fullName, branch, baseBranch, now(), sessionId);
  return { repo: fullName, baseBranch, branch };
}
export async function githubStatusForSession(sessionId: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name) return { connected: false };
  return {
    connected: true,
    repo: s.repo_full_name,
    branch: s.repo_branch,
    baseBranch: s.repo_base_branch,
    pullRequest: s.github_pr_number,
    locked: Boolean(s.repo_locked),
  };
}
export async function gitStatus(sessionId: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    return {
      connected: false,
      message: "No repository is bound to this session.",
    };
  return {
    connected: true,
    branch: s.repo_branch,
    status: await git(sessionId, ["status", "--short", "--branch"]),
    log: await git(sessionId, ["log", "-5", "--oneline"]),
  };
}
export async function gitDiff(sessionId: string, fullBranch = false) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("Connect a GitHub repository to inspect diffs.");
  const base = s.repo_base_branch!;
  const diff = fullBranch
    ? await git(sessionId, [
        "diff",
        "--no-ext-diff",
        "--binary",
        `${base}...HEAD`,
      ])
    : await git(sessionId, ["diff", "--no-ext-diff", "--binary"]);
  const unstaged = await git(sessionId, [
    "diff",
    "--no-ext-diff",
    "--binary",
    "--cached",
  ]);
  return {
    branch: s.repo_branch,
    base,
    diff: [diff, unstaged].filter(Boolean).join("\n"),
    stats: await git(sessionId, ["diff", "--stat", `${base}...HEAD`]),
  };
}
export async function gitCommit(sessionId: string, message: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  if (s.repo_locked)
    throw new Error(
      "This session is locked because its pull request was merged or closed.",
    );
  const valid = z.string().min(5).max(200).parse(message.trim());
  if (
    !/^(feat|fix|refactor|test|docs|chore|perf|build|ci)(\([^)]+\))?: .+/.test(
      valid,
    )
  )
    throw new Error(
      "Use a conventional commit subject such as 'feat: add validation'.",
    );
  await git(sessionId, ["add", "-A"]);
  await git(sessionId, [
    "-c",
    "user.name=Galaxy Agent",
    "-c",
    "user.email=agent@localhost",
    "commit",
    "-m",
    valid,
  ]);
  return {
    commit: await git(sessionId, ["rev-parse", "HEAD"]),
    message: valid,
  };
}
export async function gitPush(sessionId: string) {
  await githubRefreshSessionLock(sessionId);
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  if (s.repo_locked)
    throw new Error(
      "Push is locked because this session's pull request was merged or closed.",
    );
  try {
    await git(sessionId, ["push", "-u", "origin", s.repo_branch!]);
  } catch (first) {
    try {
      await git(sessionId, ["fetch", "origin", s.repo_base_branch!]);
      await git(sessionId, ["rebase", `origin/${s.repo_base_branch}`]);
      await git(sessionId, ["push", "-u", "origin", s.repo_branch!]);
    } catch (second) {
      throw new Error(
        `Push failed after one fetch/rebase retry. Initial error: ${String(first)}. Retry error: ${String(second)}`,
      );
    }
  }
  return { pushed: true, branch: s.repo_branch };
}
export async function githubCreatePR(
  sessionId: string,
  title: string,
  body: string,
  draft = false,
) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  if (s.repo_locked) throw new Error("This session is locked.");
  if (s.github_pr_number)
    throw new Error("Only one pull request can be created per chat session.");
  await gitPush(sessionId);
  const result = await request<{
    number: number;
    html_url: string;
    state: string;
  }>(`/repos/${s.repo_full_name}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: z.string().min(1).max(256).parse(title),
      body: z.string().max(60000).parse(body),
      head: s.repo_branch,
      base: s.repo_base_branch,
      draft,
    }),
  });
  db.prepare("UPDATE sessions SET github_pr_number=? WHERE id=?").run(
    result.data.number,
    sessionId,
  );
  return {
    number: result.data.number,
    url: result.data.html_url,
    state: result.data.state,
  };
}
export async function githubListPRs(sessionId: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  const { data } = await request<
    Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      head: { ref: string };
      base: { ref: string };
    }>
  >(`/repos/${s.repo_full_name}/pulls?state=all&per_page=30`);
  return data;
}
export async function githubMergePR(
  sessionId: string,
  number: number,
  method: "merge" | "squash" | "rebase" = "squash",
) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  const { data } = await request<{ merged: boolean; message: string }>(
    `/repos/${s.repo_full_name}/pulls/${z.number().int().positive().parse(number)}/merge`,
    { method: "PUT", body: JSON.stringify({ merge_method: method }) },
  );
  if (data.merged)
    db.prepare("UPDATE sessions SET repo_locked=1 WHERE id=?").run(sessionId);
  return data;
}
export async function githubChecks(sessionId: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name)
    throw new Error("No repository is bound to this session.");
  const sha = (await git(sessionId, ["rev-parse", "HEAD"])).trim();
  const [{ data: checkRuns }, { data: status }] = await Promise.all([
    request<{ check_runs: Array<Record<string, unknown>> }>(
      `/repos/${s.repo_full_name}/commits/${sha}/check-runs`,
    ),
    request<Record<string, unknown>>(
      `/repos/${s.repo_full_name}/commits/${sha}/status`,
    ),
  ]);
  return { sha, checkRuns: checkRuns.check_runs, status };
}
export async function githubRefreshSessionLock(sessionId: string) {
  const s = boundSession(sessionId);
  if (!s.repo_full_name || !s.github_pr_number)
    return { locked: Boolean(s.repo_locked) };
  const { data } = await request<{ state: string; merged_at: string | null }>(
    `/repos/${s.repo_full_name}/pulls/${s.github_pr_number}`,
  );
  const locked = data.state === "closed" || Boolean(data.merged_at);
  if (locked && !s.repo_locked)
    db.prepare("UPDATE sessions SET repo_locked=1 WHERE id=?").run(sessionId);
  return { locked };
}
export async function githubFileStats(sessionId: string) {
  const s = boundSession(sessionId);
  const root = workspacePath(sessionId);
  if (!s.repo_full_name) return { files: 0, bytes: 0 };
  const result = await git(sessionId, ["status", "--porcelain"]);
  let files = 0,
    bytes = 0;
  for (const line of result.split("\n")) {
    const path = line.slice(3).trim();
    if (!path) continue;
    files++;
    try {
      const info = await stat(resolve(root, path));
      if (info.isFile()) bytes += info.size;
    } catch {
      /* deleted files have no current size */
    }
  }
  return { files, bytes };
}
