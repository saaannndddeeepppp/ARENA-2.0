import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addMessage, db, now } from "./db.js";
import { publish } from "./events.js";
import {
  assertConfined,
  ensureFile,
  fileKind,
  safePath,
  workspacePath,
} from "./workspace.js";
import { config } from "./config.js";
import { getProvider, providerSecret } from "./providers.js";
import {
  githubChecks,
  githubCreatePR,
  githubListPRs,
  githubMergePR,
  gitCommit,
  gitDiff,
  gitPush,
  gitStatus,
} from "./github.js";
import { listPreviews, startPreview, stopPreview } from "./preview.js";
import {
  googleCalendarEvents,
  gmailList,
  googleDriveSearch,
  linearIssues,
  notionSearch,
} from "./connectors.js";
import { extractPdfText, imageInfo } from "./media.js";

type ToolContext = { sessionId: string; signal: AbortSignal };
type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodTypeAny;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
};
const approvalWaiters = new Map<string, (value: unknown) => void>();
export function resolveApproval(id: string, approved: boolean) {
  const fn = approvalWaiters.get(id);
  if (fn) {
    approvalWaiters.delete(id);
    fn(approved);
    return true;
  }
  return false;
}
const clip = (s: string, max = 20000) =>
  s.length > max
    ? `${s.slice(0, max)}\n[truncated: ${s.length - max} characters omitted]`
    : s;
