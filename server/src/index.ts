import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import {
  db,
  createSession,
  addMessage,
  getMessages,
  now,
  type SessionRow,
} from "./db.js";
import { eventBus, publish } from "./events.js";
import {
  isPublicPath,
  RateLimiter,
  requestToken,
  tokenMatches,
} from "./security.js";
import {
  connectConnector,
  disconnectConnector,
  listConnectors,
  testConnector,
} from "./connectors.js";
import { statSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import {
  getProviders,
  getProvider,
  saveProvider,
  deleteProvider,
  setDefault,
  fetchModels,
  cachedModels,
  providerSecret,
  chatStream,
} from "./providers.js";
import {
  runSession,
  stopRun,
  getRunStatus,
  resumeInterruptedSession,
  compareCompletion,
} from "./agent.js";
import { resolveApproval, resumeAsk } from "./tools.js";
import {
  githubConnect,
  githubDisconnect,
  githubListRepos,
  githubSelectRepos,
  githubStatus,
  githubClone,
  githubStatusForSession,
  githubChecks,
  githubRefreshSessionLock,
  gitDiff,
} from "./github.js";
import {
  listPreviews,
  startPreview,
  stopAllPreviews,
  stopPreview,
} from "./preview.js";
import {
  assertConfined,
  listTree,
  makeZip,
  safePath,
  workspacePath,
} from "./workspace.js";

const app = Fastify({
  bodyLimit: 2 * 1024 * 1024,
  logger: {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "api_key",
        "api_key_enc",
        "credential",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req: (r) => ({
        method: r.method,
        url: r.url,
        hostname: r.hostname,
        remoteAddress: r.ip,
      }),
    },
  },
});
// Accept empty bodies on JSON requests: several actions (stop, resume,
// refresh-models, set-default…) legitimately POST without a payload, and
// Fastify's default parser rejects those with "Body cannot be empty when
// content-type is set to 'application/json'".
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_request, body, done) => {
    if (!body || (typeof body === "string" && body.trim() === "")) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(
        Object.assign(new Error("Request body is not valid JSON."), {
          statusCode: 400,
        }),
        undefined,
      );
    }
  },
);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});
const rateLimiter = new RateLimiter(
  config.rateLimitMax,
  config.rateLimitWindowMs,
);
const writeRateLimiter = new RateLimiter(
  config.rateLimitWriteMax,
  config.rateLimitWindowMs,
);
const startedAt = Date.now();
app.addHook("onRequest", async (request, reply) => {
  reply.header("X-Request-Id", request.id);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "SAMEORIGIN");
  reply.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  const path = request.url.split("?")[0] ?? request.url;
  if (!path.startsWith("/preview/")) {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    );
  }
  const guarded = path.startsWith("/api/") || path.startsWith("/preview/");
  if (!guarded) return;
  if (config.authRequired && !isPublicPath(request.url)) {
    if (!tokenMatches(requestToken(request), config.authToken)) {
      return reply.code(401).send({
        error: "Authentication required. Provide the app access token.",
        requestId: request.id,
      });
    }
  }
  if (path.startsWith("/api/") && !path.endsWith("/stream")) {
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const limiter = write ? writeRateLimiter : rateLimiter;
    const verdict = limiter.check(`${request.ip}:${write ? "w" : "r"}`);
    reply.header("X-RateLimit-Remaining", String(verdict.remaining));
    if (!verdict.allowed) {
      reply.header(
        "Retry-After",
        String(Math.ceil(verdict.retryAfterMs / 1000)),
      );
      return reply.code(429).send({
        error: "Rate limit exceeded. Retry shortly.",
        requestId: request.id,
      });
    }
  }
});
app.setErrorHandler(
  (error: Error & { statusCode?: number }, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const isValidation = error.name === "ZodError";
    const status = isValidation ? 400 : (error.statusCode ?? 500);
    reply.status(status).send({
      error: isValidation
        ? "Request validation failed. Check the submitted fields."
        : error.statusCode
          ? // Errors raised deliberately with an HTTP status (400/404/502…)
            // carry a user-safe message — surface it. Only uncoded internal
            // failures stay behind the generic text.
            error.message
          : "The local server could not complete the request.",
      requestId: request.id,
    });
  },
);
const sessionOr404 = (id: string) => {
  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
    SessionRow | undefined;
  if (!session)
    throw Object.assign(new Error("Session not found."), { statusCode: 404 });
  return session;
};
const assertSessionWorkspaceUnlocked = async (id: string) => {
  const s = db
    .prepare("SELECT github_pr_number,repo_locked FROM sessions WHERE id=?")
    .get(id) as { github_pr_number: number | null; repo_locked: number };
  if (s.github_pr_number)
    await githubRefreshSessionLock(id).catch(() => ({
      locked: Boolean(s.repo_locked),
    }));
  const fresh = db
    .prepare("SELECT repo_locked FROM sessions WHERE id=?")
    .get(id) as { repo_locked: number };
  if (fresh.repo_locked)
    throw Object.assign(
      new Error(
        "This workspace is locked because its pull request was closed or merged.",
      ),
      { statusCode: 423 },
    );
};
const parseJson = (s: unknown) => {
  try {
    return JSON.parse(String(s ?? "{}"));
  } catch {
    return {};
  }
};
const allowedUploadExtensions = new Set([
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".gif",
  ".txt",
  ".md",
  ".csv",
  ".html",
  ".xml",
  ".css",
  ".js",
  ".json",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".ipynb",
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
]);
const blockedUploadExtensions = new Set([
  ".exe",
  ".sh",
  ".bat",
  ".cmd",
  ".scr",
  ".dll",
  ".so",
  ".dylib",
  ".jar",
  ".msi",
]);
function uploadContentMatches(ext: string, data: Buffer) {
  if (ext === ".png")
    return data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if ([".jpg", ".jpeg"].includes(ext))
    return (
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    );
  if (ext === ".gif")
    return ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  if (ext === ".webp")
    return (
      data.length >= 12 &&
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    );
  if (ext === ".pdf") return data.subarray(0, 5).toString("ascii") === "%PDF-";
  if ([".zip", ".docx", ".xlsx", ".pptx"].includes(ext))
    return (
      data.length >= 4 &&
      data[0] === 0x50 &&
      data[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(data[2]!) &&
      [0x04, 0x06, 0x08].includes(data[3]!)
    );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return !text.includes("\u0000");
  } catch {
    return false;
  }
}

