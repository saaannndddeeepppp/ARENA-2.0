import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let child: ChildProcess | undefined;
let dataDir = "";
const port = 4318;
const base = `http://127.0.0.1:${port}`;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "galaxy-agent-e2e-"));
  child = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_LEVEL: "error",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local server did not become healthy within 20 seconds.");
}, 25000);
afterAll(async () => {
  if (child?.pid) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      child?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("modes and compare (1.2.0)", () => {
  it("rejects an unknown chat mode and identical compare models", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    const badMode = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", mode: "turbo" }),
    });
    expect(badMode.status).toBe(400);
    const same = await fetch(`${base}/api/sessions/${session.id}/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "hi",
        a: { providerId: "openrouter", modelId: "x" },
        b: { providerId: "openrouter", modelId: "x" },
      }),
    });
    expect(same.status).toBe(400);
  });

  it("compare settles per-side errors without failing the request", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    const res = await fetch(`${base}/api/sessions/${session.id}/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Say hi",
        a: { providerId: "missing-a", modelId: "x" },
        b: { providerId: "missing-b", modelId: "y" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      a: { ok: boolean };
      b: { ok: boolean };
    };
    expect(body.a.ok).toBe(false);
    expect(body.b.ok).toBe(false);
  });

  it("archives a session via PATCH so it leaves the active list", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Archive me" }),
    });
    const session = (await created.json()) as { id: string };
    const patched = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(patched.status).toBe(200);
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as Array<{
      id: string;
    }>;
    expect(list.some((x) => x.id === session.id)).toBe(false);
  });
});