const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  schema: z.ZodTypeAny,
  run: ToolDef["run"],
): ToolDef => ({ name, description, parameters, schema, run });
const dangerPatterns = [
  /\brm\s+-rf\s+\//i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\)\s*\{/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash)/i,
  /\bgit\s+push\s+--force/i,
];
function executeShell(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  cwd: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    let stdout = "",
      stderr = "";
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      TZ: process.env.TZ ?? "UTC",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      NODE_ENV: process.env.NODE_ENV ?? "production",
    };
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }, 1500).unref();
        } catch {}
    };
    const timer = setTimeout(kill, timeout);
    signal.addEventListener("abort", kill, { once: true });
    child.stdout?.on("data", (b) => (stdout += b.toString()));
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolvePromise({
        exitCode: code,
        signal: sig,
        stdout: clip(stdout, 30000),
        stderr: clip(stderr, 30000),
        durationMs: Date.now() - started,
        cwd,
      });
    });
  });
}
function validatePublicUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new Error(
      "Requests to local and private network addresses are blocked.",
    );
  return url;
}
function authHeadersForImage(
  provider: ReturnType<typeof getProvider>,
  key: string,
) {
  return {
    ...JSON.parse(provider.headers_json),
    ...(provider.kind === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${key}` }),
  } as Record<string, string>;
}
const handlers: ToolDef[] = [
  tool(
    "bash",
    "Run a shell command in this session workspace. Long-running commands are bounded and the process group is terminated on timeout or stop.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "integer" },
        description: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    z.object({
      command: z.string().min(1).max(12000),
      cwd: z.string().optional(),
      timeout: z.number().int().min(1000).max(1800000).optional(),
      description: z.string().optional(),
    }),
    async (ctx, args) => {
      const command = String(args.command);
      const root = workspacePath(ctx.sessionId);
      const directory = safePath(root, String(args.cwd ?? "."));
      await assertConfined(root, directory, true);
      if (dangerPatterns.some((re) => re.test(command))) {
        const approvalId = randomUUID();
        publish(ctx.sessionId, "approval_required", {
          approvalId,
          command: clip(command, 1000),
          message:
            "This command matches a high-impact shell pattern. Approve it explicitly to continue.",
        });
        const allowed = await new Promise<boolean>((resolvePromise) => {
          approvalWaiters.set(approvalId, (value) =>
            resolvePromise(value === true),
          );
          const timeout = setTimeout(
            () => {
              approvalWaiters.delete(approvalId);
              resolvePromise(false);
            },
            5 * 60 * 1000,
          );
          timeout.unref();
        });
        if (!allowed)
          return {
            error: true,
            code: "SANDBOX_DENIED",
            message: "The shell command was not approved.",
            retryable: false,
          };
      }
      return executeShell(
        command,
        directory,
        Number(args.timeout ?? 120000),
        ctx.signal,
      );
    },
  ),
  tool(
    "read_file",
    "Read a text file inside the workspace, with optional 1-based line range.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        line_offset: { type: "integer" },
        line_limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    z.object({
      path: z.string(),
      line_offset: z.number().int().min(1).optional(),
      line_limit: z.number().int().min(1).max(10000).optional(),
    }),
    async (ctx, args) => {
      const root = workspacePath(ctx.sessionId),
        path = safePath(root, String(args.path));
      await assertConfined(root, path);
      const info = await stat(path);
      if (!info.isFile())
        throw new Error("The requested path is not a regular file.");
      if (info.size > 10 * 1024 * 1024)
        throw new Error("File is larger than the 10 MB text-read limit.");
      const buf = await readFile(path);
      const lowerPath = String(args.path).toLowerCase();
      if (lowerPath.endsWith(".pdf")) {
        const extracted = extractPdfText(buf);
        return {
          path: String(args.path),
          type: "pdf",
          size: info.size,
          content:
            extracted.text ||
            "(No extractable text found in this PDF; it may be scanned, encrypted, or use unsupported filters.)",
          streams: extracted.streams,
          truncated: extracted.truncated,
        };
      }
      const img = imageInfo(buf);
      if (img) {
        return {
          path: String(args.path),
          type: "image",
          format: img.format,
          width: img.width || undefined,
          height: img.height || undefined,
          size: info.size,
          note: "Image metadata extracted locally. Describe/inspect it with present_file so the user can view it; pixel-level understanding requires a vision-capable model.",
        };
      }
      if (buf.includes(0))
        return {
          type: "binary",
          size: info.size,
          mime: "application/octet-stream",
          preview: buf.subarray(0, 64).toString("hex"),
        };
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      const offset = Number(args.line_offset ?? 1) - 1;
      const limit = Number(args.line_limit ?? 2000);
      return {
        path: String(args.path),
        totalLines: lines.length,
        content: lines
          .slice(offset, offset + limit)
          .map((line, i) => `${offset + i + 1}: ${line}`)
          .join("\n"),
        truncated: offset + limit < lines.length,
      };
    },
  ),
  tool(
    "write_file",
    "Create or overwrite a text file in the workspace. Parent directories are created automatically.",
    {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    z.object({ path: z.string().min(1), content: z.string().max(10_000_000) }),
    async (ctx, args) => {
      const root = workspacePath(ctx.sessionId);
      const result = await ensureFile(
        root,
        String(args.path),
        String(args.content),
      );
      publish(ctx.sessionId, "file_changed", {
        path: result.path,
        action: result.created ? "created" : "modified",
        bytes: result.bytesWritten,
      });
      return result;
    },
  ),
  tool(
    "edit_file",
    "Replace a unique exact string within a workspace file; use replace_all only when intended.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    z.object({
      path: z.string(),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    async (ctx, args) => {
      const root = workspacePath(ctx.sessionId),
        target = safePath(root, String(args.path));
      await assertConfined(root, target);
      const before = await readFile(target, "utf8");
      const old = String(args.old_string),
        all = Boolean(args.replace_all);
      const matches = before.split(old).length - 1;
      if (matches === 0)
        return {
          error: true,
          code: "TOOL_ERROR",
          message:
            "Exact text was not found. Read the file and retry with a more precise match.",
          retryable: true,
        };
      if (matches > 1 && !all)
        return {
          error: true,
          code: "TOOL_ERROR",
          message: `The old text matched ${matches} places. Add surrounding context or set replace_all.`,
          retryable: true,
        };
      const after = all
        ? before.split(old).join(String(args.new_string))
        : before.replace(old, String(args.new_string));
      await writeFile(target, after);
      publish(ctx.sessionId, "file_changed", {
        path: String(args.path),
        action: "modified",
        bytes: Buffer.byteLength(after),
      });
      return {
        path: String(args.path),
        strategy: "exact",
        replacements: all ? matches : 1,
        bytesDelta: Buffer.byteLength(after) - Buffer.byteLength(before),
      };
    },
  ),
  tool(
    "present_file",
    "Mark a workspace file as a user-facing deliverable and open it in the Files panel.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    z.object({
      path: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    async (ctx, args) => {
      const root = workspacePath(ctx.sessionId),
        target = safePath(root, String(args.path));
      await assertConfined(root, target);
      const info = await stat(target);
      const artifactId = randomUUID();
      const mime =
        (
          {
            ".md": "text/markdown",
            ".html": "text/html",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".pdf": "application/pdf",
            ".csv": "text/csv",
            ".json": "application/json",
          } as Record<string, string>
        )[extname(target).toLowerCase()] ?? "text/plain";
      db.prepare(
        "INSERT INTO artifacts(id,session_id,path,mime,size,kind,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        artifactId,
        ctx.sessionId,
        String(args.path),
        mime,
        info.size,
        fileKind(String(args.path)),
        now(),
      );
      const title = String(args.title ?? basename(String(args.path)));
      publish(ctx.sessionId, "artifact_present", {
        artifactId,
        path: String(args.path),
        title,
        mime,
        size: info.size,
        description: args.description ?? "",
      });
      return {
        artifactId,
        path: String(args.path),
        title,
        mime,
        size: info.size,
      };
    },
  ),
  tool(
    "web_search",
    "Search public web pages using DuckDuckGo HTML results without requiring a search key.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    z.object({
      query: z.string().min(2).max(500),
      depth: z.number().int().min(1).max(3).optional(),
    }),
    async (_ctx, args) => {
      const query = String(args.query);
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: { "User-Agent": "GalaxyAgentLocal/1.3" },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        throw new Error(`Search provider returned ${response.status}.`);
      const html = await response.text();
      const results: Array<{ title: string; url: string; snippet: string }> =
        [];
      const pattern =
        /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      for (const m of html.matchAll(pattern)) {
        let url = m[1] ?? "";
        try {
          const parsed = new URL(url, "https://duckduckgo.com");
          const redirected = parsed.searchParams.get("uddg");
          if (redirected) url = redirected;
          else url = parsed.href;
        } catch {
          continue;
        }
        if (!url.startsWith("http")) continue;
        const strip = (s: string) =>
          s
            .replace(/<[^>]+>/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&#x27;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim();
        results.push({
          title: strip(m[2] ?? ""),
          url,
          snippet: strip(m[3] ?? ""),
        });
        if (results.length >= Math.min(10, Number(args.depth ?? 2) * 4)) break;
      }
      return {
        query,
        provider: "DuckDuckGo",
        depth: Number(args.depth ?? 2),
        results,
      };
    },
  ),
  tool(
    "fetch_page",
    "Fetch a public HTTP(S) page and extract readable text; local/private destinations are blocked.",
    {
      type: "object",
      properties: { url: { type: "string" }, max_chars: { type: "integer" } },
      required: ["url"],
      additionalProperties: false,
    },
    z.object({
      url: z.string().url(),
      max_chars: z.number().int().min(1000).max(50000).optional(),
    }),
    async (_ctx, args) => {
      let url = validatePublicUrl(String(args.url));
      let response: Response | undefined;
      for (let redirects = 0; redirects < 6; redirects++) {
        response = await fetch(url, {
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0 GalaxyAgentLocal/1.3" },
          signal: AbortSignal.timeout(20000),
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) break;
        url = validatePublicUrl(new URL(location, url).href);
      }
      if (!response) throw new Error("The page could not be fetched.");
      if (!response.ok)
        throw new Error(`Page request returned ${response.status}.`);
      const raw = await response.text();
      const title =
        raw
          .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/<[^>]+>/g, "")
          .trim() ?? url.hostname;
      const text = raw
        .replace(
          /<(script|style|nav|footer|header|form)[^>]*>[\s\S]*?<\/\1>/gi,
          " ",
        )
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
      const max = Number(args.max_chars ?? 16000);
      return {
        url: String(args.url),
        finalUrl: url.href,
        title,
        markdown: text.slice(0, max),
        truncated: text.length > max,
        bytes: Buffer.byteLength(raw),
      };
    },
  ),
  tool(
    "ask_user",
    "Pause the run for a user decision when genuinely necessary. The run resumes after the response.",
    {
      type: "object",
      properties: {
        question: { type: "string" },
        type: {
          type: "string",
          enum: ["single_choice", "multi_choice", "free_text"],
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
        allow_other: { type: "boolean" },
      },
      required: ["question", "type"],
      additionalProperties: false,
    },
    z.object({
      question: z.string().min(2).max(2000),
      type: z.enum(["single_choice", "multi_choice", "free_text"]),
      options: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .optional(),
      allow_other: z.boolean().optional(),
    }),
    async (ctx, args) => {
      const callId = randomUUID();
      const question = { callId, ...args };
      db.prepare(
        "INSERT INTO pending_questions(call_id,session_id,question_json,created_at) VALUES(?,?,?,?)",
      ).run(callId, ctx.sessionId, JSON.stringify(question), now());
      db.prepare("UPDATE sessions SET status=? WHERE id=?").run(
        "awaiting_user",
        ctx.sessionId,
      );
      publish(ctx.sessionId, "ask_user_request", question);
      return new Promise((resolvePromise) => {
        const key = `ask:${callId}`;
        approvalWaiters.set(key, (answer) => resolvePromise({ answer }));
      });
    },
  ),
  tool(
    "todo_write",
    "Update the visible session plan checklist.",
    {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: { type: "string" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    z.object({
      todos: z.array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
          activeForm: z.string().optional(),
        }),
      ),
    }),
    async (ctx, args) => {
      publish(ctx.sessionId, "todo_updated", { todos: args.todos });
      return { todos: args.todos };
    },
  ),
];
const mediaTools: ToolDef[] = [
  tool(
    "image_search",
    "Search Wikimedia Commons and download openly licensed image results into the session workspace with attribution metadata.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        orientation: {
          type: "string",
          enum: ["landscape", "portrait", "square"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    z.object({
      query: z.string().min(2).max(300),
      count: z.number().int().min(1).max(5).optional(),
      orientation: z.enum(["landscape", "portrait", "square"]).optional(),
    }),
    async (ctx, args) => {
      const query =
        `${String(args.query)} ${String(args.orientation ?? "")}`.trim();
      const count = Number(args.count ?? 3);
      const endpoint = new URL("https://commons.wikimedia.org/w/api.php");
      endpoint.search = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: query,
        gsrnamespace: "6",
        gsrlimit: String(count),
        prop: "imageinfo",
        iiprop: "url|extmetadata",
        iiurlwidth: "1600",
        format: "json",
      }).toString();
      const response = await fetch(endpoint, {
        headers: { "User-Agent": "GalaxyAgentLocal/1.3 (local research tool)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(`Wikimedia Commons returned ${response.status}.`);
      const payload = (await response.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              imageinfo?: Array<{
                url?: string;
                thumburl?: string;
                extmetadata?: Record<string, { value?: string }>;
              }>;
            }
          >;
        };
      };
      const root = workspacePath(ctx.sessionId);
      const slug =
        String(args.query)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48) || "images";
      const images: Array<{
        path: string;
        sourceUrl: string;
        sourcePage: string;
        attribution: string;
        license: string;
        bytes: number;
      }> = [];
      for (const [index, page] of Object.values(
        payload.query?.pages ?? {},
      ).entries()) {
        const info = page.imageinfo?.[0];
        const candidate = info?.thumburl ?? info?.url;
        if (!candidate) continue;
        const sourceUrl = validatePublicUrl(candidate);
        const imageResponse = await fetch(sourceUrl, {
          signal: AbortSignal.timeout(20000),
        });
        if (
          !imageResponse.ok ||
          !(imageResponse.headers.get("content-type") ?? "").startsWith(
            "image/",
          )
        )
          continue;
        const bytes = Buffer.from(await imageResponse.arrayBuffer());
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) continue;
        const contentType =
          imageResponse.headers.get("content-type") ?? "image/jpeg";
        const extension = contentType.includes("png")
          ? ".png"
          : contentType.includes("webp")
            ? ".webp"
            : contentType.includes("gif")
              ? ".gif"
              : ".jpg";
        const relativePath = `assets/search/${slug}/image-${index + 1}${extension}`;
        const target = safePath(root, relativePath);
        await mkdir(resolve(target, ".."), { recursive: true });
        await assertConfined(root, target, true);
        await writeFile(target, bytes);
        const metadata = info?.extmetadata ?? {};
        const attribution = String(
          metadata.Artist?.value ??
            metadata.Credit?.value ??
            "Wikimedia Commons contributor",
        )
          .replace(/<[^>]*>/g, " ")
          .slice(0, 300);
        const license = String(
          metadata.LicenseShortName?.value ?? "See source page",
        )
          .replace(/<[^>]*>/g, " ")
          .slice(0, 100);
        images.push({
          path: relativePath,
          sourceUrl: sourceUrl.href,
          sourcePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent((page.title ?? "File").replace(/ /g, "_"))}`,
          attribution,
          license,
          bytes: bytes.length,
        });
        publish(ctx.sessionId, "file_changed", {
          path: relativePath,
          action: "created",
          bytes: bytes.length,
        });
      }
      return {
        query: String(args.query),
        provider: "Wikimedia Commons",
        images,
        note: images.length
          ? undefined
          : "No downloadable images matched this query.",
      };
    },
  ),
  tool(
    "generate_image",
    "Generate or edit images through the selected provider's OpenAI-compatible image endpoint. Requires a compatible configured provider.",
    {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: {
          type: "string",
          description:
            "Optional provider-specific image model; defaults to the selected chat model.",
        },
        count: { type: "integer", minimum: 1, maximum: 4 },
        size: { type: "string" },
        output_format: { type: "string", enum: ["png", "jpg", "webp"] },
        input_images: { type: "array", items: { type: "string" } },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    z.object({
      prompt: z.string().min(3).max(4000),
      model: z.string().optional(),
      count: z.number().int().min(1).max(4).optional(),
      size: z.string().optional(),
      output_format: z.enum(["png", "jpg", "webp"]).optional(),
      input_images: z.array(z.string()).optional(),
    }),
    async (ctx, args) => {
      const session = db
        .prepare("SELECT model_provider,model_id FROM sessions WHERE id=?")
        .get(ctx.sessionId) as
        { model_provider: string | null; model_id: string | null } | undefined;
      if (!session?.model_provider)
        throw new Error(
          "Select a configured provider that supports image generation first.",
        );
      const provider = getProvider(session.model_provider);
      if (
        !(
          ["openai", "openrouter", "kilo", "custom-openai"] as string[]
        ).includes(provider.kind)
      )
        throw new Error(
          "This image-generation handler supports OpenAI-compatible OpenAI, OpenRouter, Kilo, and custom endpoints only.",
        );
      const key = providerSecret(provider);
      if (!key)
        throw new Error(
          "Image generation requires an API key for the selected provider.",
        );
      const base = provider.base_url.replace(/\/$/, "");
      const format = String(args.output_format ?? "png");
      const count = Number(args.count ?? 1);
      const headers = authHeadersForImage(provider, key);
      let response: Response;
      if (Array.isArray(args.input_images) && args.input_images.length) {
        const form = new FormData();
        form.set("prompt", String(args.prompt));
        const imageModel = String(args.model ?? session.model_id ?? "");
        if (imageModel) form.set("model", imageModel);
        form.set("n", String(count));
        form.set("size", String(args.size ?? "1024x1024"));
        for (const input of args.input_images) {
          const root = workspacePath(ctx.sessionId);
          const target = safePath(root, String(input));
          await assertConfined(root, target);
          form.append(
            "image[]",
            new Blob([await readFile(target)]),
            basename(String(input)),
          );
        }
        response = await fetch(`${base}/images/edits`, {
          method: "POST",
          headers,
          body: form,
          signal: ctx.signal,
        });
      } else {
        response = await fetch(`${base}/images/generations`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: args.model ?? session.model_id,
            prompt: String(args.prompt),
            n: count,
            size: String(args.size ?? "1024x1024"),
            output_format: format === "jpg" ? "jpeg" : format,
          }),
          signal: ctx.signal,
        });
      }
      const body = await response.text();
      if (!response.ok)
        throw new Error(
          `Image provider returned ${response.status}: ${body.slice(0, 600)}`,
        );
      const result = JSON.parse(body) as {
        data?: Array<{
          b64_json?: string;
          url?: string;
          revised_prompt?: string;
        }>;
      };
      const root = workspacePath(ctx.sessionId);
      const slug =
        String(args.prompt)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 50) || "generated";
      const images: Array<{ path: string; revisedPrompt?: string }> = [];
      for (const [index, item] of (result.data ?? []).entries()) {
        let bytes: Buffer;
        if (item.b64_json) bytes = Buffer.from(item.b64_json, "base64");
        else if (item.url) {
          const url = validatePublicUrl(item.url);
          const downloaded = await fetch(url, { signal: ctx.signal });
          if (!downloaded.ok)
            throw new Error("Generated image URL could not be downloaded.");
          bytes = Buffer.from(await downloaded.arrayBuffer());
        } else continue;
        const relativePath = `assets/generated/${slug}-${index + 1}.${format}`;
        const target = safePath(root, relativePath);
        await mkdir(resolve(target, ".."), { recursive: true });
        await assertConfined(root, target, true);
        await writeFile(target, bytes);
        publish(ctx.sessionId, "file_changed", {
          path: relativePath,
          action: "created",
          bytes: bytes.length,
        });
        images.push({
          path: relativePath,
          ...(item.revised_prompt
            ? { revisedPrompt: item.revised_prompt }
            : {}),
        });
      }
      if (!images.length)
        throw new Error("The image endpoint returned no image data.");
      return { images, model: args.model ?? session.model_id };
    },
  ),
  tool(
    "generate_speech",
    "Generate an audio file through the selected provider's OpenAI-compatible text-to-speech endpoint. Requires a configured compatible provider.",
    {
      type: "object",
      properties: {
        text: { type: "string" },
        voice: { type: "string" },
        output_format: {
          type: "string",
          enum: ["mp3", "wav", "opus", "aac", "flac"],
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    z.object({
      text: z.string().min(1).max(1500),
      voice: z.string().optional(),
      output_format: z.enum(["mp3", "wav", "opus", "aac", "flac"]).optional(),
    }),
    async (ctx, args) => {
      const session = db
        .prepare("SELECT model_provider FROM sessions WHERE id=?")
        .get(ctx.sessionId) as { model_provider: string | null } | undefined;
      if (!session?.model_provider)
        throw new Error(
          "Select a provider that supports text-to-speech first.",
        );
      const provider = getProvider(session.model_provider);
      if (
        !(
          ["openai", "openrouter", "kilo", "custom-openai"] as string[]
        ).includes(provider.kind)
      )
        throw new Error(
          "This speech-generation handler supports OpenAI-compatible OpenAI, OpenRouter, Kilo, and custom endpoints only.",
        );
      const key = providerSecret(provider);
      if (!key)
        throw new Error(
          "Speech generation requires an API key for the selected provider.",
        );
      const format = String(args.output_format ?? "mp3");
      const response = await fetch(
        `${provider.base_url.replace(/\/$/, "")}/audio/speech`,
        {
          method: "POST",
          headers: {
            ...authHeadersForImage(provider, key),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            input: String(args.text),
            voice: String(args.voice ?? "alloy"),
            response_format: format,
          }),
          signal: ctx.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          `Speech provider returned ${response.status}: ${(await response.text()).slice(0, 600)}`,
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length)
        throw new Error(
          "The speech provider returned an empty audio response.",
        );
      const slug =
        String(args.text)
          .slice(0, 42)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "speech";
      const relativePath = `assets/audio/${slug}.${format}`;
      const root = workspacePath(ctx.sessionId);
      const target = safePath(root, relativePath);
      await mkdir(resolve(target, ".."), { recursive: true });
      await assertConfined(root, target, true);
      await writeFile(target, bytes);
      publish(ctx.sessionId, "file_changed", {
        path: relativePath,
        action: "created",
        bytes: bytes.length,
      });
      return {
        path: relativePath,
        durationMs: null,
        format,
        voice: String(args.voice ?? "alloy"),
        bytes: bytes.length,
        provider: provider.name,
      };
    },
  ),
];
handlers.push(...mediaTools);
handlers.push(
  tool(
    "notion_search",
    "Search the connected Notion workspace (Settings -> Connectors). Requires a validated Notion integration token.",
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    z.object({ query: z.string().min(1).max(200) }),
    async (_ctx, args) => notionSearch(String(args.query)),
  ),
  tool(
    "linear_issues",
    "List recent issues from the connected Linear workspace. Requires a validated Linear API key.",
    {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
    z.object({ limit: z.number().int().min(1).max(25).optional() }),
    async (_ctx, args) => linearIssues(Number(args.limit ?? 10)),
  ),
  tool(
    "google_drive_search",
    "Search files in the connected Google Drive. Requires a validated Google OAuth access token.",
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    z.object({ query: z.string().min(1).max(200) }),
    async (_ctx, args) => googleDriveSearch("drive", String(args.query)),
  ),
  tool(
    "google_docs_search",
    "Search Google Docs in the connected Google account. Requires a validated Google OAuth access token.",
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    z.object({ query: z.string().min(1).max(200) }),
    async (_ctx, args) => googleDriveSearch("gdocs", String(args.query)),
  ),
  tool(
    "gmail_list",
    "List recent Gmail message metadata (subject/from/snippet) from the connected account. Requires a validated Google OAuth access token with gmail.readonly.",
    {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      additionalProperties: false,
    },
    z.object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async (_ctx, args) =>
      gmailList(String(args.query ?? ""), Number(args.limit ?? 10)),
  ),
  tool(
    "google_calendar_events",
    "List upcoming events from the connected Google Calendar. Requires a validated Google OAuth access token with calendar.readonly.",
    {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
    z.object({
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async (_ctx, args) => googleCalendarEvents(Number(args.limit ?? 10)),
  ),
  tool(
    "git_status",
    "Inspect repository branch, working-tree changes, and recent commits for this session.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}),
    async (ctx) => gitStatus(ctx.sessionId),
  ),
  tool(
    "git_diff",
    "Read the repository diff. Set full_branch=true to include committed changes since the base branch.",
    {
      type: "object",
      properties: { full_branch: { type: "boolean" } },
      additionalProperties: false,
    },
    z.object({ full_branch: z.boolean().optional() }),
    async (ctx, args) => gitDiff(ctx.sessionId, Boolean(args.full_branch)),
  ),
  tool(
    "git_commit",
    "Commit current repository changes with an ephemeral Galaxy Agent identity and a conventional commit message.",
    {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    z.object({ message: z.string().min(5).max(200) }),
    async (ctx, args) => gitCommit(ctx.sessionId, String(args.message)),
  ),
  tool(
    "git_push",
    "Push the session branch to its GitHub origin. The tool refuses a repository locked after PR closure or merge.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}),
    async (ctx) => gitPush(ctx.sessionId),
  ),
  tool(
    "create_pull_request",
    "Push changes and create the one allowed pull request for this chat session.",
    {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        draft: { type: "boolean" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    z.object({
      title: z.string().min(1).max(256),
      body: z.string().max(60000),
      draft: z.boolean().optional(),
    }),
    async (ctx, args) =>
      githubCreatePR(
        ctx.sessionId,
        String(args.title),
        String(args.body),
        Boolean(args.draft),
      ),
  ),
  tool(
    "list_pull_requests",
    "List repository pull requests, including closed entries.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}),
    async (ctx) => githubListPRs(ctx.sessionId),
  ),
  tool(
    "merge_pull_request",
    "Merge a pull request and lock the session after successful merge.",
    {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1 },
        method: { type: "string", enum: ["merge", "squash", "rebase"] },
      },
      required: ["number"],
      additionalProperties: false,
    },
    z.object({
      number: z.number().int().positive(),
      method: z.enum(["merge", "squash", "rebase"]).optional(),
    }),
    async (ctx, args) =>
      githubMergePR(
        ctx.sessionId,
        Number(args.number),
        (args.method as "merge" | "squash" | "rebase" | undefined) ?? "squash",
      ),
  ),
  tool(
    "get_check_runs",
    "Fetch GitHub check-runs and commit-status results for the current branch head.",
    { type: "object", properties: {}, additionalProperties: false },
    z.object({}),
    async (ctx) => githubChecks(ctx.sessionId),
  ),
  tool(
    "start_preview",
    "Start a local development server in the session workspace, wait until its loopback port responds, and expose it through the app preview proxy.",
    {
      type: "object",
      properties: {
        command: { type: "string", maxLength: 4000 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
      },
      required: ["command", "port"],
      additionalProperties: false,
    },
    z.object({
      command: z.string().min(1).max(4000),
      port: z.number().int().min(1).max(65535),
      timeout_ms: z.number().int().min(1000).max(60000).optional(),
    }),
    async (ctx, args) => {
      const preview = await startPreview(
        ctx.sessionId,
        String(args.command),
        Number(args.port),
        Number(args.timeout_ms ?? 20000),
        ctx.signal,
      );
      publish(ctx.sessionId, "preview_status", {
        state: "ready",
        url: `/preview/${ctx.sessionId}/${preview.port}/`,
        port: preview.port,
      });
      return preview;
    },
  ),
  tool(
    "stop_preview",
    "Stop one session preview server or all preview servers for this session.",
    {
      type: "object",
      properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
      additionalProperties: false,
    },
    z.object({ port: z.number().int().min(1).max(65535).optional() }),
    async (ctx, args) => {
      const result = stopPreview(
        ctx.sessionId,
        args.port === undefined ? undefined : Number(args.port),
      );
      publish(ctx.sessionId, "preview_status", {
        state: "stopped",
        port: args.port ?? null,
      });
      return result;
    },
  ),
);
export const openAITools = handlers.map((h) => ({
  type: "function",
  function: {
    name: h.name,
    description: h.description,
    parameters: h.parameters,
  },
}));
export async function runTool(
  name: string,
  ctx: ToolContext,
  raw: unknown,
): Promise<unknown> {
  const handler = handlers.find((h) => h.name === name);
  if (!handler)
    return {
      error: true,
      code: "TOOL_ERROR",
      message: `Unknown tool: ${name}`,
      retryable: false,
    };
  try {
    const args = handler.schema.parse(raw) as Record<string, unknown>;
    const locked = db
      .prepare("SELECT repo_locked FROM sessions WHERE id=?")
      .get(ctx.sessionId) as { repo_locked: number } | undefined;
    if (
      locked?.repo_locked &&
      [
        "bash",
        "write_file",
        "edit_file",
        "generate_image",
        "generate_speech",
        "image_search",
        "git_commit",
        "git_push",
        "create_pull_request",
        "merge_pull_request",
        "start_preview",
      ].includes(name)
    )
      return {
        error: true,
        code: "SANDBOX_DENIED",
        message:
          "This repository session is locked because its pull request was closed or merged. Read-only inspection remains available.",
        retryable: false,
      };
    return await handler.run(ctx, args);
  } catch (error) {
    return {
      error: true,
      code: "TOOL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      hint: "Check the path, arguments, and workspace state, then retry.",
      retryable: true,
    };
  }
}
export async function resumeAsk(
  callId: string,
  answer: string,
  sessionId: string,
) {
  const key = `ask:${callId}`;
  const fn = approvalWaiters.get(key);
  if (!fn) return false;
  approvalWaiters.delete(key);
  db.prepare(
    "UPDATE pending_questions SET answer=?,answered_at=? WHERE call_id=? AND session_id=?",
  ).run(answer, now(), callId, sessionId);
  db.prepare("UPDATE sessions SET status=? WHERE id=?").run(
    "running",
    sessionId,
  );
  addMessage(sessionId, "user", `Answer to the agent's question: ${answer}`);
  publish(sessionId, "ask_user_answered", { callId, answer });
  fn(answer);
  return true;
}
export const agentSystemPrompt = `You are a capable local coding and research agent. You can use tools to inspect and change real files in the session workspace, run shell commands there, search the public web, and read public pages. Work autonomously. Make a brief plan for multi-step tasks, execute the work, and verify outcomes with tools. Never claim an operation succeeded unless a tool confirms it. Use ask_user only when a material choice is impossible to infer. For shell work, prefer safe, narrowly scoped commands. The workspace is ${config.workspacesDir}. When you create a user-facing deliverable, call present_file.`;