app.get("/api/health", async () => ({
  ok: true,
  service: "galaxy-agent-local",
  version: config.version,
  time: now(),
  database: (
    db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check,
  authRequired: config.authRequired,
}));
app.get("/api/ready", async (_request, reply) => {
  const integrity = (
    db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check;
  const ready = integrity === "ok";
  reply.code(ready ? 200 : 503);
  return {
    ready,
    service: "galaxy-agent-local",
    version: config.version,
    time: now(),
    database: integrity,
    storage: existsSync(config.dataDir),
  };
});
app.get("/api/metrics", async () => resourceMetrics());
function resourceMetrics() {
  const mem = process.memoryUsage();
  let dbBytes = 0;
  try {
    dbBytes = statSync(resolve(config.dataDir, "app.db")).size;
  } catch {}
  const counts = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    service: "galaxy-agent-local",
    version: config.version,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      cpuUserMicros: process.cpuUsage().user,
      cpuSystemMicros: process.cpuUsage().system,
    },
    system: {
      loadAverage: loadavg(),
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
    },
    storage: { dataDir: config.dataDir, databaseBytes: dbBytes },
    counts: {
      sessions: counts("sessions"),
      messages: counts("messages"),
      providers: counts("providers"),
      toolCalls: counts("tool_calls"),
      artifacts: counts("artifacts"),
    },
    runningSessions: (
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE status='running'")
        .get() as { n: number }
    ).n,
    security: {
      authRequired: config.authRequired,
      rateLimitMax: config.rateLimitMax,
      rateLimitWriteMax: config.rateLimitWriteMax,
      windowMs: config.rateLimitWindowMs,
      failoverEnabled: config.failoverEnabled,
    },
  };
}
app.get("/api/github/status", async () => githubStatus());
app.post("/api/github/connect", async (request) => {
  const body = z
    .object({ token: z.string().min(20).max(500) })
    .parse(request.body);
  return githubConnect(body.token);
});
app.delete("/api/github/connect", async () => githubDisconnect());
app.get("/api/github/repos", async () => ({
  repositories: await githubListRepos(),
}));
app.get("/api/connectors", async () => ({ connectors: listConnectors() }));
app.post("/api/connectors/:id/connect", async (request) => {
  const { id } = request.params as { id: string };
  const body = z
    .object({ token: z.string().min(10).max(2000) })
    .parse(request.body);
  return connectConnector(id, body.token);
});
app.post("/api/connectors/:id/test", async (request) => {
  const { id } = request.params as { id: string };
  return testConnector(id);
});
app.delete("/api/connectors/:id", async (request) => {
  const { id } = request.params as { id: string };
  return disconnectConnector(id);
});
app.put("/api/github/repos", async (request) => {
  const body = z
    .object({ selectedRepos: z.array(z.string()).max(1000) })
    .parse(request.body);
  return githubSelectRepos(body.selectedRepos);
});
app.post("/api/sessions/:id/github/clone", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const body = z
    .object({ repo: z.string(), baseBranch: z.string() })
    .parse(request.body);
  return githubClone(id, body.repo, body.baseBranch);
});
app.get("/api/sessions/:id/github/status", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await githubRefreshSessionLock(id).catch(() => ({ locked: false }));
  return githubStatusForSession(id);
});
app.get("/api/sessions/:id/diff", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const { full } = request.query as { full?: string };
  return gitDiff(id, full === "1" || full === "true");
});
app.get("/api/sessions/:id/checks", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  return githubChecks(id);
});
app.get("/api/sessions/:id/previews", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  return { previews: listPreviews(id) };
});
app.post("/api/sessions/:id/previews/start", async (request, reply) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await assertSessionWorkspaceUnlocked(id);
  const body = z
    .object({
      command: z.string().min(1).max(4000),
      port: z.number().int().min(1).max(65535),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    })
    .parse(request.body);
  const preview = await startPreview(
    id,
    body.command,
    body.port,
    body.timeoutMs ?? 20000,
  );
  publish(id, "preview_status", {
    state: preview.state,
    url: `/preview/${id}/${preview.port}/`,
    port: preview.port,
  });
  reply.code(201);
  return preview;
});
app.post("/api/sessions/:id/previews/stop", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const body = z
    .object({ port: z.number().int().min(1).max(65535).optional() })
    .parse(request.body ?? {});
  const result = stopPreview(id, body.port);
  publish(id, "preview_status", { state: "stopped", port: body.port ?? null });
  return result;
});
const previewHandler = async (
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
) => {
  const params = request.params as {
    sessionId: string;
    port: string;
    "*"?: string;
  };
  sessionOr404(params.sessionId);
  const port = Number(params.port);
  if (
    !listPreviews(params.sessionId).some(
      (p) => p.port === port && p.state === "ready",
    )
  )
    return reply.code(404).send({
      error: "No ready preview is running on that port for this session.",
    });
  const wildcard = String(params["*"] ?? "");
  let decoded = "";
  try {
    decoded = decodeURIComponent(wildcard);
  } catch {
    return reply.code(400).send({ error: "Invalid preview path." });
  }
  if (decoded.split(/[\\/]/).some((part) => part === ".."))
    return reply
      .code(400)
      .send({ error: "Preview path traversal is not allowed." });
  const suffix = decoded.split("?")[0] ?? "";
  const query = request.url.includes("?")
    ? request.url.slice(request.url.indexOf("?"))
    : "";
  const targetPath = `/${suffix.replace(/^\/+/, "")}${query}`;
  const contentType = request.headers["content-type"];
  const body =
    request.body === undefined
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
  const upstream = await fetch(`http://127.0.0.1:${port}${targetPath}`, {
    method: request.method,
    redirect: "manual",
    headers: {
      accept: String(request.headers.accept ?? "*/*"),
      "user-agent": "GalaxyAgentPreview",
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(body && !["GET", "HEAD"].includes(request.method) ? { body } : {}),
    signal: AbortSignal.timeout(30000),
  });
  reply.code(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (
      ![
        "content-security-policy",
        "x-frame-options",
        "content-length",
        "transfer-encoding",
        "connection",
      ].includes(key.toLowerCase())
    )
      reply.header(key, value);
  });
  const location = upstream.headers.get("location");
  if (location) {
    const path = location.replace(
      /^https?:\/\/(localhost|127\.0\.0\.1):\d+/i,
      "",
    );
    reply.header(
      "location",
      `/preview/${params.sessionId}/${port}${path.startsWith("/") ? path : `/${path}`}`,
    );
  }
  const responseBuffer = Buffer.from(await upstream.arrayBuffer());
  const upstreamType = upstream.headers.get("content-type") ?? "";
  if (upstreamType.includes("text/html")) {
    const prefix = `/preview/${params.sessionId}/${port}`;
    const html = responseBuffer
      .toString("utf8")
      .replace(/((?:src|href|action)=["'])\/(?!\/)/gi, `$1${prefix}/`)
      .replace(/url\(\s*["']?\/(?!\/)/gi, `url(${prefix}/`);
    return reply.type(upstreamType).send(html);
  }
  return reply.send(responseBuffer);
};
app.route({
  method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  url: "/preview/:sessionId/:port",
  handler: previewHandler,
});
app.route({
  method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  url: "/preview/:sessionId/:port/*",
  handler: previewHandler,
});
app.get("/api/sessions", async () =>
  db
    .prepare(
      "SELECT * FROM sessions WHERE archived=0 ORDER BY pinned DESC,updated_at DESC",
    )
    .all(),
);
app.post("/api/sessions", async (request, reply) => {
  const body = z
    .object({ title: z.string().max(120).optional() })
    .parse(request.body ?? {});
  const session = createSession(body.title ?? "New chat");
  reply.code(201);
  return session;
});
app.get("/api/sessions/:id", async (request) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  const pending = db
    .prepare(
      "SELECT question_json FROM pending_questions WHERE session_id=? AND answered_at IS NULL ORDER BY created_at",
    )
    .get(id) as { question_json: string } | undefined;
  return {
    ...session,
    messages: getMessages(id),
    runStatus: getRunStatus(id),
    pendingAsk: pending ? parseJson(pending.question_json) : null,
  };
});
app.get("/api/sessions/:id/costs", async (request) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  return {
    totalCostUsd: session.total_cost_usd,
    totalTokens: session.total_tokens,
    turns: db
      .prepare(
        "SELECT turn,provider,model,prompt_tokens,completion_tokens,cached_tokens,reasoning_tokens,cost_usd,latency_ms,created_at FROM costs WHERE session_id=? ORDER BY created_at DESC",
      )
      .all(id),
  };
});
app.delete("/api/sessions/:id/messages", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  stopRun(id);
  db.transaction(() => {
    db.prepare("DELETE FROM message_search WHERE session_id=?").run(id);
    db.prepare("DELETE FROM messages WHERE session_id=?").run(id);
    db.prepare("DELETE FROM tool_calls WHERE session_id=?").run(id);
    db.prepare("DELETE FROM costs WHERE session_id=?").run(id);
    db.prepare("DELETE FROM pending_questions WHERE session_id=?").run(id);
    db.prepare("DELETE FROM artifacts WHERE session_id=?").run(id);
    db.prepare(
      "UPDATE sessions SET total_tokens=0,total_cost_usd=0,status='idle',updated_at=? WHERE id=?",
    ).run(now(), id);
  })();
  publish(id, "session_cleared", {});
  return { ok: true };
});
app.patch("/api/sessions/:id", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const body = z
    .object({
      title: z.string().min(1).max(120).optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      providerId: z.string().optional(),
      modelId: z.string().optional(),
    })
    .parse(request.body);
  const current = sessionOr404(id);
  db.prepare(
    "UPDATE sessions SET title=?,archived=?,pinned=?,model_provider=?,model_id=?,updated_at=? WHERE id=?",
  ).run(
    body.title ?? current.title,
    body.archived === undefined ? current.archived : Number(body.archived),
    body.pinned === undefined ? current.pinned : Number(body.pinned),
    body.providerId ?? current.model_provider,
    body.modelId ?? current.model_id,
    now(),
    id,
  );
  return sessionOr404(id);
});
app.delete("/api/sessions/:id", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  stopRun(id);
  db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  return { ok: true };
});
app.get("/api/history/search", async (request) => {
  const { q } = request.query as { q?: string };
  if (!q?.trim()) return { results: [] };
  const query = q
    .trim()
    .split(/\s+/)
    .map((s) => `${s.replace(/["*]/g, "")}*`)
    .join(" AND ");
  try {
    return {
      results: db
        .prepare(
          `SELECT DISTINCT s.id,s.title,s.updated_at,s.total_cost_usd,m.content AS snippet FROM message_search f JOIN sessions s ON s.id=f.session_id JOIN messages m ON m.id=f.message_id WHERE message_search MATCH ? AND s.archived=0 ORDER BY s.updated_at DESC LIMIT 30`,
        )
        .all(query),
    };
  } catch {
    return { results: [] };
  }
});
app.get("/api/providers", async () => getProviders());
app.post("/api/providers", async (request, reply) => {
  const id = saveProvider(request.body);
  reply.code(201);
  return { provider: getProviders().find((p) => p.id === id) };
});
app.patch("/api/providers/:id", async (request) => {
  const { id } = request.params as { id: string };
  saveProvider(request.body, id);
  return { provider: getProviders().find((p) => p.id === id) };
});
app.delete("/api/providers/:id", async (request) => {
  const { id } = request.params as { id: string };
  deleteProvider(id);
  return { ok: true };
});
app.post("/api/providers/:id/default", async (request) => {
  const { id } = request.params as { id: string };
  setDefault(id);
  return { ok: true };
});
app.post("/api/providers/:id/refresh-models", async (request) => {
  const { id } = request.params as { id: string };
  return { models: await fetchModels(id), fetchedAt: now() };
});
app.post("/api/providers/:id/test", async (request) => {
  const { id } = request.params as { id: string };
  const provider = getProvider(id);
  const started = now();
  const models = await fetchModels(id);
  const model = models[0];
  if (!model) throw new Error("The live model endpoint returned no models.");
  const response = await chatStream(
    provider,
    model.id,
    [{ role: "user", content: "Reply with the single word OK." }],
    [],
    AbortSignal.timeout(30000),
    "low",
    () => {},
  );
  return {
    ok: true,
    modelCount: models.length,
    sampleLatencyMs: now() - started,
    sample: response.text.slice(0, 50),
  };
});
app.get("/api/settings", async () =>
  Object.fromEntries(
    (
      db.prepare("SELECT key,value_json FROM settings").all() as Array<{
        key: string;
        value_json: string;
      }>
    ).map((x) => [x.key, parseJson(x.value_json)]),
  ),
);
app.put("/api/settings/:key", async (request) => {
  const { key } = request.params as { key: string };
  const safeKey = z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
    .parse(key);
  db.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  ).run(safeKey, JSON.stringify(request.body), now());
  return { ok: true };
});
app.get("/api/sessions/:id/stream", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  const bus = eventBus(id);
  const query = request.query as { fromSeq?: string };
  const headerLast = Number(request.headers["last-event-id"] ?? 0);
  const from = Number(query.fromSeq ?? headerLast ?? 0);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(
    `event: session_joined\ndata: ${JSON.stringify({ sessionId: id, model: session.model_id, provider: session.model_provider, status: getRunStatus(id) })}\n\n`,
  );
  if ((from && from < bus.oldest() - 1) || from > bus.latest()) {
    reply.raw.write(
      `event: resync_required\ndata: ${JSON.stringify({ requested: from, oldest: bus.oldest() })}\n\n`,
    );
  } else
    for (const event of bus.replay(from))
      reply.raw.write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
  const unsubscribe = bus.subscribe((event) => {
    if (reply.raw.writableLength > 1_000_000 && event.type === "text_delta")
      return;
    reply.raw.write(
      `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
  });
  const heartbeat = setInterval(
    () =>
      reply.raw.write(
        `event: heartbeat\ndata: ${JSON.stringify({ ts: now() })}\n\n`,
      ),
    15000,
  );
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return reply;
});
app.post("/api/sessions/:id/messages", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  const body = z
    .object({
      content: z.string().min(1).max(50000),
      providerId: z.string().optional(),
      modelId: z.string().optional(),
      reasoning: z.enum(["low", "medium", "high"]).optional(),
      mode: z.enum(["agent", "direct"]).optional(),
    })
    .parse(request.body);
  const providerId =
    body.providerId ??
    session.model_provider ??
    getProviders().find((p) => p.is_default)?.id;
  if (!providerId)
    throw Object.assign(
      new Error("Add a model provider in Settings before starting a run."),
      { statusCode: 400 },
    );
  const provider = getProvider(providerId);
  const modelId =
    body.modelId ?? session.model_id ?? cachedModels(provider)[0]?.id;
  if (!modelId)
    throw Object.assign(
      new Error("Select a model from the provider's live model catalog."),
      { statusCode: 400 },
    );
  const message = runSession(
    session,
    body.content,
    providerId,
    modelId,
    body.reasoning ?? "medium",
    body.mode ?? "agent",
  );
  reply.code(202);
  return { message, runStatus: "running", mode: body.mode ?? "agent" };
});
app.post("/api/sessions/:id/compare", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const body = z
    .object({
      content: z.string().min(1).max(50000),
      a: z.object({ providerId: z.string(), modelId: z.string() }),
      b: z.object({ providerId: z.string(), modelId: z.string() }),
    })
    .parse(request.body);
  if (
    body.a.providerId === body.b.providerId &&
    body.a.modelId === body.b.modelId
  )
    throw Object.assign(new Error("Choose two different models to compare."), {
      statusCode: 400,
    });
  const settle = async (side: { providerId: string; modelId: string }) => {
    try {
      return {
        ok: true as const,
        ...(await compareCompletion(
          side.providerId,
          side.modelId,
          body.content,
        )),
      };
    } catch (error) {
      return {
        ok: false as const,
        providerId: side.providerId,
        model: side.modelId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const [a, b] = await Promise.all([settle(body.a), settle(body.b)]);
  addMessage(id, "user", body.content);
  addMessage(
    id,
    "assistant",
    `Side-by-side comparison\n\n**A (${a.ok ? a.model : body.a.modelId})**\n\n${a.ok ? a.text : `Error: ${a.error}`}\n\n**B (${b.ok ? b.model : body.b.modelId})**\n\n${b.ok ? b.text : `Error: ${b.error}`}`,
  );
  return { a, b };
});
app.post("/api/sessions/:id/stop", async (request) => {
  const { id } = request.params as { id: string };
  return { stopped: stopRun(id) };
});
app.post("/api/sessions/:id/resume", async (request) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  if (!["interrupted", "error", "awaiting_user"].includes(session.status))
    throw Object.assign(
      new Error(
        "Only interrupted, errored, or paused sessions can be resumed.",
      ),
      { statusCode: 409 },
    );
  const userMessage = resumeInterruptedSession(id);
  return { ok: true, message: userMessage };
});
app.post("/api/sessions/:id/answer", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  const body = z
    .object({ callId: z.string(), answer: z.string().max(5000) })
    .parse(request.body);
  let ok = await resumeAsk(body.callId, body.answer, id);
  if (!ok) {
    const pending = db
      .prepare(
        "SELECT 1 FROM pending_questions WHERE call_id=? AND session_id=? AND answered_at IS NULL",
      )
      .get(body.callId, id);
    if (!pending)
      throw Object.assign(
        new Error("That question is no longer waiting for an answer."),
        { statusCode: 409 },
      );
    db.prepare(
      "UPDATE pending_questions SET answer=?,answered_at=? WHERE call_id=? AND session_id=?",
    ).run(body.answer, now(), body.callId, id);
    db.prepare("UPDATE sessions SET status='interrupted' WHERE id=?").run(id);
    addMessage(id, "user", `Answer to the agent's question: ${body.answer}`);
    publish(id, "ask_user_answered", {
      callId: body.callId,
      answer: body.answer,
    });
    resumeInterruptedSession(id, body.answer);
    ok = true;
  }
  return { ok: true };
});
app.post("/api/approvals/:id", async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({ approved: z.boolean() }).parse(request.body);
  if (!resolveApproval(id, body.approved))
    throw Object.assign(
      new Error("Approval request expired or was already answered."),
      { statusCode: 409 },
    );
  return { ok: true };
});
app.get("/api/sessions/:id/workspace", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  return { files: await listTree(workspacePath(id)) };
});
app.get("/api/sessions/:id/file", async (request, reply) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await assertSessionWorkspaceUnlocked(id);
  const { path } = request.query as { path?: string };
  if (!path)
    throw Object.assign(new Error("Provide a workspace-relative path."), {
      statusCode: 400,
    });
  const full = safePath(workspacePath(id), path);
  await assertConfined(workspacePath(id), full);
  const info = await stat(full);
  if (!info.isFile())
    throw new Error("Requested workspace item is not a file.");
  reply.header("Content-Type", mimeType(extname(path)));
  reply.header("Content-Length", info.size);
  return reply.send(createReadStream(full));
});
app.get("/api/sessions/:id/download-workspace", async (request, reply) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await assertSessionWorkspaceUnlocked(id);
  const zip = resolve(config.dataDir, `${id}-${randomUUID()}.zip`);
  await makeZip(workspacePath(id), zip);
  reply.header("Content-Type", "application/zip");
  reply.header(
    "Content-Disposition",
    `attachment; filename="workspace-${id.slice(0, 8)}.zip"`,
  );
  reply.raw.on("close", () => void unlink(zip).catch(() => {}));
  return reply.send(createReadStream(zip));
});
app.get("/api/sessions/:id/export", async (request, reply) => {
  const { id } = request.params as { id: string };
  const session = sessionOr404(id);
  const messages = getMessages(id);
  const format = (request.query as { format?: string }).format;
  if (format === "json") return { session, messages };
  reply.type("text/markdown");
  return `# ${session.title}\n\n${messages.map((m) => `## ${String(m.role).toUpperCase()}\n\n${String(m.content)}\n`).join("\n")}`;
});
app.post("/api/sessions/:id/upload", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await assertSessionWorkspaceUnlocked(id);
  const saved = [];
  let totalBytes = 0;
  for await (const part of request.files()) {
    const original = part.filename
      .replace(/[\\/\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 255);
    const ext = extname(original).toLowerCase();
    if (blockedUploadExtensions.has(ext))
      throw Object.assign(
        new Error("This executable file type is not accepted."),
        { statusCode: 415 },
      );
    if (!allowedUploadExtensions.has(ext))
      throw Object.assign(
        new Error(`Unsupported upload extension: ${ext || "(none)"}.`),
        { statusCode: 415 },
      );
    const folder = resolve(workspacePath(id), "uploads");
    await mkdir(folder, { recursive: true });
    const path = resolve(folder, `${Date.now()}-${basename(original)}`);
    const data = await part.toBuffer();
    totalBytes += data.length;
    if (totalBytes > 200 * 1024 * 1024)
      throw Object.assign(
        new Error("Combined uploads exceed the 200 MB per-message limit."),
        { statusCode: 413 },
      );
    if (!uploadContentMatches(ext, data))
      throw Object.assign(
        new Error(
          `The uploaded file's content does not match its claimed ${ext} type.`,
        ),
        { statusCode: 415 },
      );
    await writeFile(path, data, { flag: "wx" });
    saved.push({
      name: original,
      path: `uploads/${basename(path)}`,
      mime: part.mimetype,
      size: data.length,
    });
    publish(id, "file_changed", {
      path: `uploads/${basename(path)}`,
      action: "created",
      bytes: data.length,
    });
  }
  return { files: saved };
});
app.post("/api/sessions/:id/upload/chunk", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  await assertSessionWorkspaceUnlocked(id);
  const root = workspacePath(id);
  const staging = resolve(root, ".galaxy-uploads");
  await mkdir(staging, { recursive: true });
  let uploadId = "";
  let fileName = "";
  let chunkIndex = -1;
  let totalChunks = 0;
  let data: Buffer | null = null;
  for await (const part of request.files()) {
    const fields = part.fields as Record<string, { value?: unknown }>;
    uploadId = String(fields.uploadId?.value ?? "");
    fileName = String(fields.fileName?.value ?? part.filename ?? "upload.bin");
    chunkIndex = Number(fields.chunkIndex?.value ?? 0);
    totalChunks = Number(fields.totalChunks?.value ?? 1);
    data = await part.toBuffer();
  }
  if (
    !/^[a-zA-Z0-9-]{8,80}$/.test(uploadId) ||
    !data ||
    totalChunks < 1 ||
    totalChunks > 200 ||
    chunkIndex < 0 ||
    chunkIndex >= totalChunks
  )
    throw Object.assign(new Error("Invalid chunked upload metadata."), {
      statusCode: 400,
    });
  const cleanName = fileName
    .replace(/[\\/\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 255);
  const ext = extname(cleanName).toLowerCase();
  if (blockedUploadExtensions.has(ext) || !allowedUploadExtensions.has(ext))
    throw Object.assign(
      new Error(`Uploads of ${ext || "this type"} are not allowed.`),
      { statusCode: 415 },
    );
  const partPath = resolve(staging, `${uploadId}.part`);
  if (chunkIndex === 0) await writeFile(partPath, data);
  else {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(partPath, data);
  }
  if (chunkIndex < totalChunks - 1)
    return { ok: true, received: chunkIndex + 1, totalChunks, complete: false };
  const assembled = await readFile(partPath);
  if (assembled.length > 25 * 1024 * 1024) {
    await unlink(partPath).catch(() => {});
    throw Object.assign(
      new Error("Assembled upload exceeds the 25 MB per-file limit."),
      {
        statusCode: 413,
      },
    );
  }
  if (!uploadContentMatches(ext, assembled)) {
    await unlink(partPath).catch(() => {});
    throw Object.assign(
      new Error("File content does not match its extension."),
      { statusCode: 415 },
    );
  }
  const target = safePath(root, cleanName);
  await assertConfined(root, target, true);
  await writeFile(target, assembled);
  await unlink(partPath).catch(() => {});
  publish(id, "file_changed", {
    path: cleanName,
    action: "uploaded",
    bytes: assembled.length,
  });
  return {
    ok: true,
    received: totalChunks,
    totalChunks,
    complete: true,
    files: [{ name: cleanName, path: cleanName, size: assembled.length }],
  };
});
app.get("/api/sessions/:id/artifacts", async (request) => {
  const { id } = request.params as { id: string };
  sessionOr404(id);
  return db
    .prepare(
      "SELECT * FROM artifacts WHERE session_id=? ORDER BY created_at DESC",
    )
    .all(id);
});
app.get("/api/diagnostics", async () => ({
  node: process.version,
  platform: process.platform,
  dataDir: config.dataDir,
  database: (
    db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check,
  providers: getProviders().map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.length,
    lastFetched: p.models_fetched_at,
  })),
  storage: (
    db.prepare("SELECT COUNT(*) AS sessions FROM sessions").get() as {
      sessions: number;
    }
  ).sessions,
}));
function mimeType(ext: string) {
  return (
    (
      {
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".opus": "audio/ogg",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
      } as Record<string, string>
    )[ext.toLowerCase()] ?? "application/octet-stream"
  );
}

const builtWeb = resolve(process.cwd(), "web-dist");
if (existsSync(builtWeb)) {
  await app.register(fastifyStatic, {
    root: builtWeb,
    prefix: "/",
    setHeaders: (res, path) => {
      // index.html must never be cached: a stale copy pins the browser to
      // an old JS bundle even after the server is rebuilt (hashed assets
      // themselves are safe to cache aggressively).
      if (path.endsWith("index.html")) res.header("Cache-Control", "no-store");
    },
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply.code(404).send({ error: "Route not found." });
    return reply.sendFile("index.html");
  });
}
const shutdown = async () => {
  stopAllPreviews();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ host: config.host, port: config.port });
app.log.info(
  { port: config.port, dataDir: config.dataDir },
  "local agent server ready",
);
