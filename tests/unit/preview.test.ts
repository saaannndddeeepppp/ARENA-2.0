import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { createSession, db } from "../../server/src/db.js";
import {
  getPreview,
  startPreview,
  stopPreview,
} from "../../server/src/preview.js";

const sessions: string[] = [];
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to find a free port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function sessionId() {
  const s = createSession("preview-test");
  sessions.push(s.id);
  return s.id;
}
afterEach(() => {
  for (const id of sessions.splice(0)) {
    stopPreview(id);
    db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
});

describe("local preview manager", () => {
  it("starts a real HTTP server on loopback and reports readiness", async () => {
    const id = sessionId();
    const port = await freePort();
    const command = `node -e 'require("http").createServer((q,r)=>r.end("preview-ok")).listen(${port},"127.0.0.1")'`;
    const preview = await startPreview(id, command, port, 8000);
    expect(preview.state).toBe("ready");
    expect(preview.url).toBe(`http://127.0.0.1:${port}/`);
    const response = await fetch(preview.url);
    expect(await response.text()).toBe("preview-ok");
    expect(getPreview(id, port)?.state).toBe("ready");
    expect(stopPreview(id, port).stopped).toBe(1);
  });
  it("rejects port zero and out-of-range ports", async () => {
    const id = sessionId();
    await expect(startPreview(id, "true", 0)).rejects.toThrow(/port/);
    await expect(startPreview(id, "true", 65536)).rejects.toThrow(/port/);
  });
  it("fails clearly when a process never opens its requested port", async () => {
    const id = sessionId();
    const port = await freePort();
    await expect(
      startPreview(id, "node -e 'setTimeout(()=>{},8000)'", port, 1200),
    ).rejects.toThrow(/No HTTP server became ready/);
    expect(getPreview(id, port)?.state).toBe("error");
    stopPreview(id, port);
  });
});