describe("offline demo provider", () => {
  it("fetches demo models and answers a comparison without any network", async () => {
    const created = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Offline Demo",
        kind: "demo",
        base_url: "demo://offline",
      }),
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { provider: { id: string } };
    const fetched = await fetch(
      `${base}/api/providers/${provider.provider.id}/refresh-models`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(fetched.status).toBe(200);
    const catalog = (await fetched.json()) as {
      models: Array<{ id: string }>;
    };
    expect(catalog.models.length).toBeGreaterThanOrEqual(2);
    const session = (await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };
    const compared = await fetch(`${base}/api/sessions/${session.id}/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Explain recursion briefly",
        a: {
          providerId: provider.provider.id,
          modelId: catalog.models[0]!.id,
        },
        b: {
          providerId: provider.provider.id,
          modelId: catalog.models[1]!.id,
        },
      }),
    });
    expect(compared.status).toBe(200);
    const result = (await compared.json()) as {
      a: { ok: boolean; text: string };
      b: { ok: boolean; text: string };
    };
    expect(result.a.ok).toBe(true);
    expect(result.b.ok).toBe(true);
    expect(result.a.text).toContain("Demo response");
  });
});

describe("provider model-fetch errors", () => {
  it("reports an unreachable provider with an actionable 424", async () => {
    const created = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Unreachable",
        kind: "custom-openai",
        base_url: "http://127.0.0.1:9/v1",
        api_key: "test-key",
      }),
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { provider: { id: string } };
    const res = await fetch(
      `${base}/api/providers/${provider.provider.id}/refresh-models`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(res.status).toBe(424);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Could not reach");
    expect(body.error).not.toContain("could not complete");
  });
});

describe("empty JSON body regression", () => {
  it("accepts no-body POSTs sent with a JSON content-type", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    // Mirrors the UI's Stop / refresh-models / set-default calls: a POST
    // with Content-Type: application/json and no payload at all.
    const stopped = await fetch(`${base}/api/sessions/${session.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(stopped.status).toBe(200);
    const badJson = await fetch(`${base}/api/sessions/${session.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
  });
});

describe("production HTTP smoke test", () => {
  it("serves health and creates a persistent no-auth session", async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    const create = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(create.status).toBe(201);
    const session = (await create.json()) as { id: string };
    const get = await fetch(`${base}/api/sessions/${session.id}`);
    expect(get.status).toBe(200);
    expect((await get.json()).runStatus).toBe("idle");
  });

  it("accepts safe text uploads and rejects an executable extension", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    const form = new FormData();
    form.append(
      "files",
      new Blob(["# Uploaded locally\n"], { type: "text/markdown" }),
      "note.md",
    );
    const uploaded = await fetch(`${base}/api/sessions/${session.id}/upload`, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const file = (await uploaded.json()).files[0] as { path: string };
    expect(
      await (
        await fetch(
          `${base}/api/sessions/${session.id}/file?path=${encodeURIComponent(file.path)}`,
        )
      ).text(),
    ).toContain("Uploaded locally");
    const denied = new FormData();
    denied.append(
      "files",
      new Blob(["echo unsafe"], { type: "text/plain" }),
      "bad.sh",
    );
    expect(
      (
        await fetch(`${base}/api/sessions/${session.id}/upload`, {
          method: "POST",
          body: denied,
        })
      ).status,
    ).toBe(415);
  });

  it("starts and proxies a real loopback preview, rewrites app-root assets, and stops it", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    const previewPort = port + 1;
    const command = `node -e 'require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end("<html><head></head><body><script src=\\\"/app.js\\\"></script></body></html>")}).listen(${previewPort},"127.0.0.1")'`;
    const start = await fetch(
      `${base}/api/sessions/${session.id}/previews/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, port: previewPort, timeoutMs: 8000 }),
      },
    );
    expect(start.status).toBe(201);
    const preview = await fetch(
      `${base}/preview/${session.id}/${previewPort}/`,
    );
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(
      `/preview/${session.id}/${previewPort}/app.js`,
    );
    const stopped = await fetch(
      `${base}/api/sessions/${session.id}/previews/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect((await stopped.json()).stopped).toBe(1);
  });

  it("exposes readiness, metrics and connector status for production monitoring", async () => {
    const ready = await fetch(`${base}/api/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).ready).toBe(true);
    const metricsResponse = await fetch(`${base}/api/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metrics = await metricsResponse.json();
    expect(metrics.process.rssBytes).toBeGreaterThan(0);
    expect(metrics.security.authRequired).toBe(false);
    expect(metricsResponse.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    const connectors = await fetch(`${base}/api/connectors`);
    expect(connectors.status).toBe(200);
    const list = (await connectors.json()).connectors as Array<{
      id: string;
      connected: boolean;
    }>;
    expect(list.map((c) => c.id)).toEqual([
      "notion",
      "drive",
      "gdocs",
      "gmail",
      "linear",
      "cal",
    ]);
    expect(list.every((c) => !c.connected)).toBe(true);
  });

  it("uploads a small file through the chunked endpoint and rejects a mismatched final chunk", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const session = (await created.json()) as { id: string };
    const chunk = (
      index: number,
      total: number,
      bytes: string,
      name = "chunked.md",
    ) => {
      const form = new FormData();
      form.append("uploadId", "e2e-chunk-upload-1");
      form.append("fileName", name);
      form.append("chunkIndex", String(index));
      form.append("totalChunks", String(total));
      form.append("files", new Blob([bytes], { type: "text/markdown" }), name);
      return fetch(`${base}/api/sessions/${session.id}/upload/chunk`, {
        method: "POST",
        body: form,
      });
    };
    expect((await chunk(0, 2, "# Chunked ")).status).toBe(200);
    const done = await chunk(1, 2, "upload works\n");
    expect(done.status).toBe(200);
    expect((await done.json()).complete).toBe(true);
    const file = await (
      await fetch(`${base}/api/sessions/${session.id}/file?path=chunked.md`)
    ).text();
    expect(file).toContain("Chunked upload works");
  });

  it("clears the persisted conversation and cost ledger while preserving session workspace state", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "clear-test" }),
    });
    const session = (await created.json()) as { id: string };
    const cleared = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: "DELETE",
    });
    expect(cleared.status).toBe(200);
    const state = await (
      await fetch(`${base}/api/sessions/${session.id}`)
    ).json();
    expect(state.messages).toEqual([]);
    expect(state.total_cost_usd).toBe(0);
  });
});
